/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import Bluebird from "bluebird"
import { flatten, uniq } from "lodash"
import { merge } from "json-merge-patch"
import { join } from "path"
import { ensureDir, readFile } from "fs-extra"
import { FilesystemError } from "@garden-io/sdk/exceptions"
import { dumpYaml } from "@garden-io/core/build/src/util/util"
import { DeepPrimitiveMap } from "@garden-io/core/build/src/config/common"
import { loadAndValidateYaml, loadVarfile } from "@garden-io/core/build/src/config/base"
import { getPluginOutputsPath } from "@garden-io/sdk"
import { LogEntry, PluginContext } from "@garden-io/sdk/types"
import { defaultPulumiEnv, pulumi } from "./cli"
import { PulumiModule, PulumiProvider } from "./config"
import chalk from "chalk"

export interface PulumiParams {
  ctx: PluginContext
  log: LogEntry
  provider: PulumiProvider
  module: PulumiModule
}

export interface PulumiConfig {
  config: DeepPrimitiveMap
}

export interface PulumiPlan {
  manifest: {
    time: string
    magic: string
    version: string
  }

  // The stack config used by pulumi when generating the plan
  config: DeepPrimitiveMap

  // Represents the desired state and planned operations to perform (along with other fields).
  //
  // See: https://github.com/pulumi/pulumi/blob/c721e8905b0639b3d4aa1d51d0753f6c99b13984/sdk/go/common/apitype/plan.go#L61-L68
  resourcePlans: {
    [resourceUrn: string]: {
      // The goal state for the resource
      goal: DeepPrimitiveMap
      // The steps to be performed on the resource.
      steps: string[] // When the plan is 
      // The proposed outputs for the resource, if any. Purely advisory.
      outputs: DeepPrimitiveMap
    }
  }
}

type StackStatus = "up-to-date" | "outdated" | "error"

/**
 * Merges any values in the module's `mergeConfig` with the pulumi stack config, then uses `pulumi preview` to generate
 * a plan (using the merged config).
 *
 * If the plan only contains `"same"` steps (i.e. no-op steps), we return `"up-to-date"` (and `"outdated"` otherwise).
 *
 * If `logPreview = true`, logs the output of `pulumi preview`.
 */
export async function getStackStatus(params: PulumiParams & { logPreview: boolean, previewDirPath?: string }): Promise<StackStatus> {
  const { log, ctx, provider, module, logPreview, previewDirPath } = params

  const configPath = await applyConfig({ ...params, previewDirPath })
  const planPath = previewDirPath
    // Then we're running `garden plugins pulumi preview`, so we write the plan to the preview dir regardless of
    // whether the module is configured to deploy from a preview or not.
    ? join(previewDirPath, getPlanFileName(module, ctx.environmentName))
    // Then we use the cache dir or preview dir, depending on the provider and module configuration.
    : getPlanPath(ctx, module)
  const res = await pulumi(ctx, provider).exec({
    log,
    // We write the plan to the `.garden` directory for subsequent use by the deploy handler.
    args: ["preview", "--color", "always", "--config-file", configPath, "--save-plan", planPath],
    cwd: getModuleStackRoot(module),
    env: defaultPulumiEnv,
  })
  if (logPreview) {
    log.info(res.stdout)
  } else {
    log.verbose(res.stdout)
  }
  return getStackStatusFromPlanPath(module, planPath)
}

export async function getStackOutputs({ log, ctx, provider, module }: PulumiParams): Promise<any> {
  const res = await pulumi(ctx, provider).json({
    log,
    args: ["stack", "output", "--json"],
    env: defaultPulumiEnv,
    cwd: getModuleStackRoot(module)
  })
  log.debug(`stack outputs for ${module.name}: ${JSON.stringify(res, null, 2)}`)

  return res
}

export function getStackName(module: PulumiModule): string {
  return module.spec.stack || module.name
}

export function getModuleStackRoot(module: PulumiModule): string {
  return join(module.path, module.spec.root)
}

// Helpers that use/manage the `.garden/pulumi.outputs` directory (resolved by `getPluginOutputsPath`).
//
// When values from `mergeConfig` are applied to stack config, the resulting merged config for the module is written
// into the `.garden/pulumi/cache` directory (or `.garden/pulumi/last-preview`, when running
// `garden plugins pulumi preview` to pre-generate plans and configs for use with the `deployPreview: true` option).
// These files are then passed to the relevant pulumi CLI commands.

/**
 * Merges any values in the module's `pulumiVariables` (and from any `pulumiVarfiles`) with the
 * pulumi stack config and writes the merged config to the preview or cache directory as appropriate.
 *
 * This merged config can then be passed to e.g. `pulumi preview`.
 * 
 * For convenience, returns the path to the merged config file.
 */
export async function applyConfig(params: PulumiParams & { previewDirPath?: string }): Promise<string> {
  const { ctx, module, log, previewDirPath } = params
  await ensureOutputDirs(ctx)
  const mergedPath = previewDirPath
    ? join(previewDirPath, getMergedConfigFileName(module, ctx.environmentName))
    : getMergedConfigFilePath(ctx, module)
  const stackName = module.spec.stack || module.name
  const stackConfigPath =join(getModuleStackRoot(module), `Pulumi.${stackName}.yaml`)
  let fileData: Buffer
  try {
    fileData = await readFile(stackConfigPath)
  } catch (err) {
    const errMsg = `Could not find pulumi stack configuration file for module ${module.name} at ${stackConfigPath}`
    throw new FilesystemError(errMsg, {
      stackConfigPath,
      moduleName: module.name
    })
  }
  const stackConfig: PulumiConfig = (await loadAndValidateYaml(fileData.toString(), stackConfigPath))[0]
  const pulumiVars = module.spec.pulumiVariables
  let varfileContents: DeepPrimitiveMap[]
  try {
    varfileContents = await Bluebird.map(module.spec.pulumiVarfiles, async (varfilePath: string) => {
      return loadVarfile({
        configRoot: module.path, 
        path: varfilePath, 
        defaultPath: undefined
      })
    })
  } catch (err) {
    throw new FilesystemError(`An error occurred while reading pulumi varfiles for module ${module.name}: ${err.message}`, {
      pulumiVarfiles: module.spec.pulumiVarfiles,
      moduleName: module.name
    })
  }


  log.debug(`merging config for module ${module.name}`)
  log.debug(`stack config from ${stackConfigPath}: ${JSON.stringify(stackConfig, null, 2)}`)
  log.debug(`pulumiVariables from module: ${JSON.stringify(pulumiVars, null, 2)}`)
  log.debug(`varfileContents: ${JSON.stringify(varfileContents, null, 2)}`)

  let vars = pulumiVars
  // Pulumi varfiles take precedence over module.spec.pulumiVariables, and are merged in declaration order.
  for (const varfileVars of varfileContents) {
    vars = <DeepPrimitiveMap>merge(vars, varfileVars)
  }
  log.debug(`merged vars: ${JSON.stringify(vars, null, 2)}`)
  const mergedConfig: PulumiConfig = {
    config: <DeepPrimitiveMap>merge(stackConfig.config, vars)
  }

  log.debug(`merged config (written to ${mergedPath}): ${JSON.stringify(mergedConfig, null, 2)}`)

  await dumpYaml(mergedPath, mergedConfig)

  return mergedPath
}

export async function getStackStatusFromPlanPath(module: PulumiModule, planPath: string): Promise<StackStatus> {
  let plan: PulumiPlan
  try {
    plan = JSON.parse((await readFile(planPath)).toString()) as PulumiPlan
  } catch (err) {
    const errMsg = `An error occurred while reading a pulumi plan file at ${planPath}: ${err.message}`
    throw new FilesystemError(errMsg, {
      planPath,
      moduleName: module.name,
    })
  }

  // If all steps across all resource plans are of the "same" type, then the plan indicates that the
  // stack doesn't need to be updated (so we don't need to redeploy).
  const stepTypes = uniq(flatten(Object.values(plan.resourcePlans).map((p) => p.steps)))

  return stepTypes.length === 1 && stepTypes[0] === "same" ? "up-to-date" : "outdated"
}

// Helpers for plugin commands

/**
 * Wrapper for `pulumi cancel --yes`. Does not throw on error, since we may also want to cancel other updates upstream.
 */
export async function cancelUpdate({ module, ctx, provider, log }: PulumiParams): Promise<void> {
  await selectStack({ module, ctx, provider, log })
  const res = await pulumi(ctx, provider).exec({
    log,
    ignoreError: true,
    args: ["cancel", "--yes",  "--color", "always"],
    env: defaultPulumiEnv,
    cwd: getModuleStackRoot(module)
  })
  log.info(res.stdout)

  if (res.exitCode !== 0) {
    log.warn(chalk.yellow(`pulumi cancel failed:\n${res.stderr}`))
  }
}

/**
 * Wrapper for `pulumi refresh --yes`.
 */
export async function refreshResources(params: PulumiParams): Promise<void> {
  const { module, ctx, provider, log } = params
  await selectStack(params)
  const configPath = await applyConfig(params)

  const res = await pulumi(ctx, provider).exec({
    log,
    ignoreError: false,
    args: ["refresh", "--yes",  "--color", "always", "--config-file", configPath],
    env: defaultPulumiEnv,
    cwd: getModuleStackRoot(module)
  })
  log.info(res.stdout)
}

/**
 * Wrapper for `pulumi stack export|pulumi stack import`.
 */
export async function reimportStack(params: PulumiParams): Promise<void> {
  const { module, ctx, provider, log } = params
  await selectStack(params)
  const cwd = getModuleStackRoot(module)

  const cli = pulumi(ctx, provider)
  const exportRes = await cli.exec({
    log,
    ignoreError: false,
    args: ["stack", "export"],
    env: defaultPulumiEnv,
    cwd, 
  })
  await cli.exec({
    log,
    ignoreError: false,
    args: ["stack", "import"],
    input: exportRes.stdout,
    env: defaultPulumiEnv,
    cwd, 
  })
}

// Lower-level helpers

export async function selectStack({ module, ctx, provider, log }: PulumiParams) {
  const root = getModuleStackRoot(module)
  const stackName = getStackName(module)
  const args = ["stack", "select", stackName]
  module.spec.createStack && args.push("--create")
  await pulumi(ctx, provider).spawnAndWait({ args, cwd: root, log, env: defaultPulumiEnv })
  return stackName
}

export function getPlanPath(ctx: PluginContext, module: PulumiModule): string {
  return join(getPlanDirPath(ctx, module), getPlanFileName(module, ctx.environmentName))
}

/**
 * Returns the path to the module's last merged Pulumi config file (which contains the base Pulumi config file merged
 * with any config values from the module's `mergeConfig` field).
 */
export function getMergedConfigFilePath(ctx: PluginContext, module: PulumiModule): string {
  return join(getPlanDirPath(ctx, module), getMergedConfigFileName(module, ctx.environmentName))
}

/**
 * TODO: Write unit tests for this
 */
export function getPlanDirPath(ctx: PluginContext, module: PulumiModule): string {
  return module.spec.deployFromPreview
    ? getPreviewDirPath(ctx)
    : getCachePath(ctx)
}

function getCachePath(ctx: PluginContext): string {
  return join(getPluginOutputsPath(ctx, "pulumi"), "cache")
}

export function getPreviewDirPath(ctx: PluginContext) {
  const provider: PulumiProvider = <PulumiProvider>ctx.provider
  return provider.config.previewDir
    ? join(ctx.projectRoot, provider.config.previewDir)
    : getDefaultPreviewDirPath(ctx)
}

function getDefaultPreviewDirPath(ctx: PluginContext): string {
  return join(getPluginOutputsPath(ctx, "pulumi"), "last-preview")
}

export function getPlanFileName(module: PulumiModule, environmentName: string): string {
  return `${module.name}.${environmentName}.plan.json`
}

function getMergedConfigFileName(module: PulumiModule, environmentName: string): string {
  return `${module.name}.${environmentName}.merged.yaml`
}

async function ensureOutputDirs(ctx: PluginContext) {
  await ensureDir(getCachePath(ctx))
  await ensureDir(getDefaultPreviewDirPath(ctx))
}

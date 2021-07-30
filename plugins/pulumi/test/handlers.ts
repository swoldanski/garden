/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { ConfigGraph, LogEntry, PluginContext } from "@garden-io/sdk/types"
import { makeTestGarden, TestGarden } from "@garden-io/sdk/testing"
import execa from "execa"
import { pathExists } from "fs-extra"
import { join, resolve } from "path"
import { getPulumiServiceStatus } from "../handlers"
import { PulumiModule, PulumiProvider } from "../config"
import { gardenPlugin as pulumiPlugin } from ".."
import { GardenService, ServiceStatus } from "@garden-io/core/build/src/types/service"
import { emptyRuntimeContext } from "@garden-io/core/build/src/runtime-context"
import { expect } from "chai"

const projectRoot = resolve(__dirname, "..", "..", "test", "test-project-k8s")

const moduleRoot = join(projectRoot, "k8s-deployment")

// Here, pulumi needs node modules to be installed (to use the TS SDK in the pulumi program).
const ensureNodeModules = async () => {
  if (await pathExists(join(moduleRoot, "node_modules"))) {
    return
  }
  await execa.command("yarn", { cwd: moduleRoot })
}

// TODO: Write + finish unit and integ tests
describe.skip("pulumi plugin handlers", () => {
  let garden: TestGarden
  let graph: ConfigGraph
  let log: LogEntry
  let ctx: PluginContext
  let provider: PulumiProvider
  let module: PulumiModule
  let service: GardenService

  before(async () => {
    console.log(`projectRoot: ${projectRoot}`)
    garden = await makeTestGarden(projectRoot, { plugins: [pulumiPlugin()] })
    log = garden.log
    provider = (await garden.resolveProvider(log, "pulumi")) as PulumiProvider
    ctx = await garden.getPluginContext(provider)
    graph = await garden.getConfigGraph({ log, emit: false })
    module = graph.getModule("k8s-deployment")
    service = graph.getService("k8s-deployment")
    await ensureNodeModules()
  })

  describe("getPulumiServiceStatus", () => {
    let status: ServiceStatus
    before(async () => {
    })

    it("should return an 'outdated' state when the stack hasn't been deployed before", async () => {
      status = await getPulumiServiceStatus({
        ctx,
        log,
        module,
        service,
        devMode: false,
        hotReload: false,
        runtimeContext: emptyRuntimeContext
      })
      expect(status.state).to.eql("outdated")
    })

    it("should return a 'ready' state when pulumi preview indicates that no changes need to be made", async () => {
      throw "TODO"
    })

    // TODO: More tests
  })
})

/*
 * Copyright (C) 2018-2021 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import WebSocket from "ws"
import Bluebird from "bluebird"
import deline = require("deline")
import dedent = require("dedent")
import chalk from "chalk"
import { readFile } from "fs-extra"
import { flatten, isEmpty, omit } from "lodash"
import moment = require("moment")
import { join } from "path"

import { getModuleWatchTasks } from "../tasks/helpers"
import {
  Command,
  CommandResult,
  CommandParams,
  handleProcessResults,
  PrepareParams,
  SessionSettings,
  prepareSessionSettings,
} from "./base"
import { STATIC_DIR } from "../constants"
import { processModules } from "../process"
import { GardenModule } from "../types/module"
import { getTestTasks } from "../tasks/test"
import { ConfigGraph } from "../config-graph"
import {
  getDevModeModules,
  getDevModeServiceNames,
  getHotReloadServiceNames,
  validateHotReloadServiceNames,
} from "./helpers"
import { startServer } from "../server/server"
import { BuildTask } from "../tasks/build"
import { DeployTask } from "../tasks/deploy"
import { Garden } from "../garden"
import { LogEntry } from "../logger/log-entry"
import { StringsParameter, BooleanParameter } from "../cli/params"
import { printHeader } from "../logger/util"
import { GardenService } from "../types/service"
import { Stream } from "ts-stream"
import { ServiceLogEntry } from "../types/plugin/service/getServiceLogs"
import { ActionRouter } from "../actions"
import { PluginEventBroker } from "../plugin-context"
import { skipEntry } from "./logs"
import { EventBus } from "../events"

const ansiBannerPath = join(STATIC_DIR, "garden-banner-2.txt")

const devArgs = {
  services: new StringsParameter({
    help: `Specify which services to develop (defaults to all configured services).`,
  }),
}

const devOpts = {
  "force": new BooleanParameter({ help: "Force redeploy of service(s)." }),
  "hot-reload": new StringsParameter({
    help: deline`The name(s) of the service(s) to deploy with hot reloading enabled.
      Use comma as a separator to specify multiple services. Use * to deploy all
      services with hot reloading enabled (ignores services belonging to modules that
      don't support or haven't configured hot reloading).
    `,
    alias: "hot",
  }),
  "skip-tests": new BooleanParameter({
    help: "Disable running the tests.",
  }),
  "test-names": new StringsParameter({
    help:
      "Filter the tests to run by test name across all modules (leave unset to run all tests). " +
      "Accepts glob patterns (e.g. integ* would run both 'integ' and 'integration').",
    alias: "tn",
  }),
}

export type DevCommandArgs = typeof devArgs
export type DevCommandOpts = typeof devOpts

// TODO: allow limiting to certain modules and/or services
export class DevCommand extends Command<DevCommandArgs, DevCommandOpts> {
  name = "dev"
  help = "Starts the garden development console."
  protected = true

  // Currently it doesn't make sense to do file watching except in the CLI
  cliOnly = true

  streamEvents = true

  description = dedent`
    The Garden dev console is a combination of the \`build\`, \`deploy\` and \`test\` commands.
    It builds, deploys and tests all your modules and services, and re-builds, re-deploys and re-tests
    as you modify the code.

    Examples:

        garden dev
        garden dev --hot=foo-service,bar-service  # enable hot reloading for foo-service and bar-service
        garden dev --hot=*                        # enable hot reloading for all compatible services
        garden dev --skip-tests=                  # skip running any tests
        garden dev --force                        # force redeploy of services when the command starts
        garden dev --name integ                   # run all tests with the name 'integ' in the project
        garden test --name integ*                 # run all tests with the name starting with 'integ' in the project
  `

  arguments = devArgs
  options = devOpts

  private garden?: Garden

  printHeader({ headerLog }) {
    printHeader(headerLog, "Dev", "keyboard")
  }

  async prepare({ log, footerLog, args, opts }: PrepareParams<DevCommandArgs, DevCommandOpts>) {
    // print ANSI banner image
    if (chalk.supportsColor && chalk.supportsColor.level > 2) {
      const data = await readFile(ansiBannerPath)
      log.info(data.toString())
    }

    log.info(chalk.gray.italic(`Good ${getGreetingTime()}! Let's get your environment wired up...`))
    log.info("")

    this.server = await startServer({ log: footerLog })
    const sessionSettings = prepareSessionSettings({
      deployServiceNames: args.services || ["*"],
      testModuleNames: opts["skip-tests"] ? [] : ["*"],
      testConfigNames: opts["test-names"] || ["*"],
      devModeServiceNames: args.services || ["*"],
      hotReloadServiceNames: opts["hot-reload"] || [],
    })

    return { persistent: true, sessionSettings }
  }

  terminate() {
    this.garden?.events.emit("_exit", {})
  }

  async action({
    garden,
    log,
    footerLog,
    sessionSettings,
  }: CommandParams<DevCommandArgs, DevCommandOpts>): Promise<CommandResult> {
    this.garden = garden
    this.server?.setGarden(garden)

    const settings = <SessionSettings>sessionSettings

    if (sessionSettings) {
      garden.events.emit("sessionSettings", sessionSettings)
    }

    const graph = await garden.getConfigGraph({ log, emit: true })
    const modules = graph.getModules()

    if (modules.length === 0) {
      footerLog && footerLog.setState({ msg: "" })
      log.info({ msg: "No enabled modules found in project." })
      log.info({ msg: "Aborting..." })
      return {}
    }

    const hotReloadServiceNames = getHotReloadServiceNames(settings.hotReloadServiceNames, graph)
    if (hotReloadServiceNames.length > 0) {
      const errMsg = validateHotReloadServiceNames(hotReloadServiceNames, graph)
      if (errMsg) {
        log.error({ msg: errMsg })
        return { result: {} }
      }
    }

    const initialTasks = await getDevCommandInitialTasks({
      garden,
      log,
      graph,
      sessionSettings: settings,
    })

    const ws = await wsConnect(garden)

    if (ws) {
      const actions = await garden.getActionRouter()
      startLogStream({ ws, graph, log, actions })
        .then(() => {
          log.silly(`Started log stream`)
        })
        .catch((err) => log.error(`Streaming logs failed with error: ${err}`))
    }

    const results = await processModules({
      garden,
      graph,
      log,
      footerLog,
      modules,
      watch: true,
      initialTasks,
      skipWatchModules: getDevModeModules(getDevModeServiceNames(settings.devModeServiceNames, graph), graph),
      sessionSettings: settings,
      changeHandler: async (updatedGraph: ConfigGraph, module: GardenModule) => {
        return getDevCommandWatchTasks({
          garden,
          log,
          updatedGraph,
          module,
          sessionSettings: settings,
        })
      },
    })

    return handleProcessResults(footerLog, "dev", results)
  }
}

const maxWsRetries = 3

function registerWsHandlers(ws: WebSocket, log: LogEntry, events: EventBus) {
  const validEvents = ["deployRequested", "buildRequested", "testRequested"]
  ws.on("open", () => {
    // console.log("ws open")
  })
  ws.on("upgrade", () => {
    // console.log("ws upgraded")
  })
  ws.on("ping", () => {
    ws && ws.pong()
  })
  ws.on("error", (err) => {
    log.debug(`Websocket error: ${err.message}`)
  })
  ws.on("message", (msg) => {
    const parsed = JSON.parse(msg.toString())
    if (validEvents.includes(parsed.event)) {
      const payload = omit(parsed, "event")
      events.emit(parsed.event, payload)
    }
  })
}

async function startLogStream({
  ws,
  graph,
  log,
  actions,
}: {
  ws: WebSocket
  graph: ConfigGraph
  log: LogEntry
  actions: ActionRouter
}) {
  const services = graph.getServices()
  const stream = new Stream<ServiceLogEntry>()
  const events = new PluginEventBroker()

  void stream.forEach((entry) => {
    // Skip empty entries
    if (skipEntry(entry)) {
      return
    }

    ws.readyState === 1 &&
      ws.send(
        JSON.stringify({
          type: "serviceLog",
          name: "serviceLog",
          message: entry.msg,
          serviceName: entry.serviceName,
          timestamp: entry.timestamp?.getTime(),
        })
      )
  })

  await Bluebird.map(services, async (service: GardenService<any>) => {
    await actions.getServiceLogs({
      log,
      graph,
      service,
      stream,
      follow: true,
      since: "10s",
      events,
    })
  })
}

async function wsConnect(garden: Garden) {
  if (!garden.enterpriseApi) {
    return null
  }

  // Setup websocket connection with retries
  let retries = 1
  let ws = await garden.enterpriseApi.wsConnect(garden.sessionId)

  registerWsHandlers(ws, garden.log, garden.events)

  const onClose = async () => {
    const msg = `Websocket connection closed.`
    if (retries <= maxWsRetries) {
      garden.log.info(`${msg}. Attempting to reconnect ${retries}/${maxWsRetries}`)

      ws = await garden.enterpriseApi!.wsConnect(garden.sessionId)

      registerWsHandlers(ws, garden.log, garden.events)
      ws.on("close", () => onClose())
      retries += 1
    }
  }

  garden.events.onAny((name, payload) => {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: "event", name, ...payload }))
    }
  })

  return ws
}

export async function getDevCommandInitialTasks({
  garden,
  log,
  graph,
  sessionSettings,
}: {
  garden: Garden
  log: LogEntry
  graph: ConfigGraph
  sessionSettings: SessionSettings
}) {
  const { servicesToDeploy, hotReloadServiceNames, devModeServiceNames, testNames } = applySessionSettings(
    graph,
    sessionSettings
  )
  const modules = graph.getModules()

  const moduleTasks = flatten(
    await Bluebird.map(modules, async (module) => {
      // Build the module (in case there are no tests, tasks or services here that need to be run)
      const buildTasks = await BuildTask.factory({
        garden,
        graph,
        log,
        module,
        force: false,
      })

      // Run all tests in module
      const testTasks = moduleShouldBeTested(sessionSettings, module)
        ? await getTestTasks({
            garden,
            graph,
            log,
            module,
            devModeServiceNames,
            hotReloadServiceNames,
            filterNames: testNames,
            force: false,
            forceBuild: false,
          })
        : []

      return [...buildTasks, ...testTasks]
    })
  )

  const serviceTasks = servicesToDeploy
    .filter((s) => !s.disabled)
    .map(
      (service) =>
        new DeployTask({
          garden,
          log,
          graph,
          service,
          force: false,
          forceBuild: false,
          fromWatch: false,
          devModeServiceNames,
          hotReloadServiceNames,
        })
    )

  return [...moduleTasks, ...serviceTasks]
}

export async function getDevCommandWatchTasks({
  garden,
  log,
  updatedGraph,
  module,
  sessionSettings,
}: {
  garden: Garden
  log: LogEntry
  updatedGraph: ConfigGraph
  module: GardenModule
  sessionSettings: SessionSettings
}) {
  const { servicesToDeploy, hotReloadServiceNames, devModeServiceNames, testNames } = applySessionSettings(
    updatedGraph,
    sessionSettings
  )
  const tasks = await getModuleWatchTasks({
    garden,
    log,
    graph: updatedGraph,
    module,
    servicesWatched: servicesToDeploy.map((s) => s.name),
    devModeServiceNames,
    hotReloadServiceNames,
  })

  const testModules: GardenModule[] = updatedGraph.withDependantModules([module])
  tasks.push(
    ...flatten(
      await Bluebird.map(testModules, (m) =>
        moduleShouldBeTested(sessionSettings, m)
          ? getTestTasks({
              garden,
              log,
              module: m,
              graph: updatedGraph,
              filterNames: testNames,
              devModeServiceNames,
              hotReloadServiceNames,
            })
          : []
      )
    )
  )

  return tasks
}

export function applySessionSettings(graph: ConfigGraph, sessionSettings: SessionSettings) {
  const hotReloadServiceNames = getHotReloadServiceNames(sessionSettings.hotReloadServiceNames, graph)

  const serviceNames = sessionSettings.deployServiceNames
  const allServices = graph.getServices()
  const servicesToDeploy = serviceNames[0] === "*" ? allServices : graph.getServices({ names: serviceNames })

  let devModeServiceNames = getDevModeServiceNames(sessionSettings.devModeServiceNames, graph)

  devModeServiceNames = servicesToDeploy
    .map((s) => s.name)
    // Since dev mode is implicit when using this command, we consider explicitly enabling hot reloading to
    // take precedence over dev mode.
    .filter((name) => devModeServiceNames.includes(name) && !hotReloadServiceNames.includes(name))
  const testNames = isEmpty(sessionSettings.testConfigNames) ? undefined : sessionSettings.testConfigNames

  return { servicesToDeploy, hotReloadServiceNames, devModeServiceNames, testNames }
}

function moduleShouldBeTested(sessionSettings: SessionSettings, module: GardenModule): boolean {
  const testModuleNames = sessionSettings.testModuleNames
  return testModuleNames[0] === "*" || !!testModuleNames.find((n) => n === module.name)
}

function getGreetingTime() {
  const m = moment()

  const currentHour = parseFloat(m.format("HH"))

  if (currentHour >= 17) {
    return "evening"
  } else if (currentHour >= 12) {
    return "afternoon"
  } else {
    return "morning"
  }
}

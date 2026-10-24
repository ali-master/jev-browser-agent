#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { Agent } from "./agent";
import { Browser } from "./browser";
import { evaluateSuite } from "./evaluation";
import { SettingsStore } from "./config";
import { startServer } from "./server";
import { formatUsage } from "./usage";
import { AgentReporter, Logger, logUrl } from "./logger";
import type { AgentState } from "./types";

const help = `Jev Browser Agent (Bun)

  jev                         Open the local inspector (default port 8766)
  jev serve --port 8766        Open the inspector on a selected loopback port
  jev run --url URL --goal "Task" [--headed] [--max-steps 60] [--record DIR]
  jev eval --suite cases.json [--label local] [--repeat 3] [--report results.json]

  --log-level info            error | warn | info | debug | trace
  --log-detail normal         low | normal | high
  --color auto                auto | always | never (auto respects NO_COLOR)
  --workflow NAME             Learn/reuse a successful local workflow
  --params JSON               String values for {{name}} goal parameters
  --schema PATH               Extract schema-validated JSON with field citations
  --profile NAME              Restore/save an encrypted local login profile
  --allow-origin ORIGIN       Additional profile origin (repeatable)
  --secrets PATH              Private JSON secret bindings; never sent to models
  --site-data PATH            Initial cookies, localStorage and sessionStorage JSON
  --vision                    Optional canvas fallback using a multimodal chat helper
  --webmcp PATH               JSON permissions: {"allowedTools":{"https://site.example":["search"]}}

  jev login --url URL --profile NAME
    Sign in manually in Chromium, then press Enter in this terminal to save.

Logs go to stderr; the final answer goes to stdout. Debug logs include stage timings.

Configure Base URL, API key and model in the inspector or .env.
Settings are read before each model step. Completion requires page evidence and a goal review.
`;

let logger = new Logger();
try {
  const { positionals, values } = parseArgs({
    args: Bun.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: "boolean", short: "h" },
      url: { type: "string" },
      goal: { type: "string" },
      port: { type: "string" },
      headed: { type: "boolean" },
      "max-steps": { type: "string" },
      record: { type: "string" },
      "log-level": { type: "string" },
      "log-detail": { type: "string" },
      color: { type: "string" },
      workflow: { type: "string" },
      params: { type: "string" },
      schema: { type: "string" },
      profile: { type: "string" },
      "allow-origin": { type: "string", multiple: true },
      secrets: { type: "string" },
      "site-data": { type: "string" },
      vision: { type: "boolean" },
      webmcp: { type: "string" },
      suite: { type: "string" },
      label: { type: "string" },
      repeat: { type: "string" },
      report: { type: "string" },
    },
  });
  const command = positionals[0] ?? "serve";
  logger = new Logger({
    level: values["log-level"],
    detail: values["log-detail"],
    color: values.color,
  });
  if (values.help) console.log(help);
  else if (
    positionals.length > 1 ||
    !["serve", "run", "login", "eval"].includes(command)
  )
    throw new Error(help);
  else if (command === "eval") {
    if (!values.suite) throw new Error("Evaluation needs --suite cases.json.");
    const store = new SettingsStore(),
      controller = new AbortController();
    const cancel = () => controller.abort();
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    try {
      const report = await evaluateSuite(
        await Bun.file(values.suite).json(),
        [{ name: values.label ?? "current", settings: () => store.read() }],
        {
          repeat: values.repeat ? Number(values.repeat) : 1,
          maxSteps: values["max-steps"]
            ? Number(values["max-steps"])
            : undefined,
          signal: controller.signal,
          onProgress: (progress) =>
            logger.log("debug", "Evaluation stage", progress),
          onResult: (result) =>
            logger.log(
              result.passed ? "info" : "warn",
              `${result.case}: ${result.passed ? "passed" : result.failure_stage}`,
              { actions: result.actions, wall_ms: result.wall_ms },
            ),
        },
      );
      const output = JSON.stringify(report, null, 2);
      if (values.report) await Bun.write(values.report, output + "\n");
      console.log(output);
      if (report.cancelled || report.results.some((r) => !r.passed))
        process.exitCode = 1;
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
    }
  } else if (command === "login") {
    if (!values.url || !values.profile)
      throw new Error("Login needs --url and --profile.");
    const browser = await Browser.create(values.url, {
      headless: false,
      profile: {
        name: values.profile,
        origins: [
          new URL(values.url).origin,
          ...(values["allow-origin"] ?? []),
        ],
      },
    });
    const cancel = () => {
      void browser.close(false).finally(() => process.exit(130));
    };
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    let confirmed = false;
    try {
      logger.log(
        "info",
        "Sign in in Chromium, then press Enter here to save. Ctrl+C cancels.",
      );
      for await (const chunk of Bun.stdin.stream())
        if (chunk.includes(10)) {
          confirmed = true;
          break;
        }
    } finally {
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
      await browser.close(confirmed);
    }
    if (!confirmed)
      throw new Error("Login was not confirmed; profile was not saved.");
    logger.log("info", "Encrypted login profile saved.");
  } else if (command === "serve") {
    const port = Number(values.port ?? process.env.PORT ?? 8766);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Port must be between 1 and 65535.");
    let current: AgentState | undefined;
    let reporter: AgentReporter;
    let reported = false;
    const inspector = startServer({
      port,
      cdpUrl: process.env.BROWSER_CDP_URL,
      onUpdate(state) {
        if (state !== current) {
          current = state;
          reporter = new AgentReporter(logger);
          reported = false;
          logger.log(
            "info",
            "Inspector task started",
            { url: logUrl(state.page.url) },
            "low",
          );
        }
        if (reported) return;
        reporter.update(state);
        if (
          !state.activity &&
          ["done", "blocked", "error", "closed"].includes(state.status)
        ) {
          reporter.finish(state);
          reported = true;
        }
      },
    });
    console.log(`Jev Browser Agent: ${inspector.url}`);
    let closing = false;
    const shutdown = async (signal: NodeJS.Signals) => {
      if (closing) process.exit(signal === "SIGINT" ? 130 : 143);
      closing = true;
      logger.log(
        "info",
        "Stopping the server… Press Ctrl+C again to force exit.",
        {},
        "low",
      );
      setTimeout(() => {
        logger.log("error", "Shutdown timed out; exiting.");
        process.exit(1);
      }, 5000).unref();
      try {
        await inspector.close();
        // Bun's watcher stays alive after the listener closes.
        process.exit(0);
      } catch (error) {
        logger.log(
          "error",
          error instanceof Error ? error.message : "Shutdown failed.",
        );
        process.exit(1);
      }
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    if (!values.url || !values.goal)
      throw new Error("Supply --url and --goal. Use --help for examples.");
    const reporter = new AgentReporter(logger);
    logger.log("info", "Opening browser", { url: logUrl(values.url) }, "low");
    const agent = await Agent.create(values.url, values.goal, {
      headless: !values.headed,
      cdpUrl: process.env.BROWSER_CDP_URL,
      recordDir: values.record,
      vision: values.vision,
      webMCP: values.webmcp ? await Bun.file(values.webmcp).json() : undefined,
      profile: values.profile
        ? {
            name: values.profile,
            origins: [
              new URL(values.url).origin,
              ...(values["allow-origin"] ?? []),
            ],
          }
        : undefined,
      secrets: values.secrets
        ? await Bun.file(values.secrets)
            .json()
            .catch(() => {
              throw new Error("Invalid secrets JSON file.");
            })
        : undefined,
      siteData: values["site-data"]
        ? await Bun.file(values["site-data"])
            .json()
            .catch(() => {
              throw new Error("Invalid site data JSON file.");
            })
        : undefined,
      outputSchema: values.schema
        ? await Bun.file(values.schema).json()
        : undefined,
      maxSteps: values["max-steps"] ? Number(values["max-steps"]) : undefined,
      workflow: values.workflow
        ? {
            name: values.workflow,
            parameters: values.params ? JSON.parse(values.params) : {},
          }
        : undefined,
      onUpdate: () => reporter.update(agent.state),
    });
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      logger.log("warn", "Stopping after the current browser step.");
    };
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    try {
      for await (const _state of agent.run()) {
        if (cancelled) break;
      }
      const state = agent.snapshot();
      if (state.output) console.log(JSON.stringify(state.output, null, 2));
      else if (state.answer) console.log(state.answer);
      if (cancelled || state.status !== "done") process.exitCode = 1;
    } finally {
      reporter.finish(agent.state);
      for (const line of formatUsage(agent.snapshot().usage).split("\n"))
        logger.log("debug", line);
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
      await agent.close();
    }
  }
} catch (error) {
  logger.log("error", error instanceof Error ? error.message : "Jev failed.");
  process.exitCode = 1;
}

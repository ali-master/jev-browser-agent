#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { Agent } from "./agent";
import { startServer } from "./server";
import { formatUsage } from "./usage";

const help = `Jev Browser Agent (Bun)

  jev                         Open the local inspector (default port 8766)
  jev serve --port 8766        Open the inspector on a selected loopback port
  jev run --url URL --goal "Task" [--headed] [--max-steps 60] [--record DIR]

Configure Base URL, API key and model in the inspector or .env.
Settings are read before each model step. Completion requires page evidence and a goal review.
`;

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
    },
  });
  const command = positionals[0] ?? "serve";
  if (values.help) console.log(help);
  else if (positionals.length > 1 || !["serve", "run"].includes(command))
    throw new Error(help);
  else if (command === "serve") {
    const port = Number(values.port ?? process.env.PORT ?? 8766);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Port must be between 1 and 65535.");
    const inspector = startServer({
      port,
      cdpUrl: process.env.BROWSER_CDP_URL,
    });
    console.log(`Jev Browser Agent: ${inspector.url}`);
    let closing = false;
    const shutdown = async (signal: NodeJS.Signals) => {
      if (closing) process.exit(signal === "SIGINT" ? 130 : 143);
      closing = true;
      console.log("Stopping the server… Press Ctrl+C again to force exit.");
      setTimeout(() => {
        console.error("Shutdown timed out; exiting.");
        process.exit(1);
      }, 5000).unref();
      try {
        await inspector.close();
        // Bun's watcher stays alive after the listener closes.
        process.exit(0);
      } catch (error) {
        console.error(
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
    const agent = await Agent.create(values.url, values.goal, {
      headless: !values.headed,
      cdpUrl: process.env.BROWSER_CDP_URL,
      recordDir: values.record,
      maxSteps: values["max-steps"] ? Number(values["max-steps"]) : undefined,
    });
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
    };
    process.on("SIGINT", cancel);
    process.on("SIGTERM", cancel);
    try {
      for await (const state of agent.run()) {
        console.log(
          `${state.elapsed_ms} ms | ${state.history.length} actions | ${state.status} | ${state.history.at(-1)?.action ?? ""}`,
        );
        if (cancelled) break;
      }
      const state = agent.snapshot();
      console.log(`Final page: ${state.page.url}`);
      console.log(
        state.status === "done"
          ? "Goal verified against the observed evidence."
          : `Stopped: ${state.status}`,
      );
      if (state.answer) console.log(state.answer);
      if (state.stop_reason) console.error(state.stop_reason.message);
      if (cancelled || state.status !== "done") process.exitCode = 1;
    } finally {
      console.log(formatUsage(agent.snapshot().usage));
      process.off("SIGINT", cancel);
      process.off("SIGTERM", cancel);
      await agent.close();
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Jev failed.");
  process.exitCode = 1;
}

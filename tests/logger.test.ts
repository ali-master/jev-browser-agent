import { expect, test } from "bun:test";
import { Agent } from "../src/agent";
import { AgentReporter, Logger, logUrl } from "../src/logger";
import { page } from "./helpers";

test("log levels and detail are independent; errors survive low detail", () => {
  const output: string[] = [];
  const log = new Logger({
    color: "never",
    level: "debug",
    detail: "low",
    write: (line) => output.push(line),
  });
  log.log("info", "summary", {}, "low");
  log.log("info", "stage");
  log.log("trace", "tokens", {}, "low");
  log.log("error", "failure", {}, "high");
  expect(output).toHaveLength(2);
  expect(output.join("")).toContain("summary");
  expect(output.join("")).toContain("ERROR failure");
  expect(output.join("")).not.toContain("\x1b");
});

test.each([
  ["auto", true, {}, true],
  ["auto", false, {}, false],
  ["auto", true, { NO_COLOR: "" }, false],
  ["auto", false, { FORCE_COLOR: "1" }, true],
  ["auto", true, { FORCE_COLOR: "0" }, false],
  ["auto", true, { TERM: "dumb" }, false],
  ["always", false, { NO_COLOR: "1" }, true],
  ["never", true, { FORCE_COLOR: "1" }, false],
] as const)("color=%s tty=%s env=%j", (color, tty, env, expected) => {
  let output = "";
  new Logger({
    color,
    tty,
    env,
    write: (line) => {
      output += line;
    },
  }).log("warn", "test");
  expect(output.includes("\x1b[")).toBe(expected);
});

test("rejects invalid CLI options and strips terminal control sequences", () => {
  for (const options of [
    { level: "typo" },
    { detail: "typo" },
    { color: "typo" },
    { level: "toString" },
  ])
    expect(() => new Logger(options)).toThrow();
  let output = "";
  new Logger({
    color: "never",
    write: (line) => {
      output += line;
    },
  }).log("info", "\x1b[31mPage\x1b[0m\nforged", {
    target: "\x1b]0;fake title\x07Click\rhere",
  });
  expect(output).not.toContain("\x1b");
  expect(output.trimEnd().split("\n")).toHaveLength(1);
  expect(
    logUrl("https://user:secret@example.com/path?token=private#secret"),
  ).toBe("https://example.com/path");
});

test("reporter emits events once, times stages, and does not log prompts or field values", () => {
  const driver = {
    fresh: async () => true,
    observe: async () => page(),
    act: async () => {},
    close: async () => {},
  };
  const agent = new Agent(driver, page(), "private-goal");
  let time = 0,
    output = "";
  const reporter = new AgentReporter(
    new Logger({
      level: "trace",
      detail: "high",
      color: "never",
      write: (line) => {
        output += line;
      },
    }),
    () => time,
  );
  agent.state.page.url =
    "https://user:private-password@example.com/?secret=private-token";
  agent.state.activity = {
    kind: "writing",
    started_at: 0,
    text: "private-input",
  };
  reporter.update(agent.state);
  time = 75;
  reporter.update(agent.state);
  agent.state.model_calls.push({
    model: "local",
    latency_ms: 70,
    role: "text",
    usage: { prompt_tokens: 20, completion_tokens: 4, secret: "private-key" },
  });
  agent.state.activity = null;
  agent.state.status = "done";
  agent.state.elapsed_ms = 100;
  reporter.finish(agent.state);
  expect(output.match(/writing…/g)).toHaveLength(1);
  expect(output).toContain("writing=75");
  expect(output).toContain("model_ms=70 other_ms=30 requests=1");
  expect(output).toContain("input=20 output=4");
  expect(output).not.toContain("private-");
});

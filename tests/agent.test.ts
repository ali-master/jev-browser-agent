import { afterEach, expect, mock, test } from "bun:test";
import { Agent } from "../src/agent.js";
import { StalePage } from "../src/browser.js";
import { chatResponse, decisionResponse, page, provider } from "./helpers.js";
import type { DecisionRequest, TaskStep } from "../src/types.js";

const servers: Bun.Server<undefined>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

function runner(
  operation = "TYPE_TEXT",
  target = "1",
  maxSteps = 60,
  steps: TaskStep[] = [
    { instruction: "Find hotels in Lisbon", checks: [{ kind: "title", includes: "Completed" }] },
  ],
) {
  let textCalls = 0;
  const transport = provider(async (request) => {
    if (new URL(request.url).pathname.endsWith("chat/completions")) {
      const body = await request.json();
      if (body.messages[0].content.includes("completion checklist")) return chatResponse({ steps });
      textCalls++;
      return chatResponse({ text: "Lisbon" });
    }
    return Response.json(
      decisionResponse((await request.json()) as DecisionRequest, operation, target),
    );
  });
  servers.push(transport.server);
  const state = page();
  const driver = {
    fresh: mock(async () => true),
    observe: mock(async () => structuredClone(state)),
    act: mock(async () => {}),
    close: mock(async () => {}),
  };
  const agent = new Agent(driver, state, "Find hotels in Lisbon", {
    settings: async () => transport.settings,
    maxSteps,
  });
  return { agent, driver, settings: transport.settings, textCalls: () => textCalls };
}

test("consumes a stale decision before any mutation or text request", async () => {
  const { agent, driver, textCalls } = runner();
  await agent.command("predict");
  driver.fresh.mockResolvedValue(false);
  await expect(
    agent.command("act", { fingerprint: agent.state.page.fingerprint }),
  ).rejects.toBeInstanceOf(StalePage);
  expect(driver.act).not.toHaveBeenCalled();
  expect(textCalls()).toBe(0);
  expect(agent.state.decision).toBeNull();
});

test("publishes execution stages without letting viewer failures retry browser actions", async () => {
  const { driver, settings } = runner();
  const phases: (string | null)[] = [];
  const agent = new Agent(driver, page(), "Find hotels in Lisbon", {
    settings: async () => settings,
    onUpdate() {
      phases.push(agent.state.activity?.kind ?? null);
      throw new Error("Viewer disconnected");
    },
  });
  await agent.command("tick");
  expect(phases).toEqual([
    "observing",
    "planning",
    "deciding",
    "writing",
    "acting",
    "observing",
    null,
  ]);
  expect(driver.act).toHaveBeenCalledTimes(1);
  expect(agent.state.activity).toBeNull();
  expect(agent.state.history).toHaveLength(1);
});

test.each(["identical", "page", "provider", "node", "document", "url"])(
  "stale text cache respects entire context and provider: %s",
  async (change) => {
    const { agent, driver, settings, textCalls } = runner();
    driver.act.mockRejectedValueOnce(new StalePage("Changed before input"));
    await agent.command("tick");
    expect(agent.state.history).toHaveLength(0);
    if (change === "page") agent.state.page.text = "A different field context";
    if (change === "provider") settings.text.apiKey = "changed-local-key";
    if (change === "node") Object.assign(agent.state.page.actions[0]!, { node: 90 });
    if (change === "document") agent.state.page.document_id = "new-document";
    if (change === "url") agent.state.page.url = "https://example.test/other";
    await agent.command("tick");
    expect(textCalls()).toBe(change === "identical" ? 1 : 2);
    expect(agent.state.history).toHaveLength(1);
    expect(JSON.stringify(agent.snapshot())).not.toContain("changed-local-key");
  },
);

test("post-action stale observation keeps history and never replays the consumed click", async () => {
  const { agent, driver } = runner("CLICK", "2");
  driver.observe.mockImplementationOnce(async () => {
    expect(agent.state.history).toHaveLength(1);
    throw new StalePage("Document changed after click");
  });
  await agent.command("tick");
  expect(driver.act).toHaveBeenCalledTimes(1);
  expect(agent.state.history[0]!.action).toBe("Go");
  expect(agent.state.history[0]!.page_changed).toBeNull();
  expect(agent.state.decision).toBeNull();
});

test("an uncertain browser mutation fails closed without automatic retry", async () => {
  const { agent, driver } = runner("CLICK", "2");
  driver.act.mockRejectedValueOnce(new Error("Connection lost after mouse press"));
  await expect(agent.command("tick")).rejects.toThrow("Connection lost");
  expect(agent.state.status).toBe("error");
  await expect(agent.command("tick")).rejects.toThrow("stopped");
  expect(driver.act).toHaveBeenCalledTimes(1);
});

test("a document navigation during prediction only reobserves", async () => {
  const { agent, driver } = runner();
  driver.fresh.mockRejectedValueOnce(new StalePage("Navigating"));
  await agent.command("tick");
  expect(driver.act).not.toHaveBeenCalled();
  expect(agent.state.decisions).toHaveLength(0);
  expect(agent.state.status).toBe("ready");
});

test("WAIT does not trigger no-progress protection but is bounded by the action budget", async () => {
  const { agent } = runner("WAIT", "", 4);
  for (let i = 0; i < 4; i++) await agent.command("tick");
  expect(agent.state.status).toBe("ready");
  await expect(agent.command("tick")).rejects.toThrow("action budget");
  expect(agent.state.status).toBe("blocked");
  expect(agent.state.history).toHaveLength(4);
});

test("repeated predictions and unchanged mutations are independently bounded", async () => {
  const predicting = runner("CLICK", "2", 2).agent;
  for (let i = 0; i < 4; i++) await predicting.command("predict");
  await expect(predicting.command("predict")).rejects.toThrow("model-call budget");
  const clicking = runner("CLICK", "2").agent;
  for (let i = 0; i < 3; i++) await clicking.command("tick");
  expect(clicking.state.status).toBe("blocked");
});

test("an early DONE is rejected even when the model assigns it full confidence", async () => {
  const { agent, driver } = runner("DONE");
  await expect(agent.command("tick")).rejects.toThrow("Invalid typed decision");
  expect(agent.state.status).toBe("error");
  expect(agent.state.plan_index).toBe(0);
  expect(driver.act).not.toHaveBeenCalled();
});

test("failed checklist attempts remain visible in the trace without executing a browser action", async () => {
  const { agent, driver } = runner("WAIT", "", 60, []);
  await expect(agent.command("tick")).rejects.toThrow("verifiable checklist");
  expect(agent.state.planning_calls).toHaveLength(2);
  expect(agent.state.decisions).toHaveLength(0);
  expect(agent.state.status).toBe("error");
  expect(driver.act).not.toHaveBeenCalled();
  expect(JSON.stringify(agent.snapshot())).not.toContain("test-key");
});

test("completion requires a fresh observation, not just matching stale checkpoint values", async () => {
  const { agent, driver } = runner("WAIT", "", 60, [
    { instruction: "Read the Search title", checks: [{ kind: "title", includes: "Search" }] },
  ]);
  driver.fresh.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(agent.command("predict")).rejects.toBeInstanceOf(StalePage);
  expect(agent.state.status).toBe("ready");
  expect(agent.state.checkpoints[0]!.verified).toBeNull();
  expect(driver.act).not.toHaveBeenCalled();
  await agent.command("tick");
  expect(agent.state.status).toBe("done");
  expect(agent.state.decisions).toHaveLength(0);
  expect(agent.state.plan_index).toBe(1);
});

test("concurrent callers cannot execute overlapping steps", async () => {
  const { agent, driver } = runner("WAIT");
  let release!: (value: boolean) => void;
  driver.fresh.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
  );
  const first = agent.command("predict");
  await expect(agent.command("tick")).rejects.toThrow("already running");
  release(true);
  await first;
  expect(agent.state.decisions).toHaveLength(1);
});

test("a missing required field value blocks clearly without typing or retrying", async () => {
  const p = provider(async (request) => {
    const body = await request.json();
    if (new URL(request.url).pathname.endsWith("systemone"))
      return Response.json(decisionResponse(body));
    return body.messages[0].content.includes("completion checklist")
      ? chatResponse({
          steps: [
            {
              instruction: "Enter name",
              checks: [{ kind: "value", label: "Search", equals: "unknown" }],
            },
          ],
        })
      : chatResponse({ text: null });
  });
  servers.push(p.server);
  const { driver } = runner();
  const agent = new Agent(driver, page(), "Enter the missing name", {
    settings: async () => p.settings,
  });
  await agent.command("tick");
  expect(agent.state.status).toBe("blocked");
  expect(agent.state.stop_reason?.code).toBe("missing_value");
  expect(agent.state.text_calls).toHaveLength(1);
  expect(agent.state.model_calls.filter((c) => c.role === "text")).toHaveLength(1);
  expect(driver.act).not.toHaveBeenCalled();
  expect(agent.state.history).toHaveLength(0);
});

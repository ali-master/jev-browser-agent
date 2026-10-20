import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/agent";
import { Browser } from "../src/browser";
import { WorkflowCache, workflowGoal, workflowOptions } from "../src/workflow";
import {
  chatResponse,
  completionResponse,
  decisionResponse,
  page,
  provider,
} from "./helpers";
import type { Action, TaskStep } from "../src/types";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("a verified parameterized run reuses current nodes and still reviews the new goal", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-workflow-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  let decisions = 0,
    reviews = 0;
  const models = provider(async (request) => {
    const body = await request.json();
    if (request.url.endsWith("/systemone")) {
      decisions++;
      return Response.json(decisionResponse(body));
    }
    if (body.response_format.json_schema.name === "completion_review") {
      reviews++;
      return completionResponse(body);
    }
    const goal = JSON.parse(body.messages[1].content).original_goal as string;
    return chatResponse({
      steps: [
        {
          instruction: goal,
          checks: [
            {
              kind: "value",
              label: "Search",
              equals: goal.includes("Paris") ? "Paris" : "Lisbon",
            },
          ],
        },
      ],
    });
  });
  cleanup.push(() => models.server.stop(true));
  const run = async (city: string, node: number) => {
    const state = page();
    const field = state.actions[0]!;
    if ("node" in field) {
      field.node = node;
      field.ref = `new-document:${node}`;
    }
    const agent = new Agent(
      {
        observe: async () => structuredClone(state),
        fresh: async () => true,
        close: async () => {},
        act: async (action: Action, _page, text) => {
          expect("node" in action && action.node).toBe(node);
          expect(text).toBe(city);
          if ("node" in field) field.value = text;
          state.actions = [field];
          state.text = `Search ${city}`;
        },
      },
      structuredClone(state),
      "Search {{city}}",
      {
        settings: async () => models.settings,
        workflow: { name: "search", directory, parameters: { city } },
      },
    );
    for await (const _state of agent.run()) {
    }
    expect(agent.state.status).toBe("done");
    return agent;
  };
  const first = await run("Lisbon", 101);
  expect(first.state.workflow?.saved).toBe(true);
  const second = await run("Paris", 909);
  expect(second.state.workflow?.hits).toBe(1);
  expect(decisions).toBe(1);
  expect(reviews).toBe(2);
  expect((await stat(join(directory, "search.json"))).mode & 0o777).toBe(0o600);
  const saved = await Bun.file(join(directory, "search.json")).text();
  expect(saved).not.toContain("new-document:");
  expect(saved).not.toContain("909");
});

test("changed preconditions or ambiguous targets disable replay; unfinished runs are not saved", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-workflow-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const options = { name: "safe", directory };
  const cache = new WorkflowCache("Search", page().url, options);
  const step: TaskStep = {
    instruction: "Search",
    checks: [{ kind: "text", includes: "Search" }],
  };
  cache.performed(page(), step, page().actions[0]!, "query");
  expect(await Bun.file(join(directory, "safe.json")).exists()).toBe(false);
  cache.observed(page());
  await cache.save();
  const other = new WorkflowCache("Search", page().url, options);
  await other.load();
  const changed = page();
  changed.actions.push({
    ...changed.actions[0]!,
    id: "duplicate",
    node: 500,
  } as Action);
  expect(other.choose(changed, step)).toBeNull();
  expect(other.stats.misses).toBe(1);
});

test("workflow names cannot escape storage and parameter values cannot be confused", () => {
  expect(() => workflowOptions({ name: "../escape" })).toThrow();
  expect(() =>
    workflowOptions({ name: "safe", parameters: { a: "same", b: "same" } }),
  ).toThrow();
  expect(() => workflowGoal("Search {{city}}", { name: "safe" })).toThrow(
    "Missing workflow parameter",
  );
  expect(
    workflowGoal("Search {{city}}", {
      name: "safe",
      parameters: { city: "Paris" },
    }),
  ).toBe("Search Paris");
});

test("browser replay binds a new document and rejects a replaced field before input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-workflow-browser-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const site = Bun.serve({
    port: 0,
    fetch: () =>
      new Response('<label>Search <input aria-label="Search"></label>', {
        headers: { "Content-Type": "text/html" },
      }),
  });
  cleanup.push(() => site.stop(true));
  const url = `http://localhost:${site.port}/`;
  const options = { name: "browser", directory };
  const step: TaskStep = {
    instruction: "Search Lisbon",
    checks: [{ kind: "value", label: "Search", equals: "Lisbon" }],
  };
  const browser = await Browser.create(url);
  cleanup.push(() => browser.close());
  let before = await browser.observe();
  const action = before.actions.find((a) => a.kind === "fill")!;
  const first = new WorkflowCache(step.instruction, url, options);
  await browser.act(action, before, "Lisbon");
  first.performed(before, step, action, "Lisbon");
  first.observed(await browser.observe());
  await first.save();
  await browser.evaluate("location.reload();true");
  before = await browser.observe();
  const next = new WorkflowCache(step.instruction, url, options);
  await next.load();
  const replay = next.choose(before, step)!;
  expect(replay).not.toBeNull();
  await browser.evaluate(
    "document.querySelector('input').outerHTML='<input aria-label=\"Search\">';true",
  );
  await expect(
    browser.act(replay.action, before, replay.text),
  ).rejects.toThrow();
  expect(await browser.evaluate("document.querySelector('input').value")).toBe(
    "",
  );
}, 15000);

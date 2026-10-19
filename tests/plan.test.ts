import { afterEach, expect, test } from "bun:test";
import { createPlan, updateProgress, validatePlan } from "../src/plan.js";
import type { Checkpoint, CompletionCheck, HistoryEntry } from "../src/types.js";
import { chatResponse, page, provider } from "./helpers.js";

const servers: Bun.Server<undefined>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});
const checkpoints = (...steps: CompletionCheck[][]): Checkpoint[] =>
  steps.map((checks, index) => ({
    instruction: `Step ${index + 1}`,
    checks,
    started_at_action: null,
    started_fingerprint: null,
    verified: null,
  }));
const click = (action: string): HistoryEntry => ({
  step: 1,
  action,
  kind: "click",
  choice: "e3",
  probability: 1,
  confidence: 1,
  latency_ms: 0,
  text: null,
  text_helper: null,
  text_latency_ms: 0,
  operation: "CLICK",
  target: "2",
  page_changed: true,
  url: "https://example.test/",
  usage: {},
  executed_ms: 1,
  elapsed_ms: 2,
});

test.each([
  { steps: [] },
  {
    steps: [{ instruction: "Submit", checks: [{ kind: "action", label: "Go", action: "click" }] }],
  },
  {
    steps: [
      {
        instruction: "Check",
        checks: [{ kind: "checked", label: "Free cancellation", equals: "true" }],
      },
    ],
  },
  {
    steps: [
      {
        instruction: "Select Design",
        checks: [
          { kind: "action", label: "Category", action: "click" },
          { kind: "value", label: "Category", equals: "Design" },
        ],
      },
    ],
  },
  { steps: [{ instruction: "Go", checks: [{ kind: "script", code: "document.title='done'" }] }] },
  { steps: [{ instruction: "Read", checks: [{ kind: "title", includes: "" }] }] },
  {
    steps: [{ instruction: "Read", checks: [{ kind: "title", includes: "done", selector: "h1" }] }],
  },
])("rejects unverifiable or executable model output: %j", (value) => {
  expect(() => validatePlan(value)).toThrow();
});

test("the planner repairs once, rereads settings, and fails closed on a second invalid plan", async () => {
  let calls = 0,
    reads = 0;
  const transport = provider(() => {
    calls++;
    return chatResponse({ steps: [] });
  });
  servers.push(transport.server);
  await expect(
    createPlan(page(), "Search Lisbon", async () => {
      reads++;
      return transport.endpoint;
    }),
  ).rejects.toThrow("no browser action executed");
  expect(calls).toBe(2);
  expect(reads).toBe(2);
});

test("a corrected checklist keeps both model calls without credentials", async () => {
  let calls = 0;
  const transport = provider(() =>
    chatResponse(
      ++calls === 1
        ? { steps: [] }
        : {
            steps: [
              {
                instruction: "Type Lisbon",
                checks: [{ kind: "value", label: "Search", equals: "Lisbon" }],
              },
            ],
          },
    ),
  );
  servers.push(transport.server);
  const result = await createPlan(page(), "Search Lisbon", async () => transport.endpoint);
  expect(result.calls).toHaveLength(2);
  expect(result.steps).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain("test-key");
});

test("matching result text and a checkbox value of on do not satisfy field and checked requirements", () => {
  const state = page();
  state.text = "Lisbon · Free cancellation";
  state.actions.push({
    id: "e4",
    node: 30,
    kind: "click",
    label: "Free cancellation",
    role: "checkbox",
    value: "on",
    checked: "false",
  });
  const steps = checkpoints(
    [{ kind: "value", label: "Search", equals: "Lisbon" }],
    [{ kind: "checked", label: "Free cancellation", equals: true }],
  );
  expect(updateProgress(steps, state, [])).toBe(0);
  Object.assign(state.actions[0]!, { value: "Lisbon" });
  expect(updateProgress(steps, state, [])).toBe(1);
  Object.assign(state.actions.at(-1)!, { checked: "true" });
  expect(updateProgress(steps, state, [])).toBe(2);
});

test("submission needs a confirmed click after its checkpoint starts, not a populated field or old click", () => {
  const state = page();
  Object.assign(state.actions[0]!, { value: "Lisbon" });
  const steps = checkpoints([
    { kind: "value", label: "Search", equals: "Lisbon" },
    { kind: "action", label: "Go", action: "click" },
  ]);
  const history = [click("Go")];
  expect(updateProgress(steps, state, history)).toBe(0);
  history.push(click("Go"));
  expect(updateProgress(steps, state, history)).toBe(0);
  state.fingerprint = "search-submitted";
  expect(updateProgress(steps, state, history)).toBe(1);
});

test("opening a result requires its executed click and the destination page, not a visible card", () => {
  const state = page();
  state.text = "Casa Flora · View Casa Flora";
  const steps = checkpoints([
    { kind: "action", label: "View Casa Flora", action: "click" },
    { kind: "title", includes: "Casa Flora" },
  ]);
  const history: HistoryEntry[] = [];
  expect(updateProgress(steps, state, history)).toBe(0);
  history.push(click("View Casa Flora"));
  expect(updateProgress(steps, state, history)).toBe(0);
  state.title = "Casa Flora · Forma";
  state.fingerprint = "opened-detail";
  expect(updateProgress(steps, state, history)).toBe(1);
});

test("regressed controls reopen their step and invalidate later submission evidence", () => {
  const state = page();
  Object.assign(state.actions[0]!, { value: "Lisbon" });
  const steps = checkpoints(
    [{ kind: "value", label: "Search", equals: "Lisbon" }],
    [
      { kind: "action", label: "Go", action: "click" },
      { kind: "value", label: "Search", equals: "Lisbon" },
    ],
  );
  const history: HistoryEntry[] = [];
  expect(updateProgress(steps, state, history)).toBe(1);
  history.push(click("Go"));
  state.fingerprint = "submitted";
  expect(updateProgress(steps, state, history)).toBe(2);
  Object.assign(state.actions[0]!, { value: "Porto" });
  expect(updateProgress(steps, state, history)).toBe(0);
  expect(steps.every((step) => !step.verified)).toBe(true);
  Object.assign(state.actions[0]!, { value: "Lisbon" });
  expect(updateProgress(steps, state, history)).toBe(1);
  history.push(click("Go"));
  state.fingerprint = "resubmitted";
  expect(updateProgress(steps, state, history)).toBe(2);
  state.actions = [];
  expect(updateProgress(steps, state, history)).toBe(2);
});

test("ambiguous duplicate field labels cannot produce completion evidence", () => {
  const state = page();
  Object.assign(state.actions[0]!, { value: "Lisbon" });
  state.actions.push({
    id: "e4",
    node: 30,
    kind: "fill",
    label: "Search",
    role: "textbox",
    value: "Lisbon",
  });
  const steps = checkpoints([{ kind: "value", label: "Search", equals: "Lisbon" }]);
  expect(updateProgress(steps, state, [])).toBe(0);
});

test("action text checks must come from the goal, not invented counts or messages", () => {
  const plan = {
    steps: [
      {
        instruction: "Click Search",
        checks: [
          { kind: "action", label: "Search", action: "click" },
          { kind: "text", includes: "3 places" },
        ],
      },
    ],
  };
  expect(() => validatePlan(plan, "Search Lisbon")).toThrow("guesses an action's text outcome");
  expect(validatePlan(plan, 'Click Search and wait for "3 places"')).toHaveLength(1);
});

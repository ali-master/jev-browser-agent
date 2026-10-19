import { afterEach, expect, test } from "bun:test";
import {
  createPlan,
  reviewCompletion,
  updateProgress,
  validatePlan,
} from "../src/plan";
import type { Checkpoint, CompletionCheck, HistoryEntry } from "../src/types";
import { chatResponse, completionResponse, page, provider } from "./helpers";

const servers: Bun.Server<undefined>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

test("nullable checklist and review schemas work with string-only type parsers", async () => {
  const acceptsTypes = (schema: unknown): boolean =>
    !schema ||
    typeof schema !== "object" ||
    (Array.isArray(schema)
      ? schema.every(acceptsTypes)
      : Object.entries(schema).every(([key, value]) =>
          key === "type" ? typeof value === "string" : acceptsTypes(value),
        ));
  const p = provider(async (request) => {
    const body = await request.json();
    if (!acceptsTypes(body.response_format.json_schema.schema))
      return Response.json(
        { error: "'type' must be a string" },
        { status: 400 },
      );
    return body.response_format.json_schema.name === "completion_review"
      ? completionResponse(body)
      : chatResponse({
          steps: [
            {
              instruction: "Read Search",
              checks: [{ kind: "title", includes: "Search" }],
            },
          ],
        });
  });
  servers.push(p.server);
  const { steps } = await createPlan(
    page(),
    "Read Search",
    async () => p.endpoint,
  );
  const plan = steps.map((step) => ({
    ...step,
    started_at_action: null,
    started_fingerprint: null,
    verified: null,
  }));
  expect(updateProgress(plan, page(), [])).toBe(1);
  expect(
    (
      await reviewCompletion(
        page(),
        "Read Search",
        plan,
        async () => p.endpoint,
      )
    ).complete,
  ).toBe(true);
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
    steps: [
      {
        instruction: "Submit",
        checks: [{ kind: "action", label: "Go", action: "click" }],
      },
    ],
  },
  {
    steps: [
      {
        instruction: "Check",
        checks: [
          { kind: "checked", label: "Free cancellation", equals: "true" },
        ],
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
  {
    steps: [
      {
        instruction: "Go",
        checks: [{ kind: "script", code: "document.title='done'" }],
      },
    ],
  },
  {
    steps: [{ instruction: "Read", checks: [{ kind: "title", includes: "" }] }],
  },
  {
    steps: [
      {
        instruction: "Read",
        checks: [{ kind: "title", includes: "done", selector: "h1" }],
      },
    ],
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
  const result = await createPlan(
    page(),
    "Search Lisbon",
    async () => transport.endpoint,
  );
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
  const steps = checkpoints([
    { kind: "value", label: "Search", equals: "Lisbon" },
  ]);
  expect(updateProgress(steps, state, [])).toBe(0);
});

test("scoped control checks verify only their field and invalidate replaced same-document nodes", () => {
  const state = page();
  Object.assign(state.actions[0]!, {
    label: "Name",
    ref: "fixture-document:10",
    scope: "Sender",
    value: "Alice",
  });
  state.actions.push({
    id: "e4",
    node: 30,
    kind: "fill",
    label: "Name",
    role: "textbox",
    ref: "fixture-document:30",
    scope: "Recipient",
    value: "Alice",
  });
  const steps = checkpoints(
    [
      {
        kind: "value",
        label: "Name",
        scope: "Sender",
        ref: "fixture-document:10",
        equals: "Alice",
      },
    ],
    [
      {
        kind: "value",
        label: "Name",
        scope: "Recipient",
        ref: "fixture-document:30",
        equals: "Bob",
      },
    ],
  );
  expect(updateProgress(steps, state, [])).toBe(1);
  Object.assign(state.actions.at(-1)!, { value: "Bob" });
  expect(updateProgress(steps, state, [])).toBe(2);
  Object.assign(state.actions[0]!, { ref: "fixture-document:99" });
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
  expect(() => validatePlan(plan, "Search Lisbon")).toThrow(
    "guesses an action's text outcome",
  );
  expect(
    validatePlan(plan, 'Click Search and wait for "3 places"'),
  ).toHaveLength(1);
});

test.each([
  "mismatched ref",
  "invented ref",
  "checkbox value",
  "button checked",
])("rejects a planner's invalid observed-control binding: %s", (mode) => {
  const state = page();
  Object.assign(state.actions[0]!, {
    ref: "fixture-document:10",
    scope: "Search form",
  });
  state.actions.push({
    id: "e4",
    kind: "click",
    label: "Refund",
    role: "checkbox",
    node: 30,
    checked: "false",
    value: "on",
    ref: "fixture-document:30",
  });
  let check: CompletionCheck = {
    kind: "value",
    label: "Search",
    equals: "Lisbon",
    ref: "fixture-document:10",
    scope: "Search form",
  };
  if (mode === "mismatched ref") check.ref = "fixture-document:30";
  if (mode === "invented ref") check.ref = "fixture-document:999";
  if (mode === "checkbox value")
    check = { kind: "value", label: "Refund", equals: "on" };
  if (mode === "button checked")
    check = { kind: "checked", label: "Go", equals: true };
  expect(() =>
    validatePlan(
      { steps: [{ instruction: "Complete the field", checks: [check] }] },
      "Find Lisbon",
      state,
    ),
  ).toThrow();
});

test("a mismatched field reference gets one repair with the observed context", async () => {
  const state = page();
  Object.assign(state.actions[0]!, {
    ref: "fixture-document:10",
    scope: "Search form",
  });
  let calls = 0;
  const p = provider(async (request) => {
    const body = await request.json();
    calls++;
    if (calls === 2)
      expect(body.messages.at(-1).content).toContain("SAME observed element");
    return chatResponse({
      steps: [
        {
          instruction: "Enter Lisbon",
          checks: [
            {
              kind: "value",
              label: "Search",
              equals: "Lisbon",
              ref: calls === 1 ? "fixture-document:999" : "fixture-document:10",
              scope: "Search form",
            },
          ],
        },
      ],
    });
  });
  servers.push(p.server);
  const plan = await createPlan(state, "Enter Lisbon", async () => p.endpoint);
  expect(calls).toBe(2);
  expect((plan.steps[0]!.checks[0] as { ref: string }).ref).toBe(
    "fixture-document:10",
  );
  expect(
    validatePlan(
      {
        steps: [
          {
            instruction: "Enter on next page",
            checks: [
              {
                kind: "value",
                label: "Unseen field",
                equals: "Lisbon",
                ref: null,
                scope: null,
              },
            ],
          },
        ],
      },
      "Enter Lisbon",
      state,
    ),
  ).toHaveLength(1);
});

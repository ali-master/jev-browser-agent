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

test("rejects a borrowed scope even when ref is null on a later checklist step", () => {
  const state = page();
  const control = {
    kind: "value",
    label: "Search",
    equals: "Lisbon",
    ref: null,
    scope: "unrelated form" as string | null,
  };
  const plan = {
    steps: [
      {
        instruction: "Read Search",
        checks: [{ kind: "title", includes: "Search" }],
      },
      { instruction: "Type Lisbon", checks: [control] },
    ],
  };
  expect(() => validatePlan(plan, "Type Lisbon", state)).toThrow(
    "unobserved scope",
  );
  control.scope = null;
  expect(validatePlan(plan, "Type Lisbon", state)).toHaveLength(2);
});

test("completion review deduplicates source text without dropping distinct evidence or checkpoint order", async () => {
  const state = page();
  const steps: Checkpoint[] = ["First", "Second", "Third"].map(
    (instruction, index) => ({
      instruction,
      checks: [{ kind: "title", includes: "Search" }],
      started_at_action: index,
      started_fingerprint: `start-${index}`,
      verified: {
        fingerprint: `end-${index}`,
        url: state.url,
        action_count: index + 1,
        evidence: {
          title: state.title,
          text: index === 2 ? "Distinct earlier evidence" : state.text,
        },
      },
    }),
  );
  const before = structuredClone(steps);
  const p = provider(async (request) => {
    const body = await request.json();
    const context = JSON.parse(body.messages[1].content);
    expect(context.sources).toHaveLength(2);
    expect(context.sources[1].text).toBe("Distinct earlier evidence");
    expect(
      context.checkpoints.map((step: any) => step.verified.action_count),
    ).toEqual([1, 2, 3]);
    expect(context.checkpoints[0].checks).toEqual(steps[0]!.checks);
    expect(JSON.stringify(context.checkpoints)).not.toContain("evidence");
    return chatResponse({
      complete: true,
      answer: "Done",
      evidence: [{ url: state.url, quote: "Distinct earlier evidence" }],
      missing_steps: [],
    });
  });
  servers.push(p.server);
  expect(
    (
      await reviewCompletion(
        state,
        "Read all three pages",
        steps,
        async () => p.endpoint,
      )
    ).complete,
  ).toBe(true);
  expect(steps).toEqual(before);
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
    if (body.response_format.json_schema.name === "browser_checklist") {
      const alternatives =
        body.response_format.json_schema.schema.properties.steps.items
          .properties.checks.items.anyOf;
      expect(
        alternatives.every(
          (branch: any) => Object.keys(branch.properties)[0] === "kind",
        ),
      ).toBe(true);
      for (const branch of alternatives)
        if (branch.properties.ref)
          expect(branch.properties.ref).toEqual({ type: "null" });
    }
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

test("an offscreen consent button stays unbound until it is observed", async () => {
  const state = page();
  state.actions = [
    {
      id: "e1",
      kind: "click",
      label: "Language: English",
      node: 1,
      ref: "consent:1",
      value: "",
      role: "button",
    },
    { id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 },
  ];
  state.scroll.height = 1200;
  const p = provider(async (request) => {
    const body = await request.json();
    expect(JSON.parse(body.messages[1].content).observation.scroll).toEqual(
      state.scroll,
    );
    return chatResponse({
      steps: [
        {
          instruction: "Reject cookies and open flight search",
          checks: [
            {
              kind: "action",
              label: "Reject all",
              action: "click",
              ref: null,
              scope: null,
            },
            { kind: "url", includes: "google.com/travel/flights" },
          ],
        },
      ],
    });
  });
  servers.push(p.server);
  const { steps } = await createPlan(
    state,
    "Reject optional cookies and open Google Flights",
    async () => p.endpoint,
  );
  expect(steps[0]!.checks[0]).toMatchObject({ label: "Reject all", ref: null });
});

test("a destination in a consent redirect URL does not verify arrival", () => {
  const state = page();
  const destination = "https://www.google.com/travel/flights";
  state.url = `https://consent.google.com/m?continue=${destination}?hl%3Den`;
  for (const includes of [
    destination,
    "google.com/travel/flights",
    "/travel/flights",
  ]) {
    const steps = checkpoints([{ kind: "url", includes }]);
    expect(updateProgress(steps, state, [])).toBe(0);
    state.url = `${destination}?hl=en`;
    expect(updateProgress(steps, state, [])).toBe(1);
    state.url = `https://consent.google.com/m?continue=${destination}?hl%3Den`;
  }
  state.url = `${destination}?hl=en#search`;
  expect(
    updateProgress(
      checkpoints([{ kind: "url", includes: "/travel/flights?hl=en" }]),
      state,
      [],
    ),
  ).toBe(1);
  expect(
    updateProgress(
      checkpoints([{ kind: "url", includes: "#search" }]),
      state,
      [],
    ),
  ).toBe(1);
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

test("planner repair and the final error explain the invalid step without echoing model output", async () => {
  let calls = 0;
  const reason = "Step 1 needs a nonempty requested field value";
  const transport = provider(async (request) => {
    const body = await request.json();
    if (++calls === 2) expect(body.messages.at(-1).content).toContain(reason);
    return chatResponse({
      steps: [
        {
          instruction: "test-key",
          checks: [{ kind: "value", label: "test-key", equals: "" }],
        },
      ],
    });
  });
  servers.push(transport.server);
  const error = await createPlan(
    page(),
    "Search Lisbon",
    async () => transport.endpoint,
  ).catch((error: Error) => error);
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  expect(message).toContain(reason);
  expect(message).toContain("after 2 attempts");
  expect(message).toContain("no browser action executed for this plan");
  expect(message).toContain("Chat helper model in Model settings");
  expect(message).not.toContain("test-key");
  expect(calls).toBe(2);
});

test.each([
  ["malformed JSON", "test-key", "stop", "invalid or missing checklist JSON"],
  ["missing JSON", null, "stop", "invalid or missing checklist JSON"],
  [
    "truncated response",
    JSON.stringify({
      steps: [
        {
          instruction: "Read Search",
          checks: [{ kind: "title", includes: "Search" }],
        },
      ],
    }),
    "length",
    "output token limit",
  ],
])(
  "planner diagnoses %s and keeps repair bounded",
  async (_, content, finishReason, reason) => {
    let calls = 0;
    const transport = provider(async (request) => {
      const body = await request.json();
      if (++calls === 2)
        expect(body.messages.at(-1).content).toContain(reason!);
      return Response.json({
        choices: [{ message: { content }, finish_reason: finishReason }],
      });
    });
    servers.push(transport.server);
    const error = await createPlan(
      page(),
      "Read Search",
      async () => transport.endpoint,
    ).catch((error: Error) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(reason!);
    expect((error as Error).message).not.toContain("test-key");
    expect(calls).toBe(2);
  },
);

test("checked values report the required boolean without coercing model output", () => {
  expect(() =>
    validatePlan({
      steps: [
        {
          instruction: "Enable availability",
          checks: [{ kind: "checked", label: "Available", equals: "true" }],
        },
      ],
    }),
  ).toThrow("Step 1 needs a boolean equals");
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

test("scrolling or SPA navigation retains verified controls that are no longer visible", () => {
  const state = page();
  Object.assign(state.actions[0]!, {
    ref: "fixture-document:10",
    value: "Lisbon",
  });
  const steps = checkpoints(
    [
      {
        kind: "value",
        label: "Search",
        ref: "fixture-document:10",
        equals: "Lisbon",
      },
    ],
    [{ kind: "title", includes: "Destination" }],
  );
  expect(updateProgress(steps, state, [])).toBe(1);
  state.actions = [];
  state.scroll.y = 560;
  expect(updateProgress(steps, state, [])).toBe(1);
  expect(steps[0]!.verified).not.toBeNull();
  state.url += "#destination";
  state.title = "Destination";
  expect(updateProgress(steps, state, [])).toBe(2);
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

test("submission rejects an invented future query URL instead of waiting for it forever", () => {
  const url = "https://example.test/?destination=Lisbon&category=Design";
  const plan = {
    steps: [
      {
        instruction: "Submit search",
        checks: [
          { kind: "action", label: "Go", action: "click" },
          { kind: "url", includes: url },
        ],
      },
    ],
  };
  expect(() => validatePlan(plan, "Find Lisbon", page())).toThrow(
    "guesses a future query URL",
  );
  expect(validatePlan(plan, `Open ${url}`, page())).toHaveLength(1);
});

test("observed form submission uses field evidence instead of a guessed page title", () => {
  const state = page();
  Object.assign(state.actions[2]!, { submits_form: true });
  const step = {
    instruction: "Submit search",
    checks: [
      { kind: "action", label: "Go", action: "click" },
      { kind: "title", includes: "Lisbon results" },
    ],
  };
  expect(() => validatePlan({ steps: [step] }, "Find Lisbon", state)).toThrow(
    "submits an observed form",
  );
  expect(
    validatePlan(
      {
        steps: [
          {
            ...step,
            checks: [
              step.checks[0],
              { kind: "value", label: "Search", equals: "Lisbon" },
            ],
          },
        ],
      },
      "Find Lisbon",
      state,
    ),
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

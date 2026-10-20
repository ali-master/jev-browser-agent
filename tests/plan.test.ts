import { afterEach, expect, test } from "bun:test";
import {
  createPlan,
  reviewCompletion,
  updateProgress,
  validatePlan,
} from "../src/plan";
import type {
  Checkpoint,
  CompletionCheck,
  HistoryEntry,
  TaskStep,
} from "../src/types";
import { chatResponse, completionResponse, page, provider } from "./helpers";

const servers: Bun.Server<undefined>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

test("navigation checks must match the actual destination of an observed link", () => {
  const state = page();
  state.actions = [
    {
      id: "map",
      kind: "click",
      node: 2,
      role: "link",
      label: "map()",
      href: "https://example.test/Array/map",
      ref: "fixture-document:2",
    },
  ];
  const step: TaskStep = {
    instruction: "Open map()",
    checks: [
      { kind: "action", label: "map()", action: "click" },
      { kind: "url", includes: "Array.prototype.map" },
    ],
  };
  expect(() => validatePlan({ steps: [step] }, "Read map()", state)).toThrow(
    "observed href",
  );
  step.checks[1] = { kind: "url", includes: "/Array/map" };
  expect(validatePlan({ steps: [step] }, "Read map()", state)).toEqual([step]);
});

test("a document title mistakenly used as a reading URL is grounded to its observed address", () => {
  const state = page();
  state.url = "https://example.test/Array/map";
  state.title = "Array.prototype.map() - JavaScript";
  const steps: TaskStep[] = [
    {
      instruction: "Read this document",
      checks: [{ kind: "url", includes: "Array.prototype.map" }],
    },
  ];
  expect(validatePlan({ steps }, "Read map()", state)[0]!.checks).toEqual([
    { kind: "url", includes: state.url },
  ]);
});

test("inline DOM punctuation gaps do not invalidate a real reading quote", async () => {
  const state = page();
  state.text = "JavaScript\narray-copy operations\ncreate\nshallow copies\n.";
  const quote = "JavaScript array-copy operations create shallow copies.";
  const steps = validatePlan(
    {
      steps: [
        {
          instruction: "Read array behavior",
          checks: [{ kind: "text", includes: quote }],
        },
      ],
    },
    "Read array behavior",
    state,
  );
  expect(
    updateProgress(
      steps.map((step) => ({
        ...step,
        verified: null,
        started_at_action: null,
        started_fingerprint: null,
      })),
      state,
      [],
    ),
  ).toBe(1);
  const p = provider(() =>
    chatResponse({
      complete: true,
      answer: quote,
      evidence: [{ url: state.url, quote }],
      missing_steps: [],
    }),
  );
  servers.push(p.server);
  expect(
    (
      await reviewCompletion(
        state,
        "Read array behavior",
        [],
        async () => p.endpoint,
      )
    ).complete,
  ).toBe(true);
});

test("menu expansion is directly verifiable and remains a completed waypoint after closing", () => {
  const state = page();
  const menu = {
    id: "menu",
    kind: "click" as const,
    node: 1,
    role: "button",
    label: "Explore",
    expanded: "false",
  };
  state.actions = [menu];
  const steps = validatePlan(
    {
      steps: [
        {
          instruction: "Open Explore",
          checks: [{ kind: "expanded", label: "Explore", equals: true }],
        },
      ],
    },
    "Find a planet",
    state,
  );
  const checkpoints: Checkpoint[] = steps.map((step) => ({
    ...step,
    started_at_action: null,
    started_fingerprint: null,
    verified: null,
  }));
  expect(updateProgress(checkpoints, state, [])).toBe(0);
  menu.expanded = "true";
  expect(updateProgress(checkpoints, state, [])).toBe(1);
  menu.expanded = "false";
  expect(updateProgress(checkpoints, state, [])).toBe(1);
});

test.each([false, true])(
  "boundary recovery finds the next pending step despite a satisfied prefix: prefix=%s",
  async (prefix) => {
    const state = page();
    state.actions = [
      {
        id: "menu",
        kind: "click",
        node: 1,
        role: "button",
        label: "Explore",
        expanded: "false",
      },
    ];
    let calls = 0;
    const p = provider(() =>
      chatResponse({
        steps: [
          ...(prefix && calls === 0
            ? [
                {
                  instruction: "Scroll to find navigation",
                  checks: [{ kind: "text", includes: state.text }],
                },
              ]
            : []),
          ++calls === 1
            ? {
                instruction: "Find Venus",
                checks: [
                  { kind: "action", label: "Venus", action: "click" },
                  { kind: "url", includes: "/venus" },
                ],
              }
            : {
                instruction: "Open Explore",
                checks: [{ kind: "expanded", label: "Explore", equals: true }],
              },
        ],
      }),
    );
    servers.push(p.server);
    const result = await createPlan(
      state,
      "Find Venus",
      async () => p.endpoint,
      [],
      undefined,
      {
        completed: [],
        remaining: [],
        reason: "Scrolling reached the page boundary.",
      },
    );
    expect(calls).toBe(2);
    expect(result.steps[0]!.checks[0]).toMatchObject({
      kind: "expanded",
      label: "Explore",
    });
  },
);

test("shortened result labels with invented paths must be repaired from observed links", () => {
  const state = page();
  state.actions = [
    {
      id: "book",
      node: 1,
      kind: "click",
      role: "link",
      label: "Book title Author 100 downloads",
      href: "https://example.test/books/42",
    },
    {
      id: "other",
      node: 2,
      kind: "click",
      role: "link",
      label: "Book title Author 50 downloads",
      href: "https://example.test/books/43",
    },
  ];
  const output = {
    steps: [
      {
        instruction: "Open the book",
        checks: [
          { kind: "action", label: "Book title", action: "click" },
          { kind: "url", includes: "/books/42/42.html" },
        ],
      },
    ],
  };
  expect(() => validatePlan(output, "Open the book", state)).toThrow(
    "exact label and href",
  );
  output.steps[0]!.checks[1]!.includes = "/books/42";
  expect(validatePlan(output, "Open the book", state)).toHaveLength(1);
});

test("an incomplete review with an invalid repair delegates once to the checklist planner", async () => {
  const state = page();
  state.actions = [
    {
      id: "venus",
      node: 1,
      kind: "click",
      role: "link",
      label: "Venus",
      href: "https://example.test/venus",
    },
  ];
  let reviews = 0,
    plans = 0;
  const p = provider(async (request) => {
    const body = await request.json();
    if (body.response_format.json_schema.name === "completion_review") {
      reviews++;
      return chatResponse({
        complete: false,
        answer: null,
        evidence: [],
        missing_steps: [
          {
            instruction: "Open Venus",
            checks: [
              { kind: "text", includes: "A fabricated destination fact" },
              { kind: "url", includes: "/venus" },
            ],
          },
        ],
      });
    }
    plans++;
    expect(JSON.stringify(body.messages)).not.toContain(
      "A fabricated destination fact",
    );
    return chatResponse({
      steps: [
        {
          instruction: "Open Venus",
          checks: [
            { kind: "action", label: "Venus", action: "click" },
            { kind: "url", includes: "/venus" },
          ],
        },
      ],
    });
  });
  servers.push(p.server);
  const review = await reviewCompletion(
    state,
    "Open Venus",
    [],
    async () => p.endpoint,
  );
  expect(review.complete).toBe(false);
  expect(review.missing_steps[0]!.checks[0]).toMatchObject({
    kind: "action",
    label: "Venus",
  });
  expect(reviews).toBe(2);
  expect(plans).toBe(1);
});

test("a reading fragment must identify an observed section on the current document", () => {
  const state = page();
  state.actions = [
    {
      id: "examples",
      node: 1,
      kind: "click",
      role: "link",
      label: "Examples",
      href: `${state.url}#examples`,
    },
  ];
  const output = {
    steps: [
      {
        instruction: "Read examples",
        checks: [{ kind: "url", includes: "#examples" }],
      },
    ],
  };
  expect(validatePlan(output, "Read examples", state)).toHaveLength(1);
  state.actions = [
    {
      id: "examples",
      node: 1,
      kind: "click",
      role: "link",
      label: "Examples",
      href: "https://elsewhere.test/#examples",
    },
  ];
  expect(() => validatePlan(output, "Read examples", state)).toThrow(
    "reading URL",
  );
});

test("a reading step must verify each requested section it claims to cover", () => {
  const state = page();
  state.actions = [
    ["Return value", "return_value"],
    ["Examples", "examples"],
    ["Description", "description"],
  ].map(([label, fragment], index) => ({
    id: fragment!,
    node: index + 1,
    kind: "click",
    role: "link",
    label: label!,
    href: `${state.url}#${fragment}`,
  }));
  const goal = "Read the return value and examples.";
  const step: TaskStep = {
    instruction: goal,
    checks: [{ kind: "url", includes: "#examples" }],
  };
  expect(() => validatePlan({ steps: [step] }, goal, state)).toThrow(
    'claims to read "Return value"',
  );
  step.checks.push({ kind: "text", includes: "Return value" });
  expect(validatePlan({ steps: [step] }, goal, state)).toHaveLength(1);
  expect(
    validatePlan(
      {
        steps: [
          {
            instruction: "Read return value",
            checks: [{ kind: "url", includes: "#return_value" }],
          },
          {
            instruction: "Read examples",
            checks: [{ kind: "url", includes: "#examples" }],
          },
        ],
      },
      goal,
      state,
    ),
  ).toHaveLength(2);
});

test("a previously read offscreen control can be rediscovered after reaching the page boundary", async () => {
  const state = page();
  state.read_text = "Catalog\nRead online now\nEnglish";
  const steps: TaskStep[] = [
    {
      instruction: "Open the reader",
      checks: [
        { kind: "action", label: "Read online now", action: "click" },
        { kind: "url", includes: "/reader.html" },
      ],
    },
  ];
  const p = provider(() => chatResponse({ steps }));
  servers.push(p.server);
  const result = await createPlan(
    state,
    "Read the book online",
    async () => p.endpoint,
    [],
    undefined,
    {
      completed: [],
      remaining: [],
      reason: "Scrolling reached the page boundary.",
    },
  );
  expect(result.steps).toEqual(steps);
  expect(result.calls).toHaveLength(1);
});

test("a search field and its distinct same-named submit button can be planned and verified", () => {
  const state = page();
  state.actions = [
    {
      id: "field",
      kind: "fill",
      node: 1,
      role: "searchbox",
      label: "Search",
      value: "The Time Machine",
      form_ref: "form",
    },
    {
      id: "submit",
      kind: "click",
      node: 2,
      role: "button",
      label: "Search",
      form_ref: "form",
      submits_form: true,
    },
  ];
  const steps: TaskStep[] = [
    {
      instruction: "Type the title",
      checks: [{ kind: "value", label: "Search", equals: "The Time Machine" }],
    },
    {
      instruction: "Submit the title",
      checks: [
        { kind: "action", label: "Search", action: "click" },
        { kind: "value", label: "Search", equals: "The Time Machine" },
      ],
    },
  ];
  expect(validatePlan({ steps }, "Find The Time Machine", state)).toEqual(
    steps,
  );
  const checkpoints: Checkpoint[] = steps.map((step) => ({
    ...step,
    verified: null,
    started_at_action: null,
    started_fingerprint: null,
  }));
  expect(updateProgress(checkpoints, state, [])).toBe(1);
  expect(checkpoints[0]!.verified).not.toBeNull();
  expect(checkpoints[1]!.verified).toBeNull();
});

test("a partial viewport cannot certify that requested information is absent", async () => {
  const state = page();
  state.scroll.height = state.h * 2;
  let calls = 0;
  const missing: TaskStep[] = [
    {
      instruction: "Read the UPC",
      checks: [{ kind: "text", includes: "UPC" }],
    },
  ];
  const p = provider(() =>
    chatResponse(
      ++calls === 1
        ? {
            complete: true,
            answer: "UPC is not explicitly listed.",
            evidence: [{ url: state.url, quote: state.text }],
            missing_steps: [],
          }
        : {
            complete: false,
            answer: null,
            evidence: [],
            missing_steps: missing,
          },
    ),
  );
  servers.push(p.server);
  const review = await reviewCompletion(
    state,
    "Report the UPC",
    [],
    async () => p.endpoint,
  );
  expect(calls).toBe(2);
  expect(review.complete).toBe(false);
  expect(review.missing_steps).toEqual(missing);
});

test("an incomplete review discards invented citations without certifying completion", async () => {
  const missing: TaskStep[] = [
    {
      instruction: "Type Paris in Search",
      checks: [{ kind: "value", label: "Search", equals: "Paris" }],
    },
  ];
  const p = provider(() =>
    chatResponse({
      complete: false,
      answer: null,
      evidence: [{ url: page().url, quote: "An invented result" }],
      missing_steps: missing,
    }),
  );
  servers.push(p.server);
  const review = await reviewCompletion(
    page(),
    "Find Paris",
    [],
    async () => p.endpoint,
  );
  expect(review.complete).toBe(false);
  expect(review.answer).toBeNull();
  expect(review.evidence).toEqual([]);
  expect(review.missing_steps).toEqual(missing);
});

test.each([false, true])(
  "split distant quoted passages only when every fact is observed: invented=%s",
  async (invented) => {
    const state = page();
    state.text =
      "Observed book\n£14.39\nDescription and other intervening text.\nUPC\n123456";
    const p = provider(() =>
      chatResponse({
        complete: true,
        answer: "Observed book costs £14.39; UPC 123456.",
        evidence: [
          {
            url: state.url,
            quote: `Observed book\n£14.39\nUPC\n${invented ? "999999" : "123456"}`,
          },
        ],
        missing_steps: [],
      }),
    );
    servers.push(p.server);
    const review = reviewCompletion(
      state,
      "Report title, price and UPC",
      [],
      async () => p.endpoint,
    );
    if (invented)
      await expect(review).rejects.toThrow("exact, contiguous quote");
    else
      expect((await review).evidence).toEqual([
        { url: state.url, quote: "Observed book\n£14.39" },
        { url: state.url, quote: "UPC\n123456" },
      ]);
  },
);

test("a reading checkpoint can combine still-valid text observed across viewports", () => {
  const state = page();
  state.text = "UPC 123456";
  state.read_text = "Observed book\nPrice £14.39\nUPC 123456";
  const steps: Checkpoint[] = [
    {
      instruction: "Read the book and UPC",
      checks: [
        { kind: "text", includes: "Observed book" },
        { kind: "text", includes: "UPC 123456" },
      ],
      started_at_action: null,
      started_fingerprint: null,
      verified: null,
    },
  ];
  expect(updateProgress(steps, state, [])).toBe(1);
  expect(steps[0]!.verified?.evidence?.text).toContain("Price £14.39");
  state.read_text = undefined;
  steps[0]!.verified = null;
  expect(updateProgress(steps, state, [])).toBe(0);
});

test("navigation labels are not evidence that a section was read", () => {
  const state = page();
  state.text = "Contents\nExamples";
  state.read_text = "Contents";
  const steps: Checkpoint[] = [
    {
      instruction: "Read Examples",
      checks: [{ kind: "text", includes: "Examples" }],
      started_at_action: null,
      started_fingerprint: null,
      verified: null,
    },
  ];
  expect(updateProgress(steps, state, [])).toBe(0);
  state.read_text = "Examples\nMap each number to its square.";
  expect(updateProgress(steps, state, [])).toBe(1);
});

test("a destination with query parameters inside a redirect is not the current URL", () => {
  const state = page();
  state.url = "https://example.test/verify?next=/search?q=book";
  const steps: Checkpoint[] = [
    {
      instruction: "Reach the search results",
      checks: [{ kind: "url", includes: "/search?q=book" }],
      started_at_action: null,
      started_fingerprint: null,
      verified: null,
    },
  ];
  expect(updateProgress(steps, state, [])).toBe(0);
  state.url = "https://example.test/search?q=book&page=1";
  expect(updateProgress(steps, state, [])).toBe(1);
});

test("each goal paragraph gets its own review, current controls and a fixed date context", async () => {
  const parts = [
    "Open the search page.",
    "بعدش برای شنبه هفته بعد پرواز برلین به نیویورک رو پیدا کن.",
  ];
  const reviewed: string[] = [];
  const taskTime = new Date(2026, 9, 19, 12).toString();
  const missing = [
    {
      instruction: "Type Berlin in Search",
      checks: [{ kind: "value" as const, label: "Search", equals: "Berlin" }],
    },
  ];
  const p = provider(async (request) => {
    const body = await request.json();
    const context = JSON.parse(body.messages[1].content);
    reviewed.push(context.goal);
    expect(context.task_time).toBe(taskTime);
    expect(context.task_calendar).toContain("Saturday 2026-10-24");
    expect(context.task_calendar).toContain("Saturday 2026-10-31");
    expect(context.elements[0].label).toBe("Search");
    return context.goal === parts[0] || context.goal === parts.join("\n")
      ? completionResponse(body)
      : chatResponse({
          complete: false,
          answer: null,
          evidence: [],
          missing_steps: missing,
        });
  });
  servers.push(p.server);
  const review = await reviewCompletion(
    page(),
    parts.join("\n"),
    [],
    async () => p.endpoint,
    undefined,
    taskTime,
  );
  expect(reviewed).toEqual([parts.join("\n"), ...parts]);
  expect(review.complete).toBe(false);
  expect(review.answer).toBeNull();
  expect(review.missing_steps).toEqual(missing);
});

test("paragraph review budget retains every line and only finishes after all groups pass", async () => {
  const reviewed: string[] = [];
  const p = provider(async (request) => {
    const body = await request.json();
    reviewed.push(JSON.parse(body.messages[1].content).goal);
    return completionResponse(body);
  });
  servers.push(p.server);
  const goal = Array.from(
    { length: 12 },
    (_, index) => `Read section ${index + 1}.`,
  ).join("\n");
  const review = await reviewCompletion(
    page(),
    goal,
    [],
    async () => p.endpoint,
  );
  expect(reviewed).toHaveLength(9);
  expect(reviewed[0]).toBe(goal);
  expect(reviewed.slice(1).join("\n")).toBe(goal);
  expect(review.complete).toBe(true);
  expect(review.evidence).toHaveLength(1);
});

test("review repair receives the rejected checklist and its specific validation error", async () => {
  let calls = 0;
  const invalid = {
    complete: false,
    answer: null,
    evidence: [],
    missing_steps: [
      {
        instruction: "Click Go",
        checks: [{ kind: "action", label: "Go", action: "click" }],
      },
    ],
  };
  const p = provider(async (request) => {
    const body = await request.json();
    if (++calls === 1) return chatResponse(invalid);
    expect(body.messages.at(-2).content).toBe(JSON.stringify(invalid));
    expect(body.messages.at(-1).content).toContain("only an action check");
    return chatResponse({
      complete: false,
      answer: null,
      evidence: [],
      missing_steps: [
        {
          instruction: "Type Berlin",
          checks: [{ kind: "value", label: "Search", equals: "Berlin" }],
        },
      ],
    });
  });
  servers.push(p.server);
  const review = await reviewCompletion(
    page(),
    "Enter Berlin",
    [],
    async () => p.endpoint,
  );
  expect(calls).toBe(2);
  expect(review.complete).toBe(false);
  expect(review.missing_steps[0]!.checks[0]).toMatchObject({
    kind: "value",
    equals: "Berlin",
  });
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
    expect(body.messages[0].content).not.toContain(
      "Make a completion checklist",
    );
    expect(body.messages[0].content).not.toContain(
      "Keep already satisfied requirements",
    );
    expect(body.messages[0].content).toContain(
      "non-null verified are past runtime observations",
    );
    expect(body.messages[0].content).toContain(
      "Copy control labels verbatim from elements[].label",
    );
    expect(context.sources[1].text).toBe("Distinct earlier evidence");
    expect(
      context.checkpoints.map((step: any) => step.verified.action_count),
    ).toEqual([1, 2, 3]);
    expect(context.checkpoints[0].checks).toEqual(steps[0]!.checks);
    expect(JSON.stringify(context.checkpoints)).not.toContain("evidence");
    expect(
      context.checkpoints.every((step: any) => !("instruction" in step)),
    ).toBe(true);
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

test("review repairs fabricated quotes and treats only verified checks as proof", async () => {
  const state = page();
  state.text = "Search\nGo";
  for (const action of state.actions)
    if ("value" in action && action.node === 10) action.value = "Berlin";
  const done = checkpoints([
    { kind: "value", label: "Search", equals: "Berlin" },
  ]);
  done[0]!.instruction = "Type Berlin and click Go to search";
  expect(updateProgress(done, state, [])).toBe(1);
  const history = [{ ...click("Open Search"), url: state.url }];
  let calls = 0;
  const missing: TaskStep = {
    instruction: "Click Go to search for Berlin",
    checks: [
      { kind: "action", label: "Go", action: "click" },
      { kind: "value", label: "Search", equals: "Berlin" },
    ],
  };
  const p = provider(async (request) => {
    const body = await request.json();
    const context = JSON.parse(body.messages[1].content);
    expect(context.checkpoints[0]).not.toHaveProperty("instruction");
    expect(context.checkpoints[0].checks).toEqual(done[0]!.checks);
    expect(context.executed_actions).toEqual([
      {
        kind: "click",
        action: "Open Search",
        url: state.url,
        page_changed: true,
      },
    ]);
    expect(body.messages[0].content).toContain(
      "find its actual submit click in executed_actions",
    );
    expect(body.messages[0].content).toContain(
      "Filled values do not prove that a form was submitted",
    );
    if (++calls === 1)
      return chatResponse({
        complete: true,
        answer: "Berlin search results are displayed",
        evidence: [{ url: state.url, quote: "Search Berlin Go" }],
        missing_steps: [],
      });
    const feedback = body.messages.at(-1).content;
    expect(feedback).toContain("exact, contiguous quote");
    expect(feedback).toContain("A filled search form is not a results page");
    expect(feedback).toContain("already verified current field checks");
    return chatResponse({
      complete: false,
      answer: null,
      evidence: [],
      missing_steps: [missing],
    });
  });
  servers.push(p.server);
  const result = await reviewCompletion(
    state,
    "Search for Berlin",
    done,
    async () => p.endpoint,
    undefined,
    undefined,
    undefined,
    history,
  );
  expect(calls).toBe(2);
  expect(result.complete).toBe(false);
  expect(result.missing_steps).toEqual([missing]);
});

test("review returns an exact accessible-label quote after normalizing thousands separators", async () => {
  const state = page();
  const label = "From 1234567 rials. Flight from Berlin to New York.";
  state.actions = [
    { id: "flight", node: 20, kind: "click", role: "button", label },
  ];
  let calls = 0;
  const p = provider(() => {
    calls++;
    return chatResponse({
      complete: true,
      answer: "A flight is available.",
      evidence: [
        {
          url: state.url,
          quote: label.replace("1234567", "1,234,567"),
        },
      ],
      missing_steps: [],
    });
  });
  servers.push(p.server);
  const result = await reviewCompletion(
    state,
    "Find a flight from Berlin to New York",
    [],
    async () => p.endpoint,
  );
  expect(calls).toBe(1);
  expect(result.evidence).toEqual([{ url: state.url, quote: label }]);
});

test.each(["1,234,568", "-1,234,567", "1,234.567", "1,234,567 confirmed"])(
  "number normalization cannot invent evidence: %s",
  async (number) => {
    const state = page();
    state.text = "Total: 1234567 rials.";
    let calls = 0;
    const p = provider(() => {
      calls++;
      return chatResponse({
        complete: true,
        answer: "Found the total",
        evidence: [{ url: state.url, quote: `Total: ${number} rials.` }],
        missing_steps: [],
      });
    });
    servers.push(p.server);
    await expect(
      reviewCompletion(state, "Read the total", [], async () => p.endpoint),
    ).rejects.toThrow("exact, contiguous quote");
    expect(calls).toBe(2);
  },
);

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

test("a planner making progress can repair two distinct validation errors within three calls", async () => {
  let calls = 0;
  const state = page();
  state.url = "https://example.test/Array/map";
  state.text = "Creates a new array";
  const transport = provider(() => {
    calls++;
    return chatResponse({
      steps: [
        {
          instruction: "Read the method",
          checks: [
            {
              kind: "url",
              includes: calls === 1 ? "Array.prototype.map" : state.url,
            },
            {
              kind: "text",
              includes: calls < 3 ? "Returns a new array" : state.text,
            },
          ],
        },
      ],
    });
  });
  servers.push(transport.server);
  const result = await createPlan(
    state,
    "Read the method",
    async () => transport.endpoint,
  );
  expect(calls).toBe(3);
  expect(result.steps[0]!.checks).toContainEqual({
    kind: "text",
    includes: state.text,
  });
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
  expect(message).toContain("Chat helper model in Agent settings");
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

test.each(["combobox", "textbox"])(
  "preserves an explicit goal identifier only for an observed %s",
  (role) => {
    const state = page();
    state.actions = [
      { id: "origin", kind: "fill", node: 1, role, label: "Origin", value: "" },
    ];
    const plan = {
      steps: [
        {
          instruction: "Choose London Heathrow",
          checks: [
            { kind: "value", label: "Origin", equals: "London Heathrow" },
          ],
        },
      ],
    };
    const steps = validatePlan(
      plan,
      "From London Heathrow (LHR) to Lisbon (LIS)",
      state,
    );
    expect(steps[0]!.checks[0]).toMatchObject({
      equals: role === "combobox" ? "London Heathrow (LHR)" : "London Heathrow",
    });
  },
);

test.each(["url", "title"])(
  "field selection cannot wait for a guessed %s",
  (kind) => {
    const plan = {
      steps: [
        {
          instruction: "Select Heathrow",
          checks: [
            { kind: "value", label: "Origin", equals: "London Heathrow (LHR)" },
            { kind, includes: "LHR" },
          ],
        },
      ],
    };
    expect(() => validatePlan(plan, "Choose London Heathrow (LHR)")).toThrow(
      "mixes field state with navigation evidence",
    );
  },
);

test("action-only dropdown repair gives the complete replacement check for an explicit option", () => {
  const state = page();
  state.actions = [
    {
      id: "trip",
      kind: "click",
      node: 1,
      role: "combobox",
      label: "Trip type. Round trip",
      value: "Round trip",
    },
  ];
  const plan = {
    steps: [
      {
        instruction: "Select one way",
        checks: [
          { kind: "action", label: "Trip type. Round trip", action: "click" },
          { kind: "action", label: "One-way", action: "click" },
        ],
      },
    ],
  };
  expect(() => validatePlan(plan, "Search one-way flights", state)).toThrow(
    'Replace its ENTIRE checks array with exactly [{"kind":"value","label":"Trip type. Round trip","equals":"One-way","ref":null,"scope":null}]',
  );
  expect(() => validatePlan(plan, "Open the flights page", state)).toThrow(
    "only an action check",
  );
});

test("autocomplete rejects a guessed option click and repairs a truncated explicit identifier", () => {
  const state = page();
  state.actions = [
    {
      id: "origin",
      kind: "fill",
      node: 1,
      role: "combobox",
      label: "Origin",
      value: "",
    },
    { id: "submit", kind: "click", node: 2, role: "button", label: "Search" },
  ];
  const field = {
    kind: "value",
    label: "Origin",
    equals: "London Heathrow (LHR",
  };
  const plan = {
    steps: [
      {
        instruction: "Select Heathrow",
        checks: [
          field,
          { kind: "action", label: "London Heathrow (LHR)", action: "click" },
        ],
      },
    ],
  };
  expect(() =>
    validatePlan(plan, "Choose London Heathrow (LHR)", state),
  ).toThrow("invented option label");
  expect(field.equals).toBe("London Heathrow (LHR)");
  plan.steps[0]!.checks[1] = {
    kind: "action",
    label: "Search",
    action: "click",
  };
  expect(
    validatePlan(plan, "Choose London Heathrow (LHR) and search", state),
  ).toHaveLength(1);
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

test.each(["removed", "replaced", "date"])(
  "submission retains verified inputs after the form is %s, only after its actual click",
  (mode) => {
    const state = page();
    const value = mode === "date" ? "2026-12-03" : "Lisbon";
    Object.assign(state.actions[0]!, {
      ref: "fixture-document:10",
      value: mode === "date" ? "Thu, Dec 3" : value,
      value_date: mode === "date" ? value : undefined,
    });
    const field: CompletionCheck = {
      kind: "value",
      label: "Search",
      equals: value,
      ref: "fixture-document:10",
    };
    const steps = checkpoints(
      [field],
      [{ kind: "action", label: "Go", action: "click" }, { ...field }],
    );
    const history: HistoryEntry[] = [];
    expect(updateProgress(steps, state, history)).toBe(1);
    if (mode === "removed") state.actions = [];
    else {
      state.actions = [state.actions[0]!];
      Object.assign(state.actions[0]!, {
        ref: "fixture-document:30",
        value_date: undefined,
      });
    }
    state.fingerprint = "results";
    expect(updateProgress(steps, state, history)).toBe(1);
    history.push(click("Go"));
    expect(updateProgress(steps, state, history)).toBe(2);
  },
);

test.each(["value", "scope", "ref"])(
  "submission cannot borrow a different verified %s",
  (mismatch) => {
    const state = page();
    Object.assign(state.actions[0]!, {
      value: "Lisbon",
      ref: "fixture-document:10",
    });
    const field: CompletionCheck = {
      kind: "value",
      label: "Search",
      equals: "Lisbon",
      ref: "fixture-document:10",
    };
    const requested = { ...field };
    if (mismatch === "value") requested.equals = "Berlin";
    if (mismatch === "scope") requested.scope = "Another form";
    if (mismatch === "ref") requested.ref = "fixture-document:99";
    const steps = checkpoints(
      [field],
      [{ kind: "action", label: "Go", action: "click" }, requested],
    );
    expect(updateProgress(steps, state, [])).toBe(1);
    state.actions = [];
    state.fingerprint = "results";
    expect(updateProgress(steps, state, [click("Go")])).toBe(1);
    expect(steps[1]!.verified).toBeNull();
  },
);

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

test("scoped checks retain matching replacements and reopen only a changed value", () => {
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
  expect(updateProgress(steps, state, [])).toBe(2);
  Object.assign(state.actions[0]!, { value: "Carol" });
  expect(updateProgress(steps, state, [])).toBe(0);
});

test("a replacement short date retains verified year evidence but never creates or overrides it", () => {
  const state = page();
  state.actions = [
    {
      id: "date",
      node: 1,
      ref: "fixture-document:1",
      kind: "fill",
      role: "textbox",
      label: "Departure",
      value: "Sat, Oct 24",
      value_date: "2026-10-24",
    },
  ];
  const step = () =>
    checkpoints([
      {
        kind: "value",
        label: "Departure",
        ref: "fixture-document:1",
        equals: "2026-10-24",
      },
    ]);
  const verified = step();
  expect(updateProgress(verified, state, [])).toBe(1);
  Object.assign(state.actions[0]!, {
    ref: "fixture-document:2",
    value_date: undefined,
  });
  state.url += "search";
  expect(updateProgress(verified, state, [])).toBe(1);
  expect(updateProgress(step(), state, [])).toBe(0);
  Object.assign(state.actions[0]!, { value_date: "2027-10-24" });
  expect(updateProgress(verified, state, [])).toBe(0);
});

test.each([true, false])(
  "completion review repairs repeated verified steps but never infers success: confirmed=%s",
  async (confirmed) => {
    const state = page();
    const done = checkpoints([{ kind: "title", includes: state.title }]);
    expect(updateProgress(done, state, [])).toBe(1);
    let calls = 0;
    const p = provider(async (request) => {
      const body = await request.json();
      calls++;
      if (calls === 2) {
        expect(body.messages[2].role).toBe("assistant");
        expect(body.messages[3].content).toContain(
          "already has verified runtime evidence",
        );
        if (confirmed) return completionResponse(body);
      }
      return chatResponse({
        complete: false,
        answer: null,
        evidence: [],
        missing_steps: [
          {
            instruction: "Open page",
            checks: [{ kind: "title", includes: state.title }],
          },
        ],
      });
    });
    servers.push(p.server);
    const result = await reviewCompletion(
      state,
      "Open the page",
      done,
      async () => p.endpoint,
    );
    expect(calls).toBe(2);
    expect(result.complete).toBe(confirmed);
    expect(result.missing_steps).toEqual([]);
    if (!confirmed) expect(result.answer).toBeNull();
  },
);

test("completion repair retains identical values requested in different form scopes", async () => {
  const state = page();
  state.actions = ["Sender", "Recipient"].map((scope, index) => ({
    id: `name-${index}`,
    node: index,
    kind: "fill" as const,
    role: "textbox",
    label: "Name",
    scope,
    value: index === 0 ? "Alice" : "Bob",
  }));
  const done = checkpoints([
    { kind: "value", label: "Name", equals: "Alice", scope: "Sender" },
  ]);
  expect(updateProgress(done, state, [])).toBe(1);
  const missing = {
    instruction: "Set recipient name",
    checks: [
      { kind: "value", label: "Name", equals: "Alice", scope: "Recipient" },
    ],
  };
  const p = provider(() =>
    chatResponse({
      complete: false,
      answer: null,
      evidence: [],
      missing_steps: [missing],
    }),
  );
  servers.push(p.server);
  const result = await reviewCompletion(
    state,
    "Set both names to Alice",
    done,
    async () => p.endpoint,
  );
  expect(result.complete).toBe(false);
  expect(result.missing_steps).toHaveLength(1);
  expect(result.missing_steps[0]!.checks[0]).toMatchObject({
    scope: "Recipient",
  });
});

test.each(["length", "json"])(
  "completion repair excludes corrupt output from the next request: %s",
  async (mode) => {
    let calls = 0;
    const p = provider(async (request) => {
      const body = await request.json();
      calls++;
      if (calls === 1)
        return Response.json({
          choices: [
            {
              finish_reason: mode === "length" ? "length" : "stop",
              message: { content: "repeated-corrupt-output".repeat(100) },
            },
          ],
        });
      expect(body.messages[2].content).toBe(
        mode === "length" ? "Incomplete completion review" : "Invalid JSON",
      );
      expect(JSON.stringify(body)).not.toContain("repeated-corrupt-output");
      return completionResponse(body);
    });
    servers.push(p.server);
    expect(
      (
        await reviewCompletion(
          page(),
          "Read the page",
          [],
          async () => p.endpoint,
        )
      ).complete,
    ).toBe(true);
    expect(calls).toBe(2);
  },
);

test.each([false, true])(
  "review repair supplies only previously verified values still present in the form: changed=%s",
  async (changed) => {
    const state = page();
    Object.assign(state.actions[0]!, {
      ref: "fixture-document:1",
      value: "Lisbon",
    });
    const done = checkpoints([
      {
        kind: "value",
        label: "Search",
        equals: "Lisbon",
        ref: "fixture-document:1",
      },
    ]);
    expect(updateProgress(done, state, [])).toBe(1);
    if (changed) Object.assign(state.actions[0]!, { value: "Porto" });
    let calls = 0;
    const p = provider(async (request) => {
      const body = await request.json();
      calls++;
      if (calls === 2) {
        expect(
          body.messages[3].content.includes(
            "already verified current field checks",
          ),
        ).toBe(!changed);
        if (!changed)
          expect(body.messages[3].content).toContain(
            JSON.stringify([
              { kind: "value", label: "Search", equals: "Lisbon", ref: null },
            ]),
          );
      }
      return chatResponse({
        complete: false,
        answer: null,
        evidence: [],
        missing_steps: [
          {
            instruction: "Open results",
            checks: [
              { kind: "action", label: "Go", action: "click" },
              { kind: "url", includes: calls === 1 ? "q=Lisbon" : "/results" },
            ],
          },
        ],
      });
    });
    servers.push(p.server);
    const result = await reviewCompletion(
      state,
      "Find Lisbon",
      done,
      async () => p.endpoint,
    );
    expect(calls).toBe(2);
    expect(result.complete).toBe(false);
    expect(result.missing_steps[0]!.checks[1]).toEqual({
      kind: "url",
      includes: "/results",
    });
  },
);

test.each(["click", "fill"] as const)(
  "completion repair normalizes display-only dropdowns without changing editable values: %s",
  async (kind) => {
    const state = page();
    state.actions = [
      {
        id: "type",
        node: 1,
        ref: "fixture-document:1",
        kind,
        role: "combobox",
        label: "Ticket type",
        value: "One-way",
      },
    ];
    const done = checkpoints([
      {
        kind: "value",
        label: "Ticket type",
        equals: "One-way",
        ref: "fixture-document:1",
        scope: null,
      },
    ]);
    expect(updateProgress(done, state, [])).toBe(1);
    const missing: TaskStep[] = [
      {
        instruction: "Choose one way",
        checks: [
          { kind: "value", label: "Ticket type", equals: "One way", ref: null },
        ],
      },
      {
        instruction: "Open results",
        checks: [{ kind: "title", includes: "Results" }],
      },
    ];
    const p = provider(() =>
      chatResponse({
        complete: false,
        answer: null,
        evidence: [],
        missing_steps: missing,
      }),
    );
    servers.push(p.server);
    const result = await reviewCompletion(
      state,
      "Find one way flights and open results",
      done,
      async () => p.endpoint,
    );
    expect(result.complete).toBe(false);
    expect(result.missing_steps).toEqual(
      kind === "click" ? missing.slice(1) : missing,
    );
  },
);

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
  for (const includes of ["tfs=", "+flights", "?q=flights", "&hl=en"]) {
    plan.steps[0]!.checks[1] = { kind: "url", includes };
    expect(() => validatePlan(plan, "Find flights", page())).toThrow(
      "query-only URL fragment",
    );
  }
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

test("translation preserves English requirements and resolves the entire Persian paragraph separately", async () => {
  const { interpretGoal } = await import("../src/plan");
  const input =
    "Reject optional cookies.\nبرای شنبه آینده از برلین به نیویورک برای یک نفر پرواز پیدا کن.";
  let calls = 0;
  const p = provider(async (request) => {
    calls++;
    const body = await request.json();
    const context = JSON.parse(body.messages[1].content);
    expect(context.requirement).toBe(input.split("\n")[1]);
    expect(context.task_calendar).toContain("Saturday 2026-10-24");
    return chatResponse({
      translation:
        "Find one-way flights from Berlin to New York for one passenger on 2026-10-24.",
    });
  });
  servers.push(p.server);
  const result = await interpretGoal(
    input,
    async () => p.endpoint,
    undefined,
    new Date(2026, 9, 19, 12).toString(),
  );
  expect(result).toBe(
    "Reject optional cookies.\nFind one-way flights from Berlin to New York for one passenger on 2026-10-24.",
  );
  expect(
    await interpretGoal("Find Gödel's article.", async () => p.endpoint),
  ).toBe("Find Gödel's article.");
  expect(calls).toBe(1);
});

test("repair gives an exact observation check for an already displayed button state", async () => {
  const state = page();
  state.text = "1 passenger";
  state.actions = [
    {
      id: "passengers",
      kind: "click",
      node: 1,
      role: "button",
      label: "1 passenger",
    },
  ];
  let calls = 0;
  const p = provider(async (request) => {
    const body = await request.json();
    calls++;
    if (calls === 2)
      expect(body.messages.at(-1).content).toContain(
        '{"kind":"text","includes":"1 passenger"}',
      );
    return chatResponse({
      steps: [
        {
          instruction: "Verify one passenger",
          checks: [
            calls === 1
              ? { kind: "value", label: "1 passenger", equals: "1 passenger" }
              : { kind: "text", includes: "1 passenger" },
          ],
        },
      ],
    });
  });
  servers.push(p.server);
  const result = await createPlan(
    state,
    "Find a flight for one person",
    async () => p.endpoint,
  );
  expect(calls).toBe(2);
  expect(result.steps[0]!.checks).toEqual([
    { kind: "text", includes: "1 passenger" },
  ]);
  expect(() =>
    validatePlan(
      {
        steps: [
          {
            instruction: "Set two passengers",
            checks: [
              { kind: "value", label: "1 passenger", equals: "2 passengers" },
            ],
          },
        ],
      },
      "Two passengers",
      state,
    ),
  ).toThrow("wrong check kind");
});

test("standalone text checks require observed or explicitly requested text", () => {
  const state = page();
  state.text = "1 passenger, change number of passengers.";
  const plan = (text: string) => ({
    steps: [
      {
        instruction: "Verify passenger count",
        checks: [{ kind: "text", includes: text }],
      },
    ],
  });
  expect(() =>
    validatePlan(
      plan("1 passenger, change number of passengers.1 passenger"),
      "Find a flight for one person",
      state,
    ),
  ).toThrow("unobserved text");
  expect(
    validatePlan(plan("1 passenger"), "Find a flight for one person", state),
  ).toHaveLength(1);
  expect(
    validatePlan(plan("Ready"), 'Wait until the page says "Ready"', state),
  ).toHaveLength(1);
});

test.each(["One way", "One-way"])(
  "custom dropdown values use their bound identity and remain pending while open: %s",
  (equals) => {
    const state = page();
    state.actions = [
      {
        id: "trip",
        node: 1,
        ref: "fixture-document:1",
        kind: "click",
        role: "combobox",
        label: "Ticket type. Round trip",
        value: "Round trip",
        expanded: "false",
      },
    ];
    const steps = validatePlan(
      {
        steps: [
          {
            instruction: "Choose One way",
            checks: [
              {
                kind: "value",
                label: "Ticket type. Round trip",
                equals,
                ref: "fixture-document:1",
              },
            ],
          },
        ],
      },
      "Choose One way",
      state,
    );
    const checkpoints: Checkpoint[] = steps.map((step) => ({
      ...step,
      started_at_action: null,
      started_fingerprint: null,
      verified: null,
    }));
    expect(updateProgress(checkpoints, state, [])).toBe(0);
    state.actions[0] = {
      ...state.actions[0]!,
      kind: "click",
      node: 1,
      role: "combobox",
      label: "Ticket type. One way",
      value: "One way",
      expanded: "true",
    };
    expect(updateProgress(checkpoints, state, [])).toBe(0);
    state.actions[0].expanded = "false";
    state.actions.push({
      id: "option",
      node: 2,
      ref: "fixture-document:2",
      popup_owner: "fixture-document:1",
      kind: "click",
      role: "option",
      label: "One way",
    });
    expect(updateProgress(checkpoints, state, [])).toBe(0);
    state.actions.pop();
    expect(updateProgress(checkpoints, state, [])).toBe(1);
  },
);

test("autocomplete identifiers must be displayed by the closed bound control", () => {
  const state = page();
  const field = {
    id: "origin",
    node: 1,
    ref: "fixture-document:1",
    kind: "fill" as const,
    role: "combobox",
    label: "Where from? London LHR",
    value: "London",
    expanded: "false",
  };
  state.actions = [field];
  const checkpoints: Checkpoint[] = [
    {
      instruction: "Select London Heathrow (LHR)",
      checks: [
        {
          kind: "value",
          label: "Where from?",
          ref: field.ref,
          equals: "London Heathrow (LHR)",
        },
      ],
      started_at_action: null,
      started_fingerprint: null,
      verified: null,
    },
  ];
  for (const label of [
    "Where from? London LCY",
    "Where from? London LHRX",
    "Where from?",
  ]) {
    field.label = label;
    expect(updateProgress(checkpoints, state, [])).toBe(0);
  }
  field.label = "Where from? London LHR";
  field.expanded = "true";
  expect(updateProgress(checkpoints, state, [])).toBe(0);
  field.expanded = "false";
  state.actions.push({
    id: "option",
    node: 2,
    popup_owner: field.ref,
    kind: "click",
    role: "option",
    label: "Heathrow Airport (LHR)",
  });
  expect(updateProgress(checkpoints, state, [])).toBe(0);
  state.actions.pop();
  expect(updateProgress(checkpoints, state, [])).toBe(1);
  field.label = "Where from? London LCY";
  expect(updateProgress(checkpoints, state, [])).toBe(0);
});

test("a dropdown opening click cannot hide an invented value-control label", async () => {
  const state = page();
  state.actions = [
    {
      id: "trip",
      node: 1,
      kind: "click",
      role: "combobox",
      label: "Change ticket type. Round trip",
      value: "Round trip",
    },
  ];
  let calls = 0;
  const corrected = {
    kind: "value" as const,
    label: "Change ticket type. Round trip",
    equals: "One-way",
    ref: null,
    scope: null,
  };
  const p = provider(async (request) => {
    const body = await request.json();
    calls++;
    if (calls === 2)
      expect(body.messages.at(-1).content).toContain(
        JSON.stringify([corrected]),
      );
    return chatResponse({
      steps: [
        {
          instruction: "Select a one-way flight",
          checks:
            calls === 1
              ? [
                  {
                    kind: "action",
                    label: "Change ticket type. Round trip",
                    action: "click",
                  },
                  { kind: "value", label: "Trip type", equals: "One-way" },
                ]
              : [corrected],
        },
      ],
    });
  });
  servers.push(p.server);
  const result = await createPlan(
    state,
    "Search one-way flights",
    async () => p.endpoint,
  );
  expect(calls).toBe(2);
  expect(result.steps[0]!.checks).toEqual([corrected]);
});

test("a failed future step preserves its validated prefix and the error for continuation", async () => {
  const p = provider(() =>
    chatResponse({
      steps: [
        {
          instruction: "Enter Berlin",
          checks: [{ kind: "value", label: "Search", equals: "Berlin" }],
        },
        {
          instruction: "Submit",
          checks: [{ kind: "action", label: "Go", action: "click" }],
        },
      ],
    }),
  );
  servers.push(p.server);
  const result = await createPlan(
    page(),
    "Search Berlin and open the result",
    async () => p.endpoint,
  );
  expect(result.calls).toHaveLength(1);
  expect(result.steps).toHaveLength(1);
  expect(result.continuation).toContain("only an action check");
  expect(result.steps[0]!.checks).toEqual([
    { kind: "value", label: "Search", equals: "Berlin" },
  ]);
});

test("an invalid future flight checklist executes only its grounded consent step", async () => {
  const consent: TaskStep = {
    instruction: "Reject optional cookies",
    checks: [
      { kind: "action", label: "Reject all", action: "click" },
      { kind: "url", includes: "google.com/travel/flights" },
    ],
  };
  const p = provider(() =>
    chatResponse({
      steps: [
        consent,
        {
          instruction: "Select one way",
          checks: [{ kind: "value", label: "Trip type", equals: "One-way" }],
        },
        {
          instruction: "Search flights",
          checks: [
            { kind: "action", label: "Search", action: "click" },
            { kind: "text", includes: "One-way flights from London to Lisbon" },
          ],
        },
      ],
    }),
  );
  servers.push(p.server);
  const result = await createPlan(
    {
      ...page(),
      url: "https://consent.google.com/m?continue=https://www.google.com/travel/flights",
      text: "Before you continue to Google",
      actions: [
        {
          id: "reject",
          node: 1,
          label: "Reject all",
          role: "button",
          kind: "click",
          value: "",
        },
      ],
    },
    "Reject optional cookies. Search one-way LHR to LIS flights.",
    async () => p.endpoint,
  );
  expect(result.calls).toHaveLength(1);
  expect(result.steps).toEqual([consent]);
});

test.each([
  "next Saturday, 2026-10-25",
  "next week on Saturday",
  "next week Saturday",
])(
  "relative weekday translation uses calendar arithmetic: %s",
  async (relative) => {
    const { interpretGoal } = await import("../src/plan");
    const p = provider(() =>
      chatResponse({ translation: `Travel ${relative}.` }),
    );
    servers.push(p.server);
    expect(
      await interpretGoal(
        "شنبه آینده",
        async () => p.endpoint,
        undefined,
        new Date(2026, 9, 19, 12).toString(),
      ),
    ).toBe("Travel Saturday 2026-10-24.");
    expect(
      await interpretGoal(
        "شنبه آینده",
        async () => p.endpoint,
        undefined,
        new Date(2026, 9, 24, 12).toString(),
      ),
    ).toBe("Travel Saturday 2026-10-31.");
  },
);

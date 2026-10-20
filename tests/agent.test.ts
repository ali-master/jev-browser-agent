import { afterEach, expect, mock, test } from "bun:test";
import { Agent } from "../src/agent";
import { StalePage, fingerprint } from "../src/browser";
import {
  chatResponse,
  completionResponse,
  decisionResponse,
  offeredTargets,
  page,
  provider,
} from "./helpers";
import type { Action, DecisionRequest, TaskStep } from "../src/types";

const servers: Bun.Server<undefined>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

function runner(
  operation = "TYPE_TEXT",
  target = "1",
  maxSteps = 60,
  steps: TaskStep[] = [
    {
      instruction: "Find hotels in Lisbon",
      checks: [{ kind: "title", includes: "Completed" }],
    },
  ],
) {
  let textCalls = 0;
  const transport = provider(async (request) => {
    if (new URL(request.url).pathname.endsWith("chat/completions")) {
      const body = await request.json();
      if (body.response_format?.json_schema?.name === "completion_review")
        return completionResponse(body);
      if (body.messages[0].content.includes("completion checklist"))
        return chatResponse({ steps });
      textCalls++;
      return chatResponse({ text: "Lisbon" });
    }
    const body = (await request.json()) as DecisionRequest;
    const targets = offeredTargets(body, operation);
    return Response.json(
      decisionResponse(
        body,
        operation,
        target in targets ? target : (Object.keys(targets)[0] ?? target),
      ),
    );
  });
  servers.push(transport.server);
  const state = page();
  const driver = {
    fresh: mock(async () => true),
    observe: mock(async () => structuredClone(state)),
    act: mock(async (_action: Action): Promise<void | "popup_opened"> => {}),
    close: mock(async () => {}),
  };
  const agent = new Agent(driver, state, "Find hotels in Lisbon", {
    settings: async () => transport.settings,
    maxSteps,
  });
  return {
    agent,
    driver,
    settings: transport.settings,
    textCalls: () => textCalls,
  };
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

test("an apparent navigation link revealing the next target is replanned without waiting or replaying it", async () => {
  const state = page();
  state.actions = [
    { id: "menu", node: 1, kind: "click", role: "link", label: "Topics" },
  ];
  const destination: TaskStep = {
    instruction: "Open Venus",
    checks: [
      { kind: "action", label: "Venus", action: "click" },
      { kind: "url", includes: "/venus" },
    ],
  };
  let plans = 0;
  const transport = provider(async (request) => {
    const body = await request.json();
    if (new URL(request.url).pathname.endsWith("chat/completions")) {
      plans++;
      if (plans === 2)
        expect(JSON.parse(body.messages[1].content).progress.reason).toContain(
          "revealed",
        );
      return chatResponse({
        steps:
          plans === 1
            ? [
                {
                  instruction: "Open Topics",
                  checks: [
                    { kind: "action", label: "Topics", action: "click" },
                    { kind: "url", includes: "/topics" },
                  ],
                },
                destination,
              ]
            : [destination],
      });
    }
    return Response.json(decisionResponse(body, "CLICK", "1"));
  });
  servers.push(transport.server);
  const agent = new Agent(
    {
      fresh: async () => true,
      observe: async () => structuredClone(state),
      close: async () => {},
      act: async () => {
        state.fingerprint = "menu-opened";
        state.text = "Venus";
        state.actions = [
          {
            id: "venus",
            node: 2,
            kind: "click",
            role: "link",
            label: "Venus",
            href: "https://example.test/venus",
          },
        ];
      },
    },
    structuredClone(state),
    "Open Venus",
    { settings: async () => transport.settings },
  );
  await agent.command("tick");
  await agent.command("predict");
  expect(plans).toBe(2);
  expect(agent.state.history.map((entry) => entry.action)).toEqual(["Topics"]);
  expect(agent.state.decision?.choice).toBe("venus");
});

test("an exact observed destination resolves a shortened link label without matching a longer ID", async () => {
  const { agent } = runner("CLICK", "1", 60, [
    {
      instruction: "Open the requested book",
      checks: [
        { kind: "action", label: "Book title", action: "click" },
        { kind: "url", includes: "/books/42" },
      ],
    },
  ]);
  agent.state.page.actions = [
    {
      id: "book",
      kind: "click",
      node: 2,
      ref: "fixture-document:2",
      role: "link",
      label: "Book title Author 100 downloads",
      href: "https://example.test/books/42",
    },
    {
      id: "other",
      kind: "click",
      node: 3,
      ref: "fixture-document:3",
      role: "link",
      label: "Another book",
      href: "https://example.test/books/420",
    },
  ];
  await agent.command("predict");
  expect(agent.state.decision?.choice).toBe("book");
  expect(agent.state.checkpoints[0]!.checks[0]).toMatchObject({
    label: "Book title Author 100 downloads",
    ref: "fixture-document:2",
  });
});

test("navigation retains actually read text independently of checkpoint evidence", async () => {
  const { agent, driver } = runner("CLICK", "1", 60, [
    {
      instruction: "Open the next article",
      checks: [
        { kind: "action", label: "Next", action: "click" },
        { kind: "url", includes: "/next" },
      ],
    },
  ]);
  agent.state.page.read_text = "Fact read after the first checkpoint.";
  agent.state.page.actions = [
    { id: "next", kind: "click", node: 1, role: "link", label: "Next" },
  ];
  driver.observe.mockResolvedValue({
    ...page(),
    url: "https://example.test/next",
    fingerprint: "next",
  });
  await agent.command("tick");
  expect(agent.snapshot().read_sources).toEqual([
    {
      url: "https://example.test/",
      title: "Search",
      text: "Fact read after the first checkpoint.",
    },
  ]);
});

test.each([
  ["#casa-flora", "done"],
  ["#casa-flora-other", "ready"],
  ["?next=casa-flora", "ready"],
] as const)(
  "checks a button's destination against the actual fragment: %s",
  async (suffix, status) => {
    const { agent, driver } = runner("CLICK", "1", 60, [
      {
        instruction: "Open the stay",
        checks: [
          { kind: "action", label: "View Casa Flora", action: "click" },
          { kind: "url", includes: "casa-flora" },
        ],
      },
    ]);
    agent.state.page.actions = [
      {
        id: "stay",
        kind: "click",
        node: 1,
        ref: "fixture-document:1",
        role: "button",
        label: "View Casa Flora",
      },
    ];
    driver.observe.mockResolvedValue({
      ...page(),
      url: `https://example.test/${suffix}`,
      title: "Casa Flora",
      fingerprint: "details",
      actions: [],
    });
    await agent.command("tick");
    expect(agent.state.checkpoints[0]!.checks[1]).toEqual({
      kind: "url",
      includes: "casa-flora",
    });
    expect(agent.state.history).toHaveLength(1);
    expect(agent.state.status).toBe(status);
  },
);

test("a field that opens a picker records only its actual click, not an unexecuted fill", async () => {
  const { agent, driver } = runner();
  driver.act.mockResolvedValue("popup_opened");
  await agent.command("tick");
  expect(agent.state.history).toHaveLength(1);
  expect(agent.state.history[0]).toMatchObject({
    kind: "click",
    operation: "CLICK",
    text: null,
  });
  expect(driver.act).toHaveBeenCalledTimes(1);
  expect(agent.state.status).not.toBe("done");
});

test("an invented control at the scroll boundary is repaired with actual labels", async () => {
  let planning = 0;
  const transport = provider(async (request) => {
    const body = await request.json();
    if (new URL(request.url).pathname.endsWith("chat/completions")) {
      planning++;
      if (planning === 2)
        expect(JSON.parse(body.messages[1].content).progress.reason).toContain(
          "page boundary",
        );
      return chatResponse({
        steps: [
          {
            instruction: "Dismiss the notice",
            checks: [
              {
                kind: "action",
                label: planning === 1 ? "Dismiss" : "Reject all",
                action: "click",
              },
              { kind: "url", includes: "/search" },
            ],
          },
        ],
      });
    }
    return Response.json(
      decisionResponse(
        body,
        body.questions.operation.criteria.CLICK ? "CLICK" : "SCROLL_DOWN",
        "1",
      ),
    );
  });
  servers.push(transport.server);
  const state = page();
  state.scroll.height = 1200;
  state.actions = [
    { id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 600 },
  ];
  const driver = {
    fresh: async () => true,
    observe: async () => structuredClone(state),
    close: async () => {},
    act: async () => {
      state.scroll.y = state.scroll.height - state.h;
      state.actions = [
        {
          id: "reject",
          kind: "click",
          node: 1,
          ref: "fixture-document:1",
          role: "button",
          label: "Reject all",
        },
      ];
    },
  };
  const agent = new Agent(
    driver,
    structuredClone(state),
    "Reject optional cookies and open search",
    { settings: async () => transport.settings },
  );
  await agent.command("tick");
  await agent.command("predict");
  expect(planning).toBe(2);
  expect(agent.state.decision?.choice).toBe("reject");
  expect(agent.state.history).toHaveLength(1);
});

test("an invented reading heading is repaired at the scroll boundary using observed text", async () => {
  let planning = 0;
  const transport = provider(async (request) => {
    const body = await request.json();
    if (body.response_format?.json_schema?.name === "completion_review")
      return completionResponse(body);
    if (body.messages) {
      planning++;
      if (planning === 2)
        expect(JSON.parse(body.messages[1].content).page.text).toContain(
          "Observed book",
        );
      return chatResponse({
        steps: [
          {
            instruction: "Read the full title",
            checks: [
              {
                kind: "text",
                includes: planning === 1 ? "Full Title" : "Observed book",
              },
            ],
          },
        ],
      });
    }
    return Response.json(decisionResponse(body, "SCROLL_DOWN"));
  });
  servers.push(transport.server);
  const state = page();
  state.scroll.height = 1200;
  state.actions = [
    { id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 600 },
  ];
  const agent = new Agent(
    {
      fresh: async () => true,
      observe: async () => structuredClone(state),
      close: async () => {},
      act: async () => {
        state.scroll.y = state.scroll.height - state.h;
        state.read_text = "Observed book";
        state.text = "Product information";
      },
    },
    structuredClone(state),
    "Read the Full Title",
    { settings: async () => transport.settings },
  );
  await agent.command("tick");
  await agent.command("predict");
  expect(planning).toBe(2);
  expect(agent.state.status).toBe("done");
  expect(agent.state.history).toHaveLength(1);
});

test.each([false, true])(
  "outcome repair retains an executed click only for unchanged inputs: changed=%s",
  async (changed) => {
    let planning = 0,
      clicks = 0;
    const state = page();
    Object.assign(state.actions[0]!, { value: "Porto" });
    const transport = provider(async (request) => {
      const body = await request.json();
      if (new URL(request.url).pathname.endsWith("chat/completions")) {
        if (body.response_format?.json_schema?.name === "completion_review")
          return completionResponse(body);
        planning++;
        return chatResponse({
          steps: [
            {
              instruction: "Open results",
              checks: [
                { kind: "action", label: "Go", action: "click" },
                {
                  kind: "url",
                  includes: planning === 1 ? "/incorrect" : "/results",
                },
                ...(changed
                  ? [
                      {
                        kind: "value",
                        label: "Search",
                        equals: planning === 1 ? "Porto" : "Lisbon",
                      },
                    ]
                  : []),
              ],
            },
          ],
        });
      }
      return Response.json(
        decisionResponse(
          body,
          changed && state.url.endsWith("/results") && planning === 1
            ? "WAIT"
            : body.questions.operation.criteria.CLICK
              ? "CLICK"
              : "WAIT",
          "2",
        ),
      );
    });
    servers.push(transport.server);
    const agent = new Agent(
      {
        fresh: async () => true,
        observe: async () => structuredClone(state),
        close: async () => {},
        act: async (action) => {
          if (action.kind === "click") {
            clicks++;
            state.url = "https://example.test/results";
            state.fingerprint = "results";
            if (changed) Object.assign(state.actions[0]!, { value: "Lisbon" });
            else state.actions = [{ id: "wait", kind: "wait", label: "Wait" }];
          }
        },
      },
      structuredClone(state),
      "Open the results",
      { settings: async () => transport.settings, maxSteps: 8 },
    );
    for (let i = 0; i < 4; i++) await agent.command("tick");
    await agent.command("predict");
    expect(agent.state.status).toBe(changed ? "predicted" : "done");
    expect(clicks).toBe(1);
    expect(planning).toBe(2);
    expect(
      agent.state.history.filter((entry) => entry.kind === "click"),
    ).toHaveLength(1);
  },
);

test.each(["explicit", "substring", "unbound", "password", "ambiguous"])(
  "reuse field text only for a uniquely bound explicit value: %s",
  async (mode) => {
    const check = {
      kind: "value" as const,
      label: "Search",
      equals: mode === "substring" ? "Lis" : "Lisbon",
    };
    const { agent, driver, textCalls } = runner("TYPE_TEXT", "1", 60, [
      {
        instruction: "Enter city",
        checks: mode === "ambiguous" ? [check, { ...check }] : [check],
      },
    ]);
    if (mode !== "unbound")
      Object.assign(agent.state.page.actions[0]!, {
        ref: "fixture-document:10",
      });
    if (mode === "password")
      Object.assign(agent.state.page.actions[0]!, { input_type: "password" });
    await agent.command("tick");
    expect(textCalls()).toBe(mode === "explicit" ? 0 : 1);
    expect(driver.act).toHaveBeenCalledTimes(1);
    expect(agent.state.history[0]!.text).toBe("Lisbon");
    if (mode === "explicit") {
      expect(agent.state.history[0]!.text_helper).toBeNull();
      expect(agent.state.model_calls.map((call) => call.role)).toEqual([
        "planning",
        "decision",
      ]);
    }
  },
);

test("direct field reuse searches a combobox by the user-provided identifier", async () => {
  const { agent, textCalls } = runner("TYPE_TEXT", "1", 60, [
    {
      instruction: "Select Lisbon (LIS)",
      checks: [{ kind: "value", label: "Search", equals: "Lisbon (LIS)" }],
    },
  ]);
  agent.state.goal = "Choose Lisbon (LIS)";
  Object.assign(agent.state.page.actions[0]!, {
    ref: "fixture-document:10",
    role: "combobox",
  });
  await agent.command("tick");
  expect(agent.state.history[0]!.text).toBe("LIS");
  expect(textCalls()).toBe(0);
});

test("only the active step binds a control identity from the current document", async () => {
  const steps: TaskStep[] = ["Lisbon", "Porto"].map((value) => ({
    instruction: `Enter ${value} in Search`,
    checks: [
      { kind: "value", label: "Search", equals: value, ref: null, scope: null },
    ],
  }));
  const { agent } = runner("TYPE_TEXT", "1", 60, steps);
  Object.assign(agent.state.page.actions[0]!, {
    ref: "fixture-document:10",
    scope: "Search form",
  });
  await agent.command("predict");
  expect(agent.state.checkpoints[0]!.checks[0]).toMatchObject({
    ref: "fixture-document:10",
    scope: "Search form",
  });
  expect(agent.state.checkpoints[1]!.checks[0]).toMatchObject({ ref: null });
  expect(steps[0]!.checks[0]).toMatchObject({ ref: null });
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
    if (change === "node")
      Object.assign(agent.state.page.actions[0]!, { node: 90 });
    if (change === "document") agent.state.page.document_id = "new-document";
    if (change === "url") agent.state.page.url = "https://example.test/other";
    await agent.command("tick");
    expect(textCalls()).toBe(change === "identical" ? 1 : 2);
    expect(agent.state.history).toHaveLength(1);
    expect(JSON.stringify(agent.snapshot())).not.toContain("changed-local-key");
  },
);

test.each(["act", "tick"] as const)(
  "%s recovers post-action observation without replaying the click",
  async (command) => {
    const { agent, driver } = runner("CLICK", "2");
    if (command === "act") await agent.command("predict");
    driver.observe.mockImplementationOnce(async () => {
      expect(agent.state.history).toHaveLength(1);
      throw new StalePage("Document changed after click");
    });
    await agent.command(command, { fingerprint: agent.state.page.fingerprint });
    expect(driver.act).toHaveBeenCalledTimes(1);
    expect(agent.state.history[0]!.action).toBe("Go");
    expect(agent.state.history[0]!.page_changed).toBe(false);
    expect(agent.state.decision).toBeNull();
  },
);

test("act refreshes through late hydration before verifying the executed click", async () => {
  const { agent, driver } = runner("CLICK", "2", 60, [
    {
      instruction: "Open the completed page",
      checks: [
        { kind: "action", label: "Go", action: "click" },
        { kind: "title", includes: "Completed" },
      ],
    },
  ]);
  await agent.command("predict");
  driver.observe.mockResolvedValue({
    ...page(),
    title: "Completed",
    fingerprint: "destination",
  });
  driver.fresh.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
  await agent.command("act", { fingerprint: agent.state.page.fingerprint });
  expect(agent.state.status).toBe("done");
  expect(agent.state.checkpoints[0]!.verified?.fingerprint).toBe("destination");
  expect(driver.observe).toHaveBeenCalledTimes(3);
  expect(driver.act).toHaveBeenCalledTimes(1);
  expect(agent.state.history).toHaveLength(1);
});

test("an uncertain browser mutation fails closed without automatic retry", async () => {
  const { agent, driver } = runner("CLICK", "2");
  driver.act.mockRejectedValueOnce(
    new Error("Connection lost after mouse press"),
  );
  await expect(agent.command("tick")).rejects.toThrow("Connection lost");
  expect(agent.state.status).toBe("error");
  await expect(agent.command("tick")).rejects.toThrow("stopped");
  expect(driver.act).toHaveBeenCalledTimes(1);
});

test.each(["predict", "tick"] as const)(
  "%s only reobserves a navigation during prediction",
  async (command) => {
    const { agent, driver } = runner();
    driver.fresh.mockRejectedValueOnce(new StalePage("Navigating"));
    await agent.command(command);
    expect(driver.act).not.toHaveBeenCalled();
    expect(agent.state.decisions).toHaveLength(0);
    expect(agent.state.status).toBe("ready");
  },
);

test("a permanently loading page stops after three unchanged waits, not sixty", async () => {
  const { agent, driver } = runner("WAIT");
  agent.state.page.readiness = "loading";
  driver.observe.mockImplementation(async () =>
    structuredClone(agent.state.page),
  );
  for (let i = 0; i < 3; i++) await agent.command("tick");
  expect(agent.state.status).toBe("ready");
  await agent.command("tick");
  expect(agent.state.status).toBe("blocked");
  expect(agent.state.stop_reason?.code).toBe("page_not_ready");
  expect(agent.state.history).toHaveLength(3);
  expect(agent.state.decisions).toHaveLength(3);
  expect(agent.state.answer).toBeNull();
});

test("unchanged WAIT repairs a wrong title check using the actual field value", async () => {
  let plans = 0;
  const p = provider(async (request) => {
    const body = await request.json();
    if (new URL(request.url).pathname.endsWith("systemone"))
      return Response.json(decisionResponse(body, "WAIT", ""));
    if (body.response_format.json_schema.name === "completion_review")
      return completionResponse(body);
    plans++;
    if (plans > 1) {
      const context = JSON.parse(body.messages[1].content);
      expect(context.progress.reason).toContain("Three WAIT");
      expect(context.progress.recent_actions).toHaveLength(3);
    }
    return chatResponse({
      steps: [
        {
          instruction: "Type Lisbon in Search",
          checks:
            plans === 1
              ? [{ kind: "title", includes: "Lisbon" }]
              : [{ kind: "value", label: "Search", equals: "Lisbon" }],
        },
      ],
    });
  });
  servers.push(p.server);
  const { driver } = runner();
  const current = page();
  Object.assign(current.actions[0]!, { value: "Lisbon" });
  current.fingerprint = fingerprint(current);
  driver.observe.mockImplementation(async () => structuredClone(current));
  const agent = new Agent(driver, current, "Type Lisbon in Search", {
    settings: async () => p.settings,
  });
  for (let i = 0; i < 4; i++) await agent.command("tick");
  expect(agent.state.status).toBe("done");
  expect(plans).toBe(2);
  expect(agent.state.plan_revisions).toHaveLength(1);
  expect(agent.state.history).toHaveLength(3);
  expect(agent.state.checkpoints[0]!.checks[0]!.kind).toBe("value");
  expect(agent.state.checkpoints[0]!.verified).not.toBeNull();
  expect(agent.state.completion_reviews).toHaveLength(1);
});

test("an unrepaired checklist cannot resume WAIT forever or falsely complete", async () => {
  const p = provider(async (request) => {
    const body = await request.json();
    if (new URL(request.url).pathname.endsWith("systemone"))
      return Response.json(
        decisionResponse(
          body,
          "WAIT" in body.questions.operation.criteria ? "WAIT" : "BLOCKED",
          "",
        ),
      );
    return chatResponse({
      steps: [
        {
          instruction: "Read the requested result",
          checks: [{ kind: "title", includes: "Never appears" }],
        },
      ],
    });
  });
  servers.push(p.server);
  const { driver } = runner();
  const agent = new Agent(driver, page(), "Read the requested result", {
    settings: async () => p.settings,
  });
  let ticks = 0;
  for await (const state of agent.run()) {
    expect(++ticks).toBeLessThanOrEqual(6);
    expect(state.status).not.toBe("done");
  }
  expect(agent.state.status).toBe("blocked");
  expect(agent.state.history).toHaveLength(3);
  expect(agent.state.plan_revisions).toHaveLength(2);
  expect(agent.state.answer).toBeNull();
});

test("a replaced upcoming control is replanned without losing verified field evidence", async () => {
  let plans = 0;
  const current = page();
  Object.assign(current.actions[0]!, { ref: "fixture-document:10" });
  Object.assign(current.actions[2]!, { ref: "fixture-document:20" });
  const p = provider(async (request) => {
    const body = await request.json();
    if (new URL(request.url).pathname.endsWith("systemone"))
      return Response.json(
        decisionResponse(
          body,
          body.questions.operation.instructions.startsWith("Current step: Type")
            ? "TYPE_TEXT"
            : "CLICK",
          body.questions.operation.instructions.startsWith("Current step: Type")
            ? "1"
            : "2",
        ),
      );
    if (body.response_format.json_schema.name === "completion_review")
      return completionResponse(body);
    if (!body.messages[0].content.includes("completion checklist"))
      return chatResponse({ text: "Lisbon" });
    plans++;
    if (plans === 2)
      expect(
        JSON.parse(body.messages[1].content).progress.completed,
      ).toHaveLength(1);
    return chatResponse({
      steps: [
        ...(plans === 1
          ? [
              {
                instruction: "Type Lisbon",
                checks: [
                  {
                    kind: "value",
                    label: "Search",
                    equals: "Lisbon",
                    ref: "fixture-document:10",
                  },
                ],
              },
            ]
          : []),
        {
          instruction: "Click Go",
          checks: [
            {
              kind: "action",
              label: "Go",
              action: "click",
              ref: plans === 1 ? "fixture-document:20" : "fixture-document:99",
            },
            { kind: "title", includes: "Completed" },
          ],
        },
      ],
    });
  });
  servers.push(p.server);
  const { driver } = runner();
  driver.observe.mockImplementation(async () => structuredClone(current));
  driver.act.mockImplementation(async (action) => {
    if (action.kind === "fill") {
      Object.assign(current.actions[0]!, { value: "Lisbon" });
      Object.assign(current.actions[2]!, {
        node: 99,
        ref: "fixture-document:99",
      });
    } else current.title = "Completed";
    current.fingerprint = fingerprint(current);
  });
  const agent = new Agent(
    driver,
    structuredClone(current),
    "Type Lisbon and submit",
    { settings: async () => p.settings },
  );
  await agent.command("tick");
  await agent.command("tick");
  expect(agent.state.status).toBe("done");
  expect(agent.state.history.map((entry) => entry.ref)).toEqual([
    "fixture-document:10",
    "fixture-document:99",
  ]);
  expect(agent.state.checkpoints).toHaveLength(2);
  expect(agent.state.plan_revisions).toHaveLength(1);
  expect(plans).toBe(2);
});

test("repeated predictions and unchanged mutations are independently bounded", async () => {
  const predicting = runner("CLICK", "2", 2).agent;
  for (let i = 0; i < 4; i++) await predicting.command("predict");
  await expect(predicting.command("predict")).rejects.toThrow(
    "model-call budget",
  );
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
  await expect(agent.command("tick")).rejects.toThrow(
    "Checklist must contain 1–12 steps",
  );
  expect(agent.state.planning_calls).toHaveLength(2);
  expect(agent.state.decisions).toHaveLength(0);
  expect(agent.state.status).toBe("error");
  expect(driver.act).not.toHaveBeenCalled();
  expect(JSON.stringify(agent.snapshot())).not.toContain("test-key");
});

test("completion requires a fresh observation, not just matching stale checkpoint values", async () => {
  const { agent, driver } = runner("WAIT", "", 60, [
    {
      instruction: "Read the Search title",
      checks: [{ kind: "title", includes: "Search" }],
    },
  ]);
  driver.fresh.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  driver.observe.mockResolvedValueOnce({
    ...page(),
    title: "Loading",
    fingerprint: "new-page",
  });
  await agent.command("predict");
  expect(agent.state.status).toBe("ready");
  expect(agent.state.page.title).toBe("Loading");
  expect(agent.state.checkpoints[0]!.verified).toBeNull();
  expect(driver.act).not.toHaveBeenCalled();
  driver.fresh.mockResolvedValueOnce(false);
  await agent.command("tick");
  expect(agent.state.status).toBe("done");
  expect(agent.state.decisions).toHaveLength(0);
  expect(agent.state.plan_index).toBe(1);
});

test("a page change during final review never publishes a completed answer", async () => {
  const { agent, driver } = runner("WAIT", "", 60, [
    {
      instruction: "Read Search",
      checks: [{ kind: "title", includes: "Search" }],
    },
  ]);
  driver.fresh
    .mockResolvedValue(false)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true);
  await expect(agent.command("predict")).rejects.toBeInstanceOf(StalePage);
  expect(agent.state.answer).toBeNull();
  expect(agent.state.status).toBe("error");
  expect(agent.state.stop_reason?.code).toBe("observation_failed");
  expect(driver.observe).toHaveBeenCalledTimes(3);
  expect(agent.state.completion_reviews).toHaveLength(1);
  expect(driver.act).not.toHaveBeenCalled();
});

test("a review repeating only verified requirements stops without a revision loop", async () => {
  const steps = [
    {
      instruction: "Read Search",
      checks: [{ kind: "title", includes: "Search" }],
    },
  ];
  const p = provider(async (request) => {
    const body = await request.json();
    return chatResponse(
      body.response_format.json_schema.name === "completion_review"
        ? { complete: false, answer: null, evidence: [], missing_steps: steps }
        : { steps },
    );
  });
  servers.push(p.server);
  const { driver } = runner();
  const agent = new Agent(driver, page(), "Read Search", {
    settings: async () => p.settings,
  });
  await agent.command("tick");
  expect(agent.state.status).toBe("blocked");
  expect(agent.state.completion_reviews).toHaveLength(1);
  expect(agent.state.plan_revisions).toHaveLength(0);
  expect(agent.state.answer).toBeNull();
  expect(driver.act).not.toHaveBeenCalled();
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
  expect(agent.state.model_calls.filter((c) => c.role === "text")).toHaveLength(
    1,
  );
  expect(driver.act).not.toHaveBeenCalled();
  expect(agent.state.history).toHaveLength(0);
});

test.each([
  "new fingerprint",
  "reused fingerprint",
  "changed decision",
  "changed decision prototype",
  "changed nested prototype",
])(
  "a consumer cannot rebind an old decision to a new control: %s",
  async (change) => {
    const { agent, driver } = runner("CLICK", "2");
    await agent.command("predict");
    if (change === "changed decision") agent.state.decision!.choice = "e1";
    else if (change === "changed decision prototype")
      Object.setPrototypeOf(agent.state.decision!, null);
    else if (change === "changed nested prototype")
      Object.setPrototypeOf(agent.state.decision!.target_probabilities, null);
    else {
      const next = structuredClone(agent.state.page);
      Object.assign(
        next.actions.find((a) => a.id === "e3")!,
        { node: 99, label: "Different control" },
      );
      if (change === "new fingerprint") next.fingerprint = fingerprint(next);
      agent.state.page = next;
    }
    await expect(
      agent.command("act", { fingerprint: agent.state.page.fingerprint }),
    ).rejects.toBeInstanceOf(StalePage);
    expect(driver.act).not.toHaveBeenCalled();
    expect(agent.state.decision).toBeNull();
  },
);

test("recovered post-action observations participate in the three-repeat guard", async () => {
  const { agent, driver } = runner("CLICK", "2");
  let calls = 0;
  driver.observe.mockImplementation(async () => {
    if (++calls % 2) throw new StalePage("Transient observation failure");
    return structuredClone(agent.state.page);
  });
  for (let i = 0; i < 3; i++) await agent.command("tick");
  expect(agent.state.history.map((entry) => entry.page_changed)).toEqual([
    false,
    false,
    false,
  ]);
  expect(agent.state.status).toBe("blocked");
  expect(agent.state.stop_reason?.code).toBe("no_progress");
  expect(driver.act).toHaveBeenCalledTimes(3);
});

test("re-rendering identical controls is not progress even when node identities change", async () => {
  const { agent, driver } = runner("CLICK", "2");
  driver.observe.mockImplementation(async () => {
    const current = structuredClone(agent.state.page);
    for (const action of current.actions)
      if ("node" in action) {
        action.node += 100;
        action.ref = `fixture-document:${action.node}`;
      }
    current.fingerprint = fingerprint(current);
    return current;
  });
  for (let i = 0; i < 3; i++) await agent.command("tick");
  expect(agent.state.status).toBe("blocked");
  expect(agent.state.history.map((entry) => entry.page_changed)).toEqual([
    false,
    false,
    false,
  ]);
  expect(agent.state.stop_reason?.code).toBe("no_progress");
});

test("a failed recovery stops without replaying an already consumed mutation", async () => {
  const { agent, driver } = runner("CLICK", "2");
  driver.observe.mockRejectedValue(new StalePage("Still navigating"));
  await expect(agent.command("tick")).rejects.toBeInstanceOf(StalePage);
  expect(agent.state.status).toBe("error");
  expect(agent.state.stop_reason?.code).toBe("observation_failed");
  expect(agent.state.history[0]!.page_changed).toBeNull();
  expect(driver.act).toHaveBeenCalledTimes(1);
  expect(driver.observe).toHaveBeenCalledTimes(4);
});

test("BLOCKED reobserves before stopping and reports incomplete coverage", async () => {
  const { agent, driver } = runner("BLOCKED");
  driver.observe.mockImplementationOnce(async () => ({
    ...agent.state.page,
    fingerprint: "menu-appeared",
  }));
  await agent.command("tick");
  expect(agent.state.status).toBe("ready");
  agent.state.page.omitted_actions = 12;
  driver.observe.mockImplementation(async () =>
    structuredClone(agent.state.page),
  );
  await agent.command("tick");
  expect(agent.state.status).toBe("blocked");
  expect(agent.state.stop_reason?.code).toBe("incomplete_observation");
  expect(driver.act).not.toHaveBeenCalled();
});

test("a same-label popup input keeps the original checkpoint binding", async () => {
  const current = page();
  const original: Action = {
    id: "origin",
    node: 10,
    ref: "fixture-document:10",
    kind: "click",
    role: "combobox",
    label: "Origin",
    value: "",
    has_popup: true,
    expanded: "false",
  };
  current.actions = [original];
  let plans = 0;
  const p = provider(async (request) => {
    const body = await request.json();
    if (new URL(request.url).pathname.endsWith("systemone"))
      return Response.json(
        decisionResponse(
          body,
          "CLICK",
          current.actions.length === 1 ? "1" : "2",
        ),
      );
    if (body.response_format.json_schema.name === "completion_review")
      return completionResponse(body);
    plans++;
    return chatResponse({
      steps: [
        {
          instruction: "Choose Berlin",
          checks: [{ kind: "value", label: "Origin", equals: "Berlin" }],
        },
      ],
    });
  });
  servers.push(p.server);
  const { driver } = runner();
  driver.observe.mockImplementation(async () => structuredClone(current));
  driver.act.mockImplementation(async (action) => {
    current.actions =
      action.id === "origin"
        ? [
            {
              ...original,
              id: "input",
              node: 20,
              ref: "fixture-document:20",
              popup_owner: original.ref,
              kind: "fill",
              expanded: "true",
            },
            {
              id: "option",
              node: 21,
              ref: "fixture-document:21",
              popup_owner: original.ref,
              kind: "click",
              role: "option",
              label: "Berlin",
            },
          ]
        : [{ ...original, value: "Berlin" }];
    current.fingerprint = fingerprint(current);
  });
  const agent = new Agent(driver, structuredClone(current), "Choose Berlin", {
    settings: async () => p.settings,
  });
  await agent.command("tick");
  await agent.command("tick");
  expect(agent.state.status).toBe("done");
  expect(plans).toBe(1);
  expect(agent.state.plan_revisions).toHaveLength(0);
  expect(agent.state.checkpoints[0]!.checks[0]).toMatchObject({
    ref: "fixture-document:10",
  });
});

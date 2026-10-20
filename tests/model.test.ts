import { afterEach, expect, spyOn, test } from "bun:test";
import {
  actionSpace,
  checkModels,
  choose,
  fieldContext,
  fieldText,
  postJson,
  validateChoice,
} from "../src/model";
import {
  chatResponse,
  choice,
  decisionResponse,
  page,
  provider,
} from "./helpers";
import type { DecisionRequest, HistoryEntry, ModelCall } from "../src/types";

const servers: Bun.Server<undefined>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
});

test("local model calls bypass proxy variables while cloud calls use them", async () => {
  const local = provider(() => Response.json({ via: "local" }));
  let proxyRequests = 0;
  const proxy = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      proxyRequests++;
      return Response.json({ via: "proxy" });
    },
  });
  servers.push(local.server, proxy);
  const proxyUrl = `http://127.0.0.1:${proxy.port}`;
  for (const [baseUrl, via] of [
    [local.endpoint.baseUrl, "local"],
    [local.endpoint.baseUrl.replace("127.0.0.1", "localhost"), "local"],
    ["http://provider.invalid/v1", "proxy"],
  ] as const) {
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--eval",
        `import { postJson } from "./src/model";
console.log(JSON.stringify(await postJson(${JSON.stringify({ baseUrl, apiKey: "", model: "test" })}, "systemone", {})));`,
      ],
      {
        cwd: `${import.meta.dir}/..`,
        env: {
          ...process.env,
          HTTP_PROXY: proxyUrl,
          http_proxy: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          https_proxy: proxyUrl,
          ALL_PROXY: proxyUrl,
          all_proxy: proxyUrl,
          NO_PROXY: "",
          no_proxy: "",
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ via });
  }
  expect(proxyRequests).toBe(1);
});

test.each(["ready", "invalid", "unauthorized"])(
  "connection probes validate both real protocols: %s",
  async (mode) => {
    const requests: string[] = [];
    const p = provider(async (request) => {
      const path = new URL(request.url).pathname;
      requests.push(path);
      if (mode === "unauthorized")
        return new Response("private-provider-message", { status: 401 });
      if (mode === "invalid") return Response.json({ choices: [] });
      const body = await request.json();
      return path.endsWith("systemone")
        ? Response.json({
            answers: {
              readiness: choice(body.questions.readiness.criteria, "ready"),
            },
          })
        : chatResponse({ ready: true, text: null });
    });
    servers.push(p.server);
    const results = await checkModels(async () => p.settings);
    expect(results.map((check) => check.ok)).toEqual([
      mode === "ready",
      mode === "ready",
    ]);
    expect(requests.sort()).toEqual(["/v1/chat/completions", "/v1/systemone"]);
    expect(JSON.stringify(results)).not.toContain("test-key");
    expect(JSON.stringify(results)).not.toContain("private-provider-message");
    if (mode === "unauthorized")
      expect(results.every((check) => check.message.includes("401"))).toBe(
        true,
      );
  },
);

test.each([
  "unknown",
  "nan",
  "missing",
  "negative",
  "non_max",
  "confidence",
  "extra",
  "boolean",
])("rejects malformed choice: %s", (mutation) => {
  const answer = choice({ a: "A", b: "B" }, "a");
  if (mutation === "unknown") answer.choice = "invented";
  if (mutation === "nan") answer.probabilities.a = NaN;
  if (mutation === "missing") delete answer.probabilities.b;
  if (mutation === "negative") answer.probabilities.b = -1;
  if (mutation === "non_max") answer.choice = "b";
  if (mutation === "confidence") answer.confidence = 5;
  if (mutation === "extra") answer.probabilities.c = 0;
  if (mutation === "boolean")
    (answer as unknown as Record<string, unknown>).confidence = true;
  expect(() => validateChoice(answer, { a: "A", b: "B" })).toThrow(
    "Invalid typed decision",
  );
});

test("one element index has separate compatible operation heads and indexed native options", () => {
  const actions = page().actions;
  actions.push({
    id: "s1",
    kind: "select",
    node: 30,
    role: "combobox",
    label: "Category → Design",
    value: "Design",
    option_index: 1,
    option_node: 31,
    current_value: "All",
  });
  actions.push({
    id: "s2",
    kind: "select",
    node: 30,
    role: "combobox",
    label: "Category → Coastal",
    value: "Coastal",
    option_index: 2,
    option_node: 32,
    current_value: "All",
  });
  const space = actionSpace(actions);
  expect(space.elements).toHaveLength(3);
  expect(space.elements[0]!.operations).toEqual(["TYPE_TEXT", "CLICK"]);
  expect(space.targets.TYPE_TEXT!["1"]!.id).toBe("e1");
  expect(space.targets.CLICK!["1"]!.id).toBe("e2");
  expect(space.targets.SELECT!["3:2"]!.id).toBe("s2");
  expect(space.elements[2]!.value).toBe("All");
});

test("one System One request carries all heads and ignores an invalid unused head", async () => {
  const requests: DecisionRequest[] = [];
  const { server, endpoint } = provider(async (request) => {
    expect(new URL(request.url).pathname).toBe("/v1/systemone");
    expect(request.headers.get("authorization")).toBe("Bearer test-key");
    const body = (await request.json()) as DecisionRequest;
    for (const question of Object.values(body.questions)) {
      expect(typeof question.instructions).toBe("string");
      expect(question.instructions).toContain("User goal: Find a book");
      expect(question.instructions).toContain("Do not repeat satisfied steps");
    }
    expect(body.questions.type_text_target!.instructions).toContain(
      "If the operation is TYPE_TEXT, choose its target.",
    );
    requests.push(body);
    return Response.json({
      ...decisionResponse(body),
      answers: {
        ...decisionResponse(body).answers,
        click_target: { choice: "invented" },
      },
    });
  });
  servers.push(server);
  const result = await choose(page(), "Find a book", [], endpoint);
  expect(requests).toHaveLength(1);
  expect(Object.keys(requests[0]!.questions).sort()).toEqual([
    "click_target",
    "operation",
    "type_text_target",
  ]);
  expect(result.choice).toBe("e1");
  expect(result.request).not.toHaveProperty("apiKey");
});

test("CLICK cannot consume a TYPE_TEXT target", async () => {
  const { server, endpoint } = provider(async (request) => {
    const body = (await request.json()) as DecisionRequest;
    return Response.json({
      answers: {
        operation: choice(body.questions.operation!.criteria, "CLICK"),
        type_text_target: choice({ "1": "field" }, "1"),
        click_target: choice({ "999": "invented" }, "999"),
      },
    });
  });
  servers.push(server);
  await expect(choose(page(), "Search", [], endpoint)).rejects.toThrow(
    "Invalid typed decision",
  );
});

test("an unfinished checkpoint gets focused instructions and no terminal DONE choice", async () => {
  const { server, endpoint } = provider(async (request) => {
    const body = (await request.json()) as DecisionRequest;
    expect(body.questions.operation!.criteria).not.toHaveProperty("DONE");
    for (const question of Object.values(body.questions)) {
      expect(question.instructions).toContain("Current step: Click Go");
      expect(question.instructions).toContain(
        "current step has not passed verification",
      );
      expect(question.instructions).not.toContain("user's entire goal");
    }
    return Response.json(decisionResponse(body, "CLICK", "2"));
  });
  servers.push(server);
  const result = await choose(page(), "Click Go", [], endpoint, false);
  expect(result.choice).toBe("e3");
});

test.each(["Free cancellation", " Free   cancellation "])(
  "checkpoint %s excludes unrelated cards and keeps observed indices",
  async (label) => {
    const state = page();
    state.actions.push({
      id: "refund",
      kind: "click",
      node: 30,
      label: "Free cancellation",
      role: "checkbox",
      checked: "false",
      ref: "fixture-document:30",
      scope: "Search filters",
    });
    const p = provider(async (request) => {
      const body = await request.json();
      expect(Object.keys(body.questions.click_target.criteria)).toEqual(["3"]);
      expect(body.questions.type_text_target).toBeUndefined();
      return Response.json(decisionResponse(body, "CLICK", "3"));
    });
    servers.push(p.server);
    const decision = await choose(
      state,
      "Enable Free cancellation",
      [],
      p.endpoint,
      false,
      undefined,
      [
        {
          kind: "checked",
          label,
          equals: true,
          ref: "fixture-document:30",
          scope: " Search   filters ",
        },
      ],
    );
    expect(decision.choice).toBe("refund");
  },
);

test("an offscreen checkpoint target offers scrolling instead of unrelated clicks", async () => {
  const state = page();
  state.actions.push({
    id: "scroll_down",
    kind: "scroll",
    label: "Scroll down",
    delta: 560,
  });
  const p = provider(async (request) => {
    const body = await request.json();
    expect(body.questions.click_target).toBeUndefined();
    expect(body.questions.operation.criteria.CLICK).toBeUndefined();
    expect(body.questions.operation.criteria.SCROLL_DOWN).toBeDefined();
    expect(body.state.observation.scroll).toEqual({
      ...state.scroll,
      viewport_height: state.h,
    });
    expect(body.state.observation.pending_controls_not_visible).toHaveLength(1);
    expect(body.questions.operation.instructions).toContain(
      "Scrolling is available and must be tried",
    );
    return Response.json(decisionResponse(body, "SCROLL_DOWN", ""));
  });
  servers.push(p.server);
  const decision = await choose(
    state,
    "Open the requested result",
    [],
    p.endpoint,
    false,
    undefined,
    [
      { kind: "action", label: "View requested result", action: "click" },
      { kind: "title", includes: "Requested result" },
    ],
  );
  expect(decision.choice).toBe("scroll_down");
});

test("reading checkpoints offer scrolling without unrelated clicks or typing", async () => {
  const state = page();
  state.actions.push({
    id: "scroll_down",
    kind: "scroll",
    label: "Scroll down",
    delta: 560,
  });
  const p = provider(async (request) => {
    const body = await request.json();
    expect(body.questions.click_target).toBeUndefined();
    expect(body.questions.type_text_target).toBeUndefined();
    return Response.json(decisionResponse(body, "SCROLL_DOWN"));
  });
  servers.push(p.server);
  expect(
    (
      await choose(
        state,
        "Read the product information",
        [],
        p.endpoint,
        false,
        undefined,
        [{ kind: "text", includes: "UPC" }],
      )
    ).choice,
  ).toBe("scroll_down");
});

test("submission targets belong to the form containing the required fields", async () => {
  const state = page();
  state.actions = [
    {
      id: "title",
      kind: "fill",
      node: 1,
      label: "Search",
      role: "textbox",
      form_ref: "advanced",
      value: "The Time Machine",
    },
    {
      id: "header",
      kind: "click",
      node: 2,
      label: "Search",
      role: "button",
      has_popup: true,
    },
    {
      id: "submit",
      kind: "click",
      node: 3,
      label: "Search",
      role: "button",
      form_ref: "advanced",
    },
  ];
  const p = provider(async (request) => {
    const body = await request.json();
    expect(Object.keys(body.questions.click_target.criteria)).toEqual(["3"]);
    return Response.json(decisionResponse(body, "CLICK", "3"));
  });
  servers.push(p.server);
  expect(
    (
      await choose(
        state,
        "Submit the book search",
        [],
        p.endpoint,
        false,
        undefined,
        [
          { kind: "value", label: "Search", equals: "The Time Machine" },
          { kind: "action", label: "Search", action: "click" },
        ],
      )
    ).choice,
  ).toBe("submit");
});

test.each(["text", "fragment"])(
  "reading offers only the observed same-page section: %s",
  async (kind) => {
    const state = page();
    state.actions = [
      {
        id: "section",
        kind: "click",
        role: "link",
        label: "Examples",
        node: 1,
        href: `${state.url}#examples`,
      },
      {
        id: "elsewhere",
        kind: "click",
        role: "link",
        label: "Examples",
        node: 2,
        href: "https://elsewhere.test/#examples",
      },
      { id: "scroll", kind: "scroll", label: "Scroll down", delta: 560 },
    ];
    const p = provider(async (request) => {
      const body = await request.json();
      expect(Object.keys(body.questions.click_target.criteria)).toEqual(["1"]);
      if (kind === "fragment") {
        expect(body.state.required_checks).toEqual([
          { kind: "url", includes: "#examples" },
        ]);
        expect(body.questions.operation.instructions).toContain(
          "requires URL fragment #examples",
        );
        expect(body.questions.operation.criteria.SCROLL_DOWN).toBeUndefined();
      } else
        expect(body.questions.operation.criteria.SCROLL_DOWN).toBeDefined();
      return Response.json(decisionResponse(body, "CLICK", "1"));
    });
    servers.push(p.server);
    expect(
      (
        await choose(state, "Read Examples", [], p.endpoint, false, undefined, [
          kind === "text"
            ? { kind: "text", includes: "Examples" }
            : { kind: "url", includes: "#examples" },
        ])
      ).choice,
    ).toBe("section");
  },
);

test("a menu opener already executed in this checkpoint is not clicked again", async () => {
  const state = page();
  state.actions = [
    {
      id: "menu",
      kind: "click",
      node: 1,
      label: "Explore",
      role: "button",
      ref: "document:1",
    },
    {
      id: "destination",
      kind: "click",
      node: 2,
      label: "Venus",
      role: "link",
      ref: "document:2",
    },
  ];
  const p = provider(async (request) => {
    const body = await request.json();
    expect(Object.keys(body.questions.click_target.criteria)).toEqual(["2"]);
    return Response.json(decisionResponse(body, "CLICK", "2"));
  });
  servers.push(p.server);
  const history = [
    { kind: "click", action: "Explore", ref: "document:1" },
  ] as HistoryEntry[];
  expect(
    (
      await choose(
        state,
        "Open Explore then Venus",
        history,
        p.endpoint,
        false,
        undefined,
        [
          {
            kind: "action",
            label: "Explore",
            action: "click",
            ref: "document:1",
          },
          {
            kind: "action",
            label: "Venus",
            action: "click",
            ref: "document:2",
          },
          { kind: "url", includes: "/venus" },
        ],
        0,
      )
    ).choice,
  ).toBe("destination");
});

test.each(["false", "true"])(
  "menu state selects a click only while expansion is needed: expanded=%s",
  async (expanded) => {
    const state = page();
    state.actions = [
      {
        id: "menu",
        kind: "click",
        node: 1,
        role: "button",
        label: "Explore",
        expanded,
      },
    ];
    const p = provider(async (request) => {
      const body = await request.json();
      expect(Boolean(body.questions.click_target)).toBe(expanded === "false");
      return Response.json(
        decisionResponse(body, expanded === "false" ? "CLICK" : "BLOCKED", "1"),
      );
    });
    servers.push(p.server);
    await choose(state, "Open Explore", [], p.endpoint, false, undefined, [
      { kind: "expanded", label: "Explore", equals: true },
    ]);
  },
);

test("same-named navigation targets remain distinguishable by their observed context", async () => {
  const state = page();
  state.actions = [1, 2].map((node) => ({
    id: `a${node}`,
    kind: "click",
    node,
    role: "link",
    label: "(about)",
    scope: node === 1 ? "by Jane Austen" : "by Albert Einstein",
  }));
  const p = provider(async (request) => {
    const body = await request.json();
    expect(Object.keys(body.questions.click_target.criteria)).toHaveLength(2);
    return Response.json(decisionResponse(body, "CLICK", "1"));
  });
  servers.push(p.server);
  expect(
    (
      await choose(
        state,
        "Open Jane Austen's biography",
        [],
        p.endpoint,
        false,
        undefined,
        [{ kind: "action", label: "(about)", action: "click" }],
      )
    ).choice,
  ).toBe("a1");
});

test.each([
  ["non-JSON", "Thinking: Lisbon"],
  ["extra keys", '{"text":"Lisbon","extra":true}'],
  ["wrong type", '{"text":123}'],
  ["empty text", '{"text":" "}'],
  ["oversized text", JSON.stringify({ text: "x".repeat(2001) })],
])("rejects unsafe helper output: %s", async (_name, content) => {
  const { server, endpoint } = provider(() =>
    Response.json({ choices: [{ message: { content } }] }),
  );
  servers.push(server);
  const state = page();
  await expect(
    fieldText(
      fieldContext("Find a hotel", state.actions[0]!, state, []),
      endpoint,
    ),
  ).rejects.toThrow("nothing typed");
});

test("local helper can omit authentication; quoted goal text still calls the helper", async () => {
  let calls = 0;
  const { server, endpoint } = provider(async (request) => {
    calls++;
    expect(request.headers.has("authorization")).toBe(false);
    const body = await request.json();
    expect(JSON.parse(body.messages[1].content).goal).toBe(
      'Search for "Lisbon"',
    );
    return Response.json({
      choices: [{ message: { content: '{"text":"Lisbon"}' } }],
    });
  });
  servers.push(server);
  const state = page();
  const result = await fieldText(
    fieldContext('Search for "Lisbon"', state.actions[0]!, state, []),
    { ...endpoint, apiKey: "" },
  );
  expect(result.text).toBe("Lisbon");
  expect(calls).toBe(1);
});

test("HTTP errors redact provider bodies and authenticated redirects are refused", async () => {
  let forwarded = 0;
  const other = provider(() => {
    forwarded++;
    return Response.json({});
  });
  const first = provider((request) =>
    new URL(request.url).pathname.endsWith("error")
      ? new Response("secret: test-key", { status: 401 })
      : Response.redirect(`${other.endpoint.baseUrl}/sink`),
  );
  servers.push(other.server, first.server);
  await expect(postJson(first.endpoint, "error", {})).rejects.toThrow(
    "HTTP 401",
  );
  await expect(postJson(first.endpoint, "redirect", {})).rejects.toThrow(
    "connection failed",
  );
  expect(forwarded).toBe(0);
});

test("null is a valid missing-value result and is not repaired", async () => {
  let calls = 0;
  const p = provider(async (request) => {
    calls++;
    const body = await request.json();
    expect(
      body.response_format.json_schema.schema.properties.text.anyOf,
    ).toEqual([{ type: "string" }, { type: "null" }]);
    return chatResponse({ text: null });
  });
  servers.push(p.server);
  const state = page();
  expect(
    (
      await fieldText(
        fieldContext("Enter an unspecified name", state.actions[0]!, state, []),
        p.endpoint,
      )
    ).text,
  ).toBeNull();
  expect(calls).toBe(1);
});

test("helper repairs once, preserves its field context and rereads the connection", async () => {
  const requests: any[] = [],
    calls: ModelCall[] = [];
  let reads = 0;
  const p = provider(async (request) => {
    requests.push(await request.json());
    return requests.length === 1
      ? Response.json({
          choices: [{ message: { content: "{broken" } }],
          usage: { prompt_tokens: 3 },
        })
      : chatResponse({ text: "Lisbon" });
  });
  servers.push(p.server);
  const state = page();
  const result = await fieldText(
    fieldContext("Enter Lisbon", state.actions[0]!, state, []),
    async () => {
      reads++;
      return p.endpoint;
    },
    (call) => calls.push(call),
  );
  expect(result.text).toBe("Lisbon");
  expect(reads).toBe(2);
  expect(requests[0].messages[1]).toEqual(requests[1].messages[1]);
  expect(requests[1].messages).toHaveLength(3);
  expect(calls).toHaveLength(2);
  expect(calls[0]!.usage).toEqual({ prompt_tokens: 3 });
});

test.each(["http", "envelope"])(
  "retries transient %s errors and records every attempt",
  async (kind) => {
    let requests = 0;
    const calls: ModelCall[] = [];
    const p = provider(() =>
      ++requests < 3
        ? kind === "http"
          ? new Response("sensitive body", { status: 503 })
          : Response.json({
              error: { code: "overloaded", message: "sensitive body" },
            })
        : Response.json({
            ok: true,
            usage: { input_tokens: 5, output_tokens: 2 },
          }),
    );
    servers.push(p.server);
    expect(
      (await postJson(p.endpoint, "systemone", {}, (call) => calls.push(call)))
        .ok,
    ).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[0]!.outcome).toBe(
      kind === "http" ? "http_error" : "provider_error",
    );
    expect(JSON.stringify(calls)).not.toContain("sensitive body");
    expect(JSON.stringify(calls)).not.toContain("test-key");
  },
);

test("permanent HTTP-200 errors fail once without leaking provider details", async () => {
  let count = 0;
  const p = provider(() => {
    count++;
    return Response.json({
      error: { code: "invalid_api_key", message: "secret-key" },
    });
  });
  servers.push(p.server);
  await expect(postJson(p.endpoint, "systemone", {})).rejects.toThrow(
    "error response",
  );
  expect(count).toBe(1);
});

test("network failures retry within a fixed request budget", async () => {
  const fetch = spyOn(globalThis, "fetch").mockRejectedValue(
    new TypeError("secret connection detail"),
  );
  const calls: ModelCall[] = [];
  try {
    await expect(
      postJson(
        { baseUrl: "http://127.0.0.1:1/v1", model: "test", apiKey: "" },
        "systemone",
        {},
        (call) => calls.push(call),
      ),
    ).rejects.toThrow("connection failed");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(calls.map((c) => c.outcome)).toEqual([
      "network_error",
      "network_error",
      "network_error",
    ]);
  } finally {
    fetch.mockRestore();
  }
});

test("decision input includes observation readiness and truncation", async () => {
  const p = provider(async (request) => {
    const body = await request.json();
    expect(body.state.observation).toMatchObject({
      readiness: "loading",
      omitted_actions: 17,
      discovery_limited: true,
    });
    return Response.json(decisionResponse(body, "WAIT", ""));
  });
  servers.push(p.server);
  const state = page();
  Object.assign(state, {
    readiness: "loading",
    omitted_actions: 17,
    discovery_limited: true,
  });
  await choose(state, "Wait for the form", [], p.endpoint, false);
});

test("request telemetry snapshots pricing without leaking credentials", async () => {
  const p = provider(() => {
    p.endpoint.pricing!.inputUsdPerMillion = 99;
    return Response.json({
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  });
  servers.push(p.server);
  p.endpoint.pricing = { inputUsdPerMillion: 1, outputUsdPerMillion: 2 };
  const calls: ModelCall[] = [];
  await postJson(p.endpoint, "chat/completions", {}, (call) =>
    calls.push(call),
  );
  expect(calls[0]!.pricing).toEqual({
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
  });
  expect(JSON.stringify(calls)).not.toContain("test-key");
});

test("value steps open custom controls and restrict popup actions to their observed owner", async () => {
  const state = page();
  state.actions[0] = {
    ...state.actions[0]!,
    kind: "fill",
    node: 10,
    role: "combobox",
    label: "Origin",
    ref: "doc:10",
    has_popup: true,
    expanded: "false",
  };
  state.actions[1] = {
    ...state.actions[0],
    id: "e2",
    kind: "click",
    label: "Open Origin",
  };
  const p = provider(async (request) => {
    const body = await request.json();
    expect(body.questions.type_text_target).toBeUndefined();
    expect(Object.keys(body.questions.click_target.criteria)).toEqual(["1"]);
    return Response.json(decisionResponse(body, "CLICK", "1"));
  });
  servers.push(p.server);
  const check = [
    {
      kind: "value" as const,
      label: "Origin",
      ref: "doc:10",
      equals: "Berlin",
    },
  ];
  expect(
    (
      await choose(
        state,
        "Select Berlin",
        [],
        p.endpoint,
        false,
        undefined,
        check,
      )
    ).choice,
  ).toBe("e2");
  state.actions = [
    {
      id: "option",
      kind: "click",
      node: 30,
      ref: "doc:30",
      popup_owner: "doc:10",
      role: "option",
      label: "Berlin, Germany",
    },
    {
      id: "other",
      kind: "click",
      node: 31,
      ref: "doc:31",
      popup_owner: "doc:11",
      role: "option",
      label: "Berlin, Maryland",
    },
  ];
  expect(
    (
      await choose(
        state,
        "Select Berlin",
        [],
        p.endpoint,
        false,
        undefined,
        check,
      )
    ).choice,
  ).toBe("option");
});

test("a page waiting for scripts offers no premature clicks or typing", async () => {
  const state = { ...page(), readiness: "loading" as const };
  const p = provider(async (request) => {
    const body = await request.json();
    expect(Object.keys(body.questions.operation.criteria)).toEqual([
      "WAIT",
      "BLOCKED",
    ]);
    expect(Object.keys(body.questions)).toEqual(["operation"]);
    return Response.json(decisionResponse(body, "WAIT"));
  });
  servers.push(p.server);
  expect(
    (await choose(state, "Enter Berlin", [], p.endpoint, false)).choice,
  ).toBe("wait");
});

test("autocomplete prefers the requested city option over unrelated popup buttons", async () => {
  const state = page();
  state.actions = [
    {
      id: "input",
      node: 1,
      ref: "doc:1",
      popup_owner: "doc:0",
      kind: "fill",
      role: "combobox",
      label: "City",
      value: "New York",
      expanded: "true",
    },
    {
      id: "city",
      node: 2,
      ref: "doc:2",
      popup_owner: "doc:0",
      kind: "click",
      role: "option",
      label: "New York, USA",
      selected: "false",
    },
    {
      id: "multiple",
      node: 3,
      ref: "doc:3",
      popup_owner: "doc:0",
      kind: "click",
      role: "button",
      label: "Select multiple airports",
    },
    {
      id: "wrong",
      node: 4,
      ref: "doc:4",
      popup_owner: "doc:0",
      kind: "click",
      role: "option",
      label: "West New York, USA",
    },
  ];
  const p = provider(async (request) => {
    const body = await request.json();
    expect(Object.keys(body.questions.click_target.criteria)).toEqual(["2"]);
    expect(body.questions.type_text_target).toBeUndefined();
    return Response.json(decisionResponse(body, "CLICK", "2"));
  });
  servers.push(p.server);
  expect(
    (
      await choose(state, "Choose New York", [], p.endpoint, false, undefined, [
        {
          kind: "value",
          label: "Destination",
          ref: "doc:0",
          equals: "New York",
        },
      ])
    ).choice,
  ).toBe("city");
});

test.each([false, true])(
  "autocomplete selects observed aliases only after entering a query: queried=%s",
  async (queried) => {
    const state = page();
    state.actions = [
      {
        id: "input",
        node: 1,
        ref: "doc:1",
        popup_owner: "doc:0",
        kind: "fill",
        role: "combobox",
        label: "Where else?",
        value: "LHR",
      },
      {
        id: "airport",
        node: 2,
        ref: "doc:2",
        popup_owner: "doc:0",
        kind: "click",
        role: "option",
        label: "Heathrow Airport (LHR)",
      },
      {
        id: "other",
        node: 3,
        ref: "doc:3",
        popup_owner: "doc:99",
        kind: "click",
        role: "option",
        label: "London City Airport (LCY)",
      },
      { id: "scroll", kind: "scroll", label: "Scroll down", delta: 600 },
    ];
    const p = provider(async (request) => {
      const body = await request.json();
      const operation = queried ? "CLICK" : "TYPE_TEXT";
      const index = queried ? "2" : "1";
      expect(body.questions.operation.criteria.SCROLL_DOWN).toBeUndefined();
      expect(
        Object.keys(
          body.questions[`${operation.toLowerCase()}_target`].criteria,
        ),
      ).toEqual([index]);
      expect(
        body.questions[queried ? "type_text_target" : "click_target"],
      ).toBeUndefined();
      return Response.json(decisionResponse(body, operation, index));
    });
    servers.push(p.server);
    const result = await choose(
      state,
      "Select London Heathrow (LHR)",
      queried
        ? [
            {
              step: 1,
              action: "Where else?",
              ref: "doc:1",
              kind: "fill",
              choice: "input",
              probability: 1,
              confidence: 1,
              latency_ms: 0,
              text: "LHR",
              text_helper: null,
              text_latency_ms: 0,
              operation: "TYPE_TEXT",
              target: "1",
              page_changed: true,
              url: state.url,
              usage: {},
              executed_ms: 0,
              elapsed_ms: 0,
            },
          ]
        : [],
      p.endpoint,
      false,
      undefined,
      [
        {
          kind: "value",
          label: "Where from?",
          ref: "doc:0",
          equals: "London Heathrow",
        },
      ],
    );
    expect(result.choice).toBe(queried ? "airport" : "input");
  },
);

test.each([false, true])(
  "autocomplete only reoffers an unchanged query for an observed empty result: empty=%s",
  async (empty) => {
    const state = page();
    state.actions = [
      {
        id: "input",
        node: 1,
        ref: "doc:1",
        popup_owner: "doc:0",
        kind: "fill",
        role: "combobox",
        label: "Where else?",
        value: "London Heathrow (LHR)",
        context: empty ? "No matching locations found" : "Searching",
      },
      { id: "wait", kind: "wait", label: "Wait" },
    ];
    const p = provider(async (request) => {
      const body = await request.json();
      expect(Boolean(body.questions.type_text_target)).toBe(empty);
      expect("WAIT" in body.questions.operation.criteria).toBe(!empty);
      return Response.json(
        decisionResponse(
          body,
          empty ? "TYPE_TEXT" : "WAIT",
          empty ? "1" : undefined,
        ),
      );
    });

    servers.push(p.server);
    const result = await choose(
      state,
      "Select London Heathrow (LHR)",
      [],
      p.endpoint,
      false,
      undefined,
      [
        {
          kind: "value",
          label: "Where from?",
          ref: "doc:0",
          equals: "London Heathrow (LHR)",
        },
      ],
    );
    expect(result.choice).toBe(empty ? "input" : "wait");
  },
);

test.each([
  {
    role: "combobox",
    text: "London Heathrow",
    goal: "From London Heathrow (LHR) to Lisbon (LIS)",
    expected: "LHR",
  },
  {
    role: "combobox",
    text: "London Heathrow (LHR",
    goal: "From London Heathrow (LHR) to Lisbon (LIS)",
    expected: "LHR",
  },
  {
    role: "combobox",
    text: "London",
    goal: "Compare London (LHR) and London (LGW)",
    expected: "London",
  },
  {
    role: "combobox",
    text: "London (LHR)",
    goal: "Choose London (LGW)",
    expected: "London (LHR)",
  },
  {
    role: "combobox",
    text: "London Heathrow (LHR)",
    goal: "Choose London Heathrow (LHR)",
    expected: "LHR",
  },
  {
    role: "textbox",
    text: "London Heathrow (LHR)",
    goal: "Enter London Heathrow (LHR)",
    expected: "London Heathrow (LHR)",
  },
  {
    role: "combobox",
    text: "London Heathrow (LHR)",
    goal: "Choose London",
    expected: "London Heathrow (LHR)",
  },
  {
    role: "combobox",
    text: "Lisbon",
    goal: "Choose Lisbon",
    expected: "Lisbon",
  },
])(
  "autocomplete extracts only an explicit search identifier: $role $goal",
  async ({ role, text, goal, expected }) => {
    const state = page();
    const action = { ...state.actions[0]!, role };
    const p = provider(() => chatResponse({ text }));
    servers.push(p.server);
    expect(
      (await fieldText(fieldContext(goal, action, state, []), p.endpoint)).text,
    ).toBe(expected);
  },
);

test("autocomplete codes must come from the original goal, not a model instruction", async () => {
  const state = page();
  const action = { ...state.actions[0]!, role: "combobox" };
  const p = provider(() => chatResponse({ text: "London Heathrow" }));
  servers.push(p.server);
  const context = fieldContext(
    "Choose London Heathrow (LHR)",
    action,
    state,
    [],
    "Choose London Heathrow",
  );
  expect((await fieldText(context, p.endpoint)).text).toBe("London Heathrow");
});

test.each([false, true])(
  "calendar dates select the day then confirm, without editing Return: selected=%s",
  async (selected) => {
    const state = page();
    state.actions = [
      {
        id: "departure",
        kind: "fill",
        node: 1,
        role: "textbox",
        label: "Departure",
        value: "Sat, Oct 24",
        popup_owner: "doc:0",
      },
      {
        id: "return",
        kind: "fill",
        node: 2,
        role: "textbox",
        label: "Return",
        value: "",
        popup_owner: "doc:0",
      },
      {
        id: "date",
        kind: "click",
        node: 3,
        role: "gridcell",
        label: "Saturday, October 24, 2026, departure date.",
        selected: String(selected),
        popup_owner: "doc:0",
      },
      {
        id: "done",
        kind: "click",
        node: 4,
        role: "button",
        label:
          "Done. Search for one-way flights, departing on October 24, 2026",
        popup_owner: "doc:0",
      },
      {
        id: "wrong-year",
        kind: "click",
        node: 5,
        role: "gridcell",
        label: "Sunday, October 24, 2027",
        popup_owner: "doc:0",
      },
    ];
    const target = selected ? "4" : "3";
    const p = provider(async (request) => {
      const body = await request.json();
      expect(body.questions.type_text_target).toBeUndefined();
      expect(Object.keys(body.questions.click_target.criteria)).toEqual([
        target,
      ]);
      expect(
        body.state.elements.map((element: { index: string }) => element.index),
      ).toEqual([target]);
      return Response.json(decisionResponse(body, "CLICK", target));
    });
    servers.push(p.server);
    const decision = await choose(
      state,
      "Set the departure date",
      [],
      p.endpoint,
      false,
      undefined,
      [
        {
          kind: "value",
          label: "Departure",
          ref: "doc:0",
          equals: "2026-10-24",
        },
      ],
    );
    expect(decision.choice).toBe(selected ? "done" : "date");
  },
);

test("a date outside the visible calendar offers month navigation instead of the wrong day", async () => {
  const state = page();
  state.actions = [
    {
      id: "day",
      node: 1,
      popup_owner: "doc:0",
      role: "gridcell",
      kind: "click",
      label: "November 3, 2026",
      selected: "false",
    },
    {
      id: "next",
      node: 2,
      popup_owner: "doc:0",
      role: "button",
      kind: "click",
      label: "Next month",
    },
    {
      id: "done",
      node: 3,
      popup_owner: "doc:0",
      role: "button",
      kind: "click",
      label: "Done",
    },
  ];
  const p = provider(async (request) => {
    const body = await request.json();
    expect(Object.keys(body.questions.click_target.criteria)).toEqual(["2"]);
    return Response.json(decisionResponse(body, "CLICK", "2"));
  });
  servers.push(p.server);
  expect(
    (
      await choose(
        state,
        "Depart December 3",
        [],
        p.endpoint,
        false,
        undefined,
        [
          {
            kind: "value",
            label: "Departure",
            ref: "doc:0",
            equals: "2026-12-03",
          },
        ],
      )
    ).choice,
  ).toBe("next");
});

test("an explicit airport identifier selects its observed option instead of the city", async () => {
  const state = page();
  state.actions = [
    {
      id: "input",
      node: 1,
      popup_owner: "doc:0",
      kind: "fill",
      role: "combobox",
      label: "Where to?",
      value: "Lisbon",
    },
    {
      id: "city",
      node: 2,
      popup_owner: "doc:0",
      kind: "click",
      role: "option",
      label: "Lisbon, Portugal",
    },
    {
      id: "airport",
      node: 3,
      popup_owner: "doc:0",
      kind: "click",
      role: "option",
      label: "Humberto Delgado Airport (LIS)",
    },
    {
      id: "nearby",
      node: 4,
      popup_owner: "doc:0",
      kind: "click",
      role: "option",
      label: "Airport (LISX)",
    },
  ];
  const p = provider(async (request) => {
    const body = await request.json();
    expect(Object.keys(body.questions.click_target.criteria)).toEqual(["3"]);
    return Response.json(decisionResponse(body, "CLICK", "3"));
  });
  servers.push(p.server);
  expect(
    (
      await choose(
        state,
        "Select Lisbon (LIS)",
        [],
        p.endpoint,
        false,
        undefined,
        [
          {
            kind: "value",
            label: "Where to?",
            ref: "doc:0",
            equals: "Lisbon (LIS)",
          },
        ],
      )
    ).choice,
  ).toBe("airport");
});

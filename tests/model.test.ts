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
import type { DecisionRequest, ModelCall } from "../src/types";

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

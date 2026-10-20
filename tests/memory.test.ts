import { expect, test } from "bun:test";
import { Agent } from "../src/agent";
import { Browser } from "../src/browser";
import { RunMemory } from "../src/memory";
import { fieldContext } from "../src/model";
import { createPlan } from "../src/plan";
import { chatResponse, decisionResponse, page, provider } from "./helpers";
import type { AgentMemory, Checkpoint, DecisionRequest } from "../src/types";

test("run memory is bounded, updates revisited sources, and keeps summaries separate from evidence", () => {
  const memory = new RunMemory();
  const state = page();
  for (let i = 0; i < 14; i++) {
    memory.remember({
      ...state,
      url: `https://example.test/${i}`,
      title: `Page ${i}`,
      read_text: `${"Observed passage\n".repeat(1500)}Fact ${i}`,
    });
  }
  memory.remember({
    ...state,
    url: "https://example.test/2",
    text: "Updated fact",
  });
  expect(memory.sources()).toHaveLength(12);
  expect(memory.sources()[0]!.url).toEndWith("/3");
  expect(memory.sources().at(-1)!.text).toBe("Updated fact");
  expect(memory.sources().every((source) => source.text.length <= 16000)).toBe(
    true,
  );
  const context = memory.context(state, []);
  expect(context.pages).toHaveLength(4);
  expect(context.pages.every((source) => source.excerpt.length <= 1200)).toBe(
    true,
  );
  expect(memory.sources()[1]!.text.length).toBeGreaterThan(1200);
  expect(new RunMemory().context(state, [])).toEqual({
    pages: [],
    completed: [],
    lessons: [],
  });
});

test("no-change lessons are scoped to an exact observation and never learned from waiting or loading", () => {
  const memory = new RunMemory();
  const state = page();
  const action = state.actions[2]!;
  memory.record(state, action, false, 1);
  expect(memory.context(state, []).lessons[0]!.avoid).toBe(false);
  memory.record(state, action, false, 2);
  expect(memory.context(state, []).lessons[0]).toMatchObject({
    attempts: 2,
    avoid: true,
    choice: action.id,
  });
  for (const changed of [
    { ...state, document_id: "new-document" },
    { ...state, fingerprint: "changed-value" },
  ]) {
    expect(memory.context(changed, []).lessons[0]).toMatchObject({
      avoid: false,
      choice: null,
    });
  }
  memory.record(state, state.actions[3]!, false, 3);
  memory.record({ ...state, readiness: "loading" }, action, false, 4);
  expect(memory.context(state, []).lessons).toHaveLength(1);
  memory.record(state, action, true, 5);
  expect(memory.context(state, []).lessons).toHaveLength(0);
  memory.record(state, state.actions[0]!, false, 6);
  memory.record(state, state.actions[0]!, false, 7);
  expect(memory.context(state, []).lessons[0]!.avoid).toBe(false);
  for (let i = 0; i < 20; i++)
    memory.record({ ...state, fingerprint: String(i) }, action, false, i);
  expect(memory.context(state, []).lessons).toHaveLength(6);
});

test("replanning sends compact completed metadata and memory without duplicating saved page text or model traces", async () => {
  const state = page();
  const memory: AgentMemory = {
    pages: [
      {
        url: "https://example.test/previous",
        title: "Previous",
        excerpt: "Observed fact",
      },
    ],
    completed: [],
    lessons: [],
  };
  const checkpoint: Checkpoint = {
    instruction: "Read Previous",
    checks: [{ kind: "title", includes: "Previous" }],
    started_at_action: 0,
    started_fingerprint: "previous",
    verified: {
      fingerprint: "previous",
      url: memory.pages[0]!.url,
      action_count: 1,
      evidence: {
        title: "Previous",
        text: "Large saved observation ".repeat(1000),
      },
    },
  };
  const transport = provider(async (request) => {
    const body = await request.json();
    const input = JSON.parse(body.messages[1].content);
    expect(input.progress.completed[0]).toEqual({
      instruction: checkpoint.instruction,
      checks: checkpoint.checks,
      verified: { url: memory.pages[0]!.url, action_count: 1 },
    });
    expect(input.progress.memory).toEqual(memory);
    expect(body.messages[1].content.length).toBeLessThan(4000);
    expect(body.messages[1].content).not.toContain("Large saved observation");
    expect(body.messages[0].content).toContain("untrusted data");
    return chatResponse({
      steps: [
        {
          instruction: "Read Search",
          checks: [{ kind: "title", includes: "Search" }],
        },
      ],
    });
  });
  try {
    await createPlan(
      state,
      "Read Previous then Search",
      async () => transport.endpoint,
      [],
      undefined,
      {
        completed: [checkpoint],
        remaining: [],
        memory,
      },
    );
    const context = fieldContext(
      "Enter a value",
      state.actions[0]!,
      state,
      [],
      undefined,
      memory,
    );
    expect(context.memory).toEqual(memory);
  } finally {
    await transport.server.stop(true);
  }
});

test("a browser run learns an ineffective route, remembers prior pages, and verifies a sourced comparison", async () => {
  const site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const body =
        path === "/atlas"
          ? '<title>Atlas</title><p>Atlas costs 12 credits.</p><a href="/beacon">Continue to Beacon</a>'
          : path === "/beacon"
            ? '<title>Beacon</title><p>Beacon costs 18 credits.</p><a href="/summary">Continue to Summary</a>'
            : path === "/summary"
              ? "<title>Summary</title><p>Comparison workspace.</p>"
              : '<title>Start</title><button>Open Atlas</button><a href="/atlas">Continue to Atlas</a>';
      return new Response(
        `<!doctype html><style>body{font:18px sans-serif;padding:32px}button,a{display:block;margin:30px;padding:12px}</style>${body}`,
        {
          headers: { "Content-Type": "text/html" },
        },
      );
    },
  });
  const origin = `http://127.0.0.1:${site.port}`;
  let decisions = 0;
  let sawMemory = false;
  let sawLesson = false;
  const transport = provider(async (request) => {
    const body = await request.json();
    if (new URL(request.url).pathname.endsWith("systemone")) {
      decisions++;
      const memory: AgentMemory = body.state.memory;
      if (decisions === 3) {
        expect(memory.lessons[0]).toMatchObject({
          attempts: 2,
          avoid: true,
          action: "Open Atlas",
        });
        expect(body.state.bound_targets.CLICK).toBe("2");
        expect(body.questions.click_target).toBeUndefined();
        sawLesson = true;
      }
      if (body.state.page.title === "Beacon") {
        expect(
          memory.pages.some((source) =>
            source.excerpt.includes("Atlas costs 12 credits."),
          ),
        ).toBe(true);
        expect(
          memory.completed.some((step) => step.instruction === "Read Atlas"),
        ).toBe(true);
        sawMemory = true;
      }
      return Response.json(
        decisionResponse(body as DecisionRequest, "CLICK", "1"),
      );
    }
    const input = JSON.parse(body.messages[1].content);
    if (body.response_format.json_schema.name === "completion_review") {
      expect(
        input.sources.some((source: { text: string }) =>
          source.text.includes("Atlas costs 12 credits."),
        ),
      ).toBe(true);
      expect(
        input.sources.some((source: { text: string }) =>
          source.text.includes("Beacon costs 18 credits."),
        ),
      ).toBe(true);
      return chatResponse({
        complete: true,
        answer: "Atlas costs 12 credits; Beacon costs 18 credits.",
        evidence: [
          { url: `${origin}/atlas`, quote: "Atlas costs 12 credits." },
          { url: `${origin}/beacon`, quote: "Beacon costs 18 credits." },
        ],
        missing_steps: [],
      });
    }
    const remaining = input.progress
      ? input.progress.remaining
      : [
          {
            instruction: "Read Atlas",
            checks: [{ kind: "title", includes: "Atlas" }],
          },
          {
            instruction: "Read Beacon",
            checks: [{ kind: "title", includes: "Beacon" }],
          },
          {
            instruction: "Open Summary",
            checks: [{ kind: "title", includes: "Summary" }],
          },
        ];
    if (input.progress)
      expect(input.progress.memory.completed.length).toBeGreaterThan(0);
    return chatResponse({ steps: remaining });
  });
  const browser = await Browser.create(origin);
  const agent = new Agent(
    browser,
    await browser.observe(),
    "Read Atlas and Beacon, then open Summary and compare their costs.",
    {
      settings: async () => transport.settings,
      maxSteps: 10,
    },
  );
  try {
    for (let i = 0; i < 10 && agent.state.status !== "done"; i++)
      await agent.command("tick");
    expect(agent.state.status).toBe("done");
    expect(sawLesson).toBe(true);
    expect(sawMemory).toBe(true);
    expect(agent.state.history.map((entry) => entry.action)).toEqual([
      "Open Atlas",
      "Open Atlas",
      "Continue to Atlas",
      "Continue to Beacon",
      "Continue to Summary",
    ]);
    expect(agent.state.answer).toContain("12 credits");
    expect(agent.state.completion_reviews.at(-1)!.evidence).toHaveLength(2);
    const snapshot = agent.snapshot();
    snapshot.memory.pages[0]!.excerpt = "tampered";
    expect(agent.snapshot().memory.pages[0]!.excerpt).not.toBe("tampered");
  } finally {
    await agent.close();
    await transport.server.stop(true);
    await site.stop(true);
  }
}, 20000);

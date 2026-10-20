import { afterEach, expect, test } from "bun:test";
import { Agent } from "../src/agent";
import { chatResponse, decisionResponse, provider } from "./helpers";
import type { DecisionRequest, ElementView, TaskStep } from "../src/types";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function task(
  mode:
    "ordered" | "omitted" | "unseen" | "wrong-waypoint" | "invented-evidence",
  goal = mode === "omitted"
    ? "Open HTML then CSS."
    : "Open HTML, then CSS, then JavaScript. Explain what each technology does.",
) {
  const taskTimes: string[] = [];
  const visits: string[] = [];
  const pages: Record<string, [string, string, string]> = {
    "/": [
      "Guide",
      "Choose a topic.",
      '<a href="/html">HTML</a><a href="/js">JavaScript</a>',
    ],
    "/html": [
      "HTML",
      "HTML defines structure.",
      '<a href="/css">Learn CSS</a>',
    ],
    "/css": [
      "CSS",
      "CSS defines presentation.",
      '<a href="/js">JavaScript</a>',
    ],
    "/js": ["JavaScript", "JavaScript adds behavior.", '<a href="/">Home</a>'],
  };
  const site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname,
        content = pages[path];
      if (!content) return new Response("Not found", { status: 404 });
      visits.push(path);
      return new Response(
        `<!doctype html><title>${content[0]}</title><h1>${content[0]}</h1><p>${content[1]}</p><nav>${content[2]}</nav>`,
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  cleanup.push(() => site.stop(true));
  let planning = 0,
    reviews = 0,
    decisions = 0;
  const step = (label: string, path: string): TaskStep => ({
    instruction: `Open ${pages[path]![0]}`,
    checks: [
      { kind: "action", label, action: "click" },
      { kind: "url", includes: path },
      { kind: "title", includes: pages[path]![0] },
    ],
  });
  const models = provider(async (request) => {
    const body = await request.json();
    if (new URL(request.url).pathname.endsWith("chat/completions")) {
      const payload = JSON.parse(body.messages[1].content);
      if (body.response_format.json_schema.name === "goal_translation")
        return chatResponse({ translation: "Then open CSS." });
      expect(payload.original_goal).toBe(goal);
      expect(Number.isNaN(Date.parse(payload.task_time))).toBe(false);
      taskTimes.push(payload.task_time);
      if (body.response_format.json_schema.name === "completion_review") {
        reviews++;
        expect(payload.executed_actions[0]).toMatchObject({
          kind: "click",
          action: "HTML",
          page_changed: true,
        });
        if (
          mode === "omitted" &&
          !payload.checkpoints.some(
            (s: any) =>
              s.verified &&
              s.checks.some(
                (check: any) =>
                  check.kind === "url" && check.includes === "/css",
              ),
          )
        ) {
          return chatResponse({
            complete: false,
            answer: null,
            evidence: [],
            missing_steps: [step("Learn CSS", "/css")],
          });
        }
        const wanted =
          mode === "omitted" ? ["/html", "/css"] : ["/html", "/css", "/js"];
        const evidence = wanted.map((path) => ({
          url: `http://127.0.0.1:${site.port}${path}`,
          quote:
            mode === "invented-evidence"
              ? "This quote does not occur on any page."
              : pages[path]![1],
        }));
        return chatResponse({
          complete: true,
          answer: wanted.map((path) => pages[path]![1]).join(" "),
          evidence,
          missing_steps: [],
        });
      }
      planning++;
      if (payload.progress) {
        if (mode === "unseen")
          expect(payload.progress.completed[0].verified).not.toBeNull();
        else expect(payload.progress.completed).toEqual([]);
        return chatResponse({
          steps:
            mode === "wrong-waypoint"
              ? [step("HTML", "/html")]
              : [step("Learn CSS", "/css"), step("JavaScript", "/js")],
        });
      }
      return chatResponse({
        steps:
          mode === "omitted"
            ? [step("HTML", "/html")]
            : [
                step("HTML", "/html"),
                step(mode === "unseen" ? "Styles" : "Learn CSS", "/css"),
                step("JavaScript", "/js"),
              ],
      });
    }
    decisions++;
    const req = body as DecisionRequest;
    const elements = (req.state as { elements: ElementView[] }).elements;
    const instruction = String(req.questions.operation!.instructions).split(
      "\n",
    )[0]!;
    let label = instruction.includes("Open HTML")
      ? "HTML"
      : instruction.includes("Open CSS")
        ? "Learn CSS"
        : "JavaScript";
    if (mode === "wrong-waypoint" && decisions === 1) {
      expect(elements.some((element) => element.label === "JavaScript")).toBe(
        false,
      );
      return Response.json(decisionResponse(req, "CLICK", "2"));
    }
    const target = elements.find((element) => element.label === label);
    const blocked =
      !target || (mode === "unseen" && planning === 1 && label === "Learn CSS");
    return Response.json(
      decisionResponse(req, blocked ? "BLOCKED" : "CLICK", target?.index),
    );
  });
  cleanup.push(() => models.server.stop(true));
  const agent = await Agent.create(`http://127.0.0.1:${site.port}`, goal, {
    settings: async () => models.settings,
    maxSteps: 8,
  });
  cleanup.push(() => agent.close());
  let failure: unknown;
  try {
    for await (const _state of agent.run()) {
      /* Exercise the public loop. */
    }
  } catch (error) {
    failure = error;
  }
  return { agent, visits, planning, reviews, decisions, failure, taskTimes };
}

test("multi-page task preserves waypoint order and returns a sourced answer", async () => {
  const result = await task("ordered");
  expect(result.failure).toBeUndefined();
  expect(result.visits).toEqual(["/", "/html", "/css", "/js"]);
  expect(result.agent.state.status).toBe("done");
  expect(result.agent.state.answer).toBe(
    "HTML defines structure. CSS defines presentation. JavaScript adds behavior.",
  );
  expect(result.agent.state.completion_reviews[0]!.evidence).toHaveLength(3);
  expect(result.agent.state.checkpoints.every((step) => step.verified)).toBe(
    true,
  );
});

test.each(["Open HTML then CSS.", "Open HTML.\nبعدش صفحه CSS رو باز کن."])(
  "an omitted requirement is completed before DONE: %s",
  async (goal) => {
    const result = await task("omitted", goal);
    expect(result.failure).toBeUndefined();
    expect(result.visits).toEqual(["/", "/html", "/css"]);
    expect(result.reviews).toBe(goal.includes("\n") ? 4 : 2);
    expect(result.agent.state.plan_revisions).toHaveLength(1);
    expect(result.agent.state.checkpoints).toHaveLength(2);
    expect(result.agent.state.status).toBe("done");
    expect(new Set(result.taskTimes).size).toBe(1);
  },
);

test("unseen destination controls replan only remaining work and retain prior evidence", async () => {
  const result = await task("unseen");
  expect(result.failure).toBeUndefined();
  expect(result.planning).toBe(2);
  expect(result.visits).toEqual(["/", "/html", "/css", "/js"]);
  expect(
    result.agent.state.plan_revisions[0]!.checkpoints[0]!.verified?.url,
  ).toEndWith("/html");
  expect(result.agent.state.status).toBe("done");
});

test("a wrong first waypoint is rejected before navigation", async () => {
  const result = await task("wrong-waypoint");
  expect(result.failure).toBeInstanceOf(Error);
  expect(String(result.failure)).toContain("Invalid typed decision");
  expect(result.agent.state.status).toBe("error");
  expect(result.visits).toEqual(["/"]);
  expect(result.agent.state.history).toHaveLength(0);
  expect(result.agent.state.checkpoints[0]!.verified).toBeNull();
  expect(result.agent.state.answer).toBeNull();
});

test("unobserved answer citations fail closed after a bounded repair", async () => {
  const result = await task("invented-evidence");
  expect(result.failure).toBeInstanceOf(Error);
  expect(result.reviews).toBe(2);
  expect(result.agent.state.status).toBe("error");
  expect(result.agent.state.answer).toBeNull();
});

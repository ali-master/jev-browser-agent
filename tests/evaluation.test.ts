import { afterEach, expect, test } from "bun:test";
import { chromium } from "playwright";
import { startServer } from "../src/server";
import { SettingsStore } from "../src/config";
import {
  evaluateSuite,
  evaluationCases,
  inspectorEvaluationCases,
} from "../src/evaluation";
import {
  provider,
  chatResponse,
  completionResponse,
  decisionResponse,
} from "./helpers";
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("evaluation validates independent assertions before using providers", async () => {
  const scenario = {
    id: "test",
    url: "https://example.test",
    goal: "Read example",
    assertions: [{ kind: "title", includes: "Example" }],
  };
  expect(evaluationCases([scenario])).toHaveLength(1);
  expect(() => evaluationCases([scenario, scenario])).toThrow("unique");
  expect(() =>
    evaluationCases([
      {
        ...scenario,
        assertions: [{ kind: "action", action: "click", label: "Submit" }],
      },
    ]),
  ).toThrow("Invalid");
  expect(() =>
    evaluationCases([{ ...scenario, url: "file:///tmp/test" }]),
  ).toThrow("HTTP");
  const controller = new AbortController();
  controller.abort();
  const report = await evaluateSuite(
    [scenario],
    [
      {
        name: "unused",
        settings: async () => {
          throw Error("must not run");
        },
      },
    ],
    { signal: controller.signal },
  );
  expect(report.cancelled).toBe(true);
  expect(report.results).toHaveLength(0);
  expect(
    inspectorEvaluationCases("http://localhost:8766").map((c) => c.id),
  ).toEqual(["travel", "crowded", "research"]);
});

test("model comparisons detect false completion, attribute failures and count physical calls", async () => {
  const site = Bun.serve({
    port: 0,
    fetch: (req) =>
      new Response(
        new URL(req.url).pathname === "/result"
          ? "<title>Result</title><h1>Reached result</h1>"
          : '<a href="/result">Open result</a>',
        { headers: { "Content-Type": "text/html" } },
      ),
  });
  cleanup.push(() => site.stop(true));
  const url = `http://localhost:${site.port}`;
  const good = provider(async (req) => {
    const body = await req.json();
    if (req.url.endsWith("systemone"))
      return Response.json(decisionResponse(body, "CLICK"));
    if (body.response_format.json_schema.name === "completion_review")
      return completionResponse(body);
    return chatResponse({
      steps: [
        {
          instruction: `Click Open result to open ${url}/result`,
          checks: [
            { kind: "action", action: "click", label: "Open result" },
            { kind: "url", includes: `${url}/result` },
          ],
        },
      ],
    });
  });
  const bad = provider(() => chatResponse({ steps: [] }));
  cleanup.push(
    () => good.server.stop(true),
    () => bad.server.stop(true),
  );
  const cases = [true, false].map((valid) => ({
    id: valid ? "correct" : "false-done",
    url,
    goal: `Open ${url}/result.`,
    assertions: [{ kind: "title", includes: valid ? "Result" : "Not reached" }],
  }));
  const report = await evaluateSuite(cases, [
    { name: "good", settings: async () => good.settings },
    { name: "bad planner", settings: async () => bad.settings },
  ]);
  expect(report.results.map((r) => r.passed)).toEqual([
    true,
    false,
    false,
    false,
  ]);
  expect(report.results[1]).toMatchObject({
    agent_done: true,
    assertions_passed: false,
    failure_stage: "assertions",
  });
  expect(report.results[2]?.failure_stage).toBe("planning");
  expect(report.summary.map((s) => s.success_rate)).toEqual([0.5, 0]);
  expect(report.results[0]?.usage.total.requests).toBeGreaterThanOrEqual(3);
  expect(report.results[0]?.wall_ms).toBeGreaterThanOrEqual(
    report.results[0]!.model_ms,
  );
  expect(JSON.stringify(report)).not.toContain("test-key");
  const controller = new AbortController();
  const cancelled = await evaluateSuite(
    [cases[0]],
    [{ name: "cancel", settings: async () => good.settings }],
    {
      repeat: 3,
      signal: controller.signal,
      onResult: () => controller.abort(),
    },
  );
  expect(cancelled.cancelled).toBe(true);
  expect(cancelled.results).toHaveLength(1);
}, 30000);

test("inspector runs the lab separately, renders labels safely and exports reports", async () => {
  const model = provider(() => chatResponse({ steps: [] }));
  cleanup.push(() => model.server.stop(true));
  const store = new (class extends SettingsStore {
    override async read() {
      return model.settings;
    }
  })();
  const inspector = startServer({ port: 0, settings: store });
  cleanup.push(() => inspector.close());
  const rejected = await fetch(inspector.url + "/api/evaluate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect(rejected.status).toBe(403);
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(inspector.url);
  await page.locator("#model-lab summary").click();
  await page.locator("#evaluation-label").fill("<b>Local comparison</b>");
  await page.locator("#evaluation-start").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#evaluation-summary")!
      .textContent!.includes("0 / 3"),
  );
  expect(await page.locator("#evaluation-summary b").count()).toBe(0);
  expect(await page.locator("#evaluation-summary").textContent()).toContain(
    "<b>Local comparison</b>",
  );
  expect(await page.locator("#evaluation-results tr").count()).toBe(3);
  expect(await page.locator("#evaluation-download").isEnabled()).toBe(true);
  const snapshot = await fetch(inspector.url + "/api/state").then((r) =>
    r.json(),
  );
  expect(snapshot.status).toBe("idle");
  expect(snapshot.evaluation.reports).toHaveLength(1);
  expect(errors).toEqual([]);
}, 20000);

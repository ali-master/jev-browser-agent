import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright";
import { Agent } from "../src/agent.js";
import type { Browser } from "../src/browser.js";
import { SettingsStore } from "../src/config.js";
import { startServer } from "../src/server.js";
import {
  chatResponse,
  completionResponse,
  decisionResponse,
  fixture,
  provider,
} from "./helpers.js";
import type { DecisionRequest, ElementView } from "../src/types.js";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "jev-integration-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function localSite() {
  const site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(fixture, { headers: { "Content-Type": "text/html" } }),
  });
  cleanup.push(() => site.stop(true));
  return `http://127.0.0.1:${site.port}`;
}

function mockModels(beforeDecision?: () => Promise<void>) {
  const counts = { decisions: 0, text: 0, planning: 0, verification: 0 };
  const model = provider(async (request) => {
    if (new URL(request.url).pathname.endsWith("chat/completions")) {
      const body = await request.json();
      if (body.response_format?.json_schema?.name === "completion_review") {
        counts.verification++;
        return completionResponse(body);
      }
      if (body.response_format?.type !== "json_schema")
        return Response.json(
          { error: "response_format.type must be json_schema or text" },
          { status: 400 },
        );
      if (body.messages[0].content.includes("completion checklist")) {
        counts.planning++;
        return chatResponse({
          steps: [
            {
              instruction: "Enter Lisbon in City",
              checks: [{ kind: "value", label: "City", equals: "Lisbon" }],
            },
            {
              instruction: "Select Design from Category",
              checks: [{ kind: "value", label: "Category", equals: "Design" }],
            },
            {
              instruction: "Click Search hotels",
              checks: [
                { kind: "action", label: "Search hotels", action: "click" },
                { kind: "value", label: "City", equals: "Lisbon" },
                { kind: "value", label: "Category", equals: "Design" },
              ],
            },
          ],
        });
      }
      counts.text++;
      return chatResponse({ text: "Lisbon" });
    }
    counts.decisions++;
    await beforeDecision?.();
    const body = (await request.json()) as DecisionRequest;
    const state = body.state as { elements: ElementView[]; page: { text: string } };
    const city = state.elements.find((element) => element.label === "City")!;
    const category = state.elements.find((element) => element.label === "Category");
    const design = category?.options?.find((option) => option.value === "Design");
    let operation: string,
      target = "";
    if (city.value !== "Lisbon") {
      operation = "TYPE_TEXT";
      target = city.index;
    } else if (design) {
      operation = "SELECT";
      target = design.index;
    } else if (state.page.text.includes("Results: Lisbon / Design")) operation = "DONE";
    else {
      operation = "CLICK";
      target = state.elements.find((element) => element.label === "Search hotels")!.index;
    }
    return Response.json(decisionResponse(body, operation, target));
  });
  cleanup.push(() => model.server.stop(true));
  return { ...model, counts };
}

test("real Chromium + HTTP model transport completes a local task with independent DOM verification", async () => {
  const url = localSite();
  const models = mockModels();
  const directory = await temporary();
  const agent = await Agent.create(url, "Search for Design hotels in Lisbon", {
    settings: async () => models.settings,
    recordDir: directory,
  });
  cleanup.push(() => agent.close());
  for await (const _state of agent.run()) {
    /* Exercise the public async iterator. */
  }
  expect(agent.state.status).toBe("done");
  expect(agent.state.history.map((entry) => entry.operation)).toEqual([
    "TYPE_TEXT",
    "SELECT",
    "CLICK",
  ]);
  expect(models.counts).toEqual({ decisions: 3, text: 1, planning: 1, verification: 1 });
  expect(agent.state.checkpoints.every((step) => step.verified)).toBe(true);
  expect(
    agent.state.decisions.every(
      (decision) => !Object.hasOwn(decision.request.questions.operation!.criteria, "DONE"),
    ),
  ).toBe(true);
  const browser = agent.browser as Browser;
  expect(await browser.evaluate("document.querySelector('#city').value")).toBe("Lisbon");
  expect(await browser.evaluate("document.querySelector('#category').value")).toBe("Design");
  expect(await browser.evaluate("document.querySelector('#result').textContent")).toBe(
    "Results: Lisbon / Design",
  );
  expect(await browser.evaluate("window.submits")).toBe(1);
  const trace = await readFile(join(directory, "state.json"), "utf8");
  expect(JSON.parse(trace).history).toHaveLength(3);
  expect(trace).not.toContain("test-key");
});

test("inspector saves private settings and drives a complete task through its controls", async () => {
  const url = localSite();
  const models = mockModels();
  const store = new SettingsStore(await temporary(), {});
  const inspector = startServer({ port: 0, settings: store });
  cleanup.push(() => inspector.close());
  const browser = await chromium.launch();
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(inspector.url);
  await page.waitForFunction(
    () => (document.querySelector("#decision-base") as HTMLInputElement).value.length > 0,
  );
  for (const kind of ["decision", "text"]) {
    await page.locator(`#${kind}-base`).fill(models.endpoint.baseUrl);
    await page.locator(`#${kind}-model`).fill(models.endpoint.model);
    await page.locator(`#${kind}-key`).fill("private-test-key");
  }
  await page.getByRole("button", { name: "Save model settings" }).click();
  await page.waitForFunction(() =>
    document.querySelector("#settings-status")?.textContent?.startsWith("Saved"),
  );
  expect(await page.locator("#decision-key").inputValue()).toBe("");
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  const publicSettings = await (await fetch(`${inspector.url}/api/settings`)).text();
  expect(publicSettings).not.toContain("private-test-key");
  expect((await store.read()).decision.apiKey).toBe("private-test-key");
  await page.locator("#scenario").selectOption("custom");
  await page.locator("#start-url").fill(url);
  await page.locator("#goal").fill("Search for Design hotels in Lisbon");
  await page.locator("#run-mode").selectOption("manual");
  await page.locator("#pace").uncheck();
  await page.getByRole("button", { name: "Start task" }).click();
  await page.getByRole("button", { name: "Choose next" }).waitFor();
  await page.waitForFunction(
    () => !(document.querySelector("#choose") as HTMLButtonElement).disabled,
  );
  await page.getByRole("button", { name: "Choose next" }).click();
  await page.waitForFunction(
    () => !(document.querySelector("#execute") as HTMLButtonElement).disabled,
  );
  expect(models.counts.text).toBe(0);
  await page.getByRole("button", { name: "Execute choice" }).click();
  await page.waitForFunction(
    () => !(document.querySelector("#auto") as HTMLButtonElement).disabled,
  );
  await page.getByRole("button", { name: "Run automatically" }).click();
  await page.waitForFunction(() =>
    document.querySelector("#status")?.textContent?.startsWith("All steps verified"),
  );
  expect(models.counts).toEqual({ decisions: 3, text: 1, planning: 1, verification: 1 });
  expect(errors).toEqual([]);
  const state = await (await fetch(`${inspector.url}/api/state`)).json();
  expect(state.page.text).toContain("Results: Lisbon / Design");
  expect(state.history).toHaveLength(3);
  expect(JSON.stringify(state)).not.toContain("private-test-key");
  expect(state.frames).toHaveLength(4);
  expect(await page.locator("#progress-count").textContent()).toBe("3 of 3 verified");
  expect(await page.locator("#decision-details").getAttribute("open")).toBeNull();
  const firstFrame = await fetch(`${inspector.url}${state.frames[0].image_url}`);
  expect(firstFrame.headers.get("content-type")).toBe("image/jpeg");
  const firstImage = new Uint8Array(await firstFrame.arrayBuffer());
  expect([...firstImage.slice(0, 2)]).toEqual([255, 216]);
  await page.locator('#history [data-step="1"]').click();
  expect(await page.locator("#feed-status").textContent()).toBe("REVIEW");
  expect(await page.locator("#action-summary").textContent()).toContain("Type “Lisbon” in City");
  expect(await page.locator("#screenshot").getAttribute("src")).toBe(state.frames[1].image_url);
  expect((await (await fetch(`${inspector.url}/api/state`)).json()).history).toHaveLength(3);
  await page.locator("#return-live").click();
  expect(await page.locator("#feed-status").textContent()).toBe("FINAL PAGE");
  expect(await page.locator("#screenshot").getAttribute("src")).toStartWith("data:image/jpeg");
  await page.reload();
  await page.locator('#history [data-step="3"]').waitFor();
  expect(
    new Uint8Array(
      await (await fetch(`${inspector.url}${state.frames[0].image_url}`)).arrayBuffer(),
    ),
  ).toEqual(firstImage);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test("live inspector shows a pending model call and pauses before executing its choice", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  cleanup.push(release);
  const models = mockModels(() => gate);
  const store = new SettingsStore(await temporary(), {});
  await store.save(models.settings);
  const inspector = startServer({ port: 0, settings: store });
  cleanup.push(() => inspector.close());
  const browser = await chromium.launch();
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(inspector.url);
    await page.locator("#scenario").selectOption("custom");
    await page.locator("#start-url").fill(localSite());
    await page.locator("#goal").fill("Search for Design hotels in Lisbon");
    await page.locator("#pace").uncheck();
    await page.locator("#start").click();
    await page.waitForFunction(
      () => document.querySelector("#phase-label")?.textContent === "CHOOSING",
    );
    expect(models.counts.decisions).toBe(1);
    expect(await page.locator("#progress-count").textContent()).toBe("0 of 3 verified");
    expect(await page.locator("#feed-status").textContent()).toBe("LIVE");
    expect(await page.locator("#action-summary").textContent()).toBe("Choosing the next action");
    await page.locator("#stop").click();
    release();
    await page.waitForFunction(
      () => !(document.querySelector("#choose") as HTMLButtonElement).disabled,
    );
    const paused = await (await fetch(`${inspector.url}/api/state`)).json();
    expect(paused.history).toHaveLength(0);
    expect(paused.status).toBe("predicted");
    expect(models.counts.text).toBe(0);
    expect(await page.locator(".target.selected").count()).toBe(1);
    await page.locator("#auto").click();
    await page.waitForFunction(
      () => document.querySelector("#phase-label")?.textContent === "COMPLETE",
    );
    expect(models.counts).toEqual({ decisions: 3, text: 1, planning: 1, verification: 1 });
    expect((await (await fetch(`${inspector.url}/api/state`)).json()).history).toHaveLength(3);
    expect(errors).toEqual([]);
  } finally {
    release();
  }
}, 15_000);

test("inspector rejects foreign origins, hosts, missing tokens, malformed JSON and unknown routes", async () => {
  const inspector = startServer({ port: 0, settings: new SettingsStore(await temporary(), {}) });
  cleanup.push(() => inspector.close());
  const html = await (await fetch(inspector.url)).text();
  const token = html.match(/name="demo-token" content="([^"]+)"/)![1]!;
  const headers = { "Content-Type": "application/json", "X-Demo-Token": token };
  expect(
    (
      await fetch(`${inspector.url}/api/settings`, {
        method: "POST",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await fetch(`${inspector.url}/api/settings`, {
        method: "POST",
        body: "{}",
        headers: { ...headers, Origin: "https://evil.test" },
      })
    ).status,
  ).toBe(403);
  expect(
    (await fetch(`${inspector.url}/api/settings`, { headers: { Host: "evil.test" } })).status,
  ).toBe(403);
  const malformed = await fetch(`${inspector.url}/api/settings`, {
    method: "POST",
    headers,
    body: "secret-invalid-json",
  });
  expect(malformed.status).toBe(400);
  expect(await malformed.text()).not.toContain("secret-invalid-json");
  expect(
    (await fetch(`${inspector.url}/api/unknown`, { method: "POST", headers, body: "{}" })).status,
  ).toBe(404);
  expect((await fetch(`${inspector.url}/.jev/settings.json`)).status).toBe(404);
  expect(
    (await fetch(`${inspector.url}/api/events`, { headers: { Origin: "https://evil.test" } }))
      .status,
  ).toBe(403);
  expect((await fetch(`${inspector.url}/api/frames/unknown/0.jpg`)).status).toBe(404);
});

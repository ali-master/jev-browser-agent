import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { Browser, StalePage, fingerprint } from "../src/browser.js";
import { fixture, page } from "./helpers.js";

let server: Bun.Server<undefined>;
let browser: Browser;
beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(fixture, { headers: { "Content-Type": "text/html" } }),
  });
});
afterAll(async () => {
  await server.stop(true);
});
beforeEach(async () => {
  browser = await Browser.create(`http://127.0.0.1:${server.port}`);
});
afterEach(async () => {
  await browser?.close();
});

test("streams actual browser paints and navigation, then detaches without input", async () => {
  const frames: { image: string; url: string }[] = [];
  const stop = await browser.watchFrames((frame) => frames.push(frame));
  const waitForFrame = async (ready: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!ready() && Date.now() < deadline) await Bun.sleep(20);
    expect(ready()).toBe(true);
  };
  await waitForFrame(() => frames.length > 0);
  const first = frames[0]!;
  expect([...Buffer.from(first.image, "base64").subarray(0, 2)]).toEqual([255, 216]);
  await browser.evaluate("location.hash='stream-probe';document.body.style.background='red';true");
  await waitForFrame(() =>
    frames.some((frame) => frame.url.endsWith("#stream-probe") && frame.image !== first.image),
  );
  await stop();
  const count = frames.length;
  await browser.evaluate("document.body.style.background='blue';true");
  await Bun.sleep(100);
  expect(frames).toHaveLength(count);
  expect(await browser.evaluate("window.submits")).toBe(0);
});

test("observes native controls, types text, selects an observed option and submits once", async () => {
  let state = await browser.observe(true);
  expect(state.screenshot?.length).toBeGreaterThan(100);
  expect(
    state.actions.filter((action) => action.kind === "select").map((action) => action.value),
  ).toEqual(["Design"]);
  const city = state.actions.find((action) => action.kind === "fill")!;
  await browser.act(city, state, "Lisbon");
  state = await browser.observe();
  expect(await browser.evaluate("document.querySelector('#city').value")).toBe("Lisbon");
  await browser.act(
    state.actions.find((action) => action.kind === "select")!,
    state,
  );
  state = await browser.observe();
  await browser.act(
    state.actions.find((action) => action.label === "Search hotels")!,
    state,
  );
  await browser.observe();
  expect(await browser.evaluate("document.querySelector('#result').textContent")).toBe(
    "Results: Lisbon / Design",
  );
  expect(await browser.evaluate("window.submits")).toBe(1);
});

test("moving controls use current geometry without requiring another prediction", async () => {
  const state = await browser.observe();
  const action = state.actions.find((action) => action.label === "Search hotels")!;
  await browser.evaluate("document.querySelector('#search').style.transform='translateX(120px)'");
  expect(await browser.fresh(state, action)).toBe(true);
  await browser.act(action, state);
  expect(await browser.evaluate("window.submits")).toBe(1);
});

test.each([
  ["field value", "document.querySelector('#city').value='changed'"],
  ["checkbox", "document.querySelector('#refund').checked=true"],
  ["disabled target", "document.querySelector('#search').disabled=true"],
  [
    "accessible label",
    "document.querySelector('#search').setAttribute('aria-label','Delete all hotels');true",
  ],
  [
    "replaced node",
    "document.querySelector('#search').outerHTML=document.querySelector('#search').outerHTML",
  ],
  ["dropdown choice", "document.querySelector('#category').options[1].text='Coastal'"],
])("rejects stale %s before input", async (_name, mutation) => {
  const state = await browser.observe();
  const action = state.actions.find((action) => action.label === "Search hotels")!;
  await browser.evaluate(mutation!);
  expect(await browser.fresh(state, action)).toBe(false);
  await expect(browser.act(action, state)).rejects.toBeInstanceOf(StalePage);
  expect(await browser.evaluate("window.submits")).toBe(0);
});

test("textless overlay blocks clicks even when semantic state is unchanged", async () => {
  const state = await browser.observe();
  const action = state.actions.find((action) => action.label === "Search hotels")!;
  await browser.evaluate(
    "const cover=document.createElement('div');cover.style.cssText='position:fixed;inset:0;z-index:9999;background:white';document.body.append(cover);true",
  );
  expect(await browser.fresh(state)).toBe(true);
  await expect(browser.act(action, state)).rejects.toBeInstanceOf(StalePage);
  expect(await browser.evaluate("window.submits")).toBe(0);
});

test("passwords, hidden fields, disabled controls and offscreen text are excluded", async () => {
  await browser.evaluate(
    `document.body.insertAdjacentHTML('beforeend', '<input type="password" value="never-expose"><input type="hidden" value="hidden-secret"><button disabled>Disabled control</button><p style="position:absolute;top:3000px">Offscreen secret</p>');true`,
  );
  const state = await browser.observe();
  expect(JSON.stringify(state)).not.toContain("never-expose");
  expect(JSON.stringify(state)).not.toContain("hidden-secret");
  expect(state.text).not.toContain("Offscreen secret");
  expect(state.actions.some((action) => action.label === "Disabled control")).toBe(false);
});

test("fill waits for async autocomplete suggestions and navigation invalidates old observations", async () => {
  await browser.evaluate(`document.querySelector('#city').setAttribute('role','combobox');
    document.querySelector('#city').addEventListener('input',()=>setTimeout(()=>{
      document.querySelector('#result').innerHTML='<div role="option">Lisbon suggestion</div>';
    },60));true`);
  const state = await browser.observe();
  await browser.act(
    state.actions.find((action) => action.kind === "fill")!,
    state,
    "Lisbon",
  );
  const after = await browser.observe();
  expect(after.actions.some((action) => "role" in action && action.role === "option")).toBe(true);
  await browser.evaluate("location.href='about:blank';true");
  await Bun.sleep(80);
  expect(await browser.fresh(after)).toBe(false);
});

test("forged actions and invalid text never reach browser input", async () => {
  const state = await browser.observe();
  const action = state.actions.find((item) => item.kind === "fill")!;
  await expect(browser.act({ ...action, id: "invented" }, state, "hello")).rejects.toThrow(
    "observed page",
  );
  await expect(browser.act(action, state, "")).rejects.toThrow("nothing typed");
  expect(await browser.evaluate("document.querySelector('#city').value")).toBe("");
});

test("fingerprints ignore screenshots and geometry, but include node identity and field values", () => {
  const state = page();
  const other = structuredClone(state);
  other.screenshot = "new frame";
  if ("node" in other.actions[0]!) other.actions[0].rect = { x: 90, y: 20, w: 200, h: 30 };
  expect(fingerprint(other)).toBe(fingerprint(state));
  if ("node" in other.actions[0]!) other.actions[0].value = "new value";
  expect(fingerprint(other)).not.toBe(fingerprint(state));
});

test("an interrupted mutating evaluation is never classified as a safe stale retry", async () => {
  await expect(browser.evaluate("throw new Error('interrupted')", true)).rejects.not.toBeInstanceOf(
    StalePage,
  );
});

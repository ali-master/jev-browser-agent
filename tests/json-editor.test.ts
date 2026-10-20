import { afterEach, expect, test } from "bun:test";
import { chromium } from "playwright";
import { SettingsStore } from "../src/config";
import { startServer } from "../src/server";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Exercise the real inspector without reading credentials or contacting a model. */
async function editorPage() {
  const inspector = startServer({
    port: 0,
    settings: new SettingsStore(
      `/tmp/jev-json-editor-${crypto.randomUUID()}`,
      {},
    ),
  });
  cleanup.push(() => inspector.close());
  const browser = await chromium.launch();
  cleanup.push(() => browser.close());
  const page = await browser.newPage({ reducedMotion: "reduce" });
  await page.goto(inspector.url);
  if ((await page.locator("#model-settings").getAttribute("open")) !== null)
    await page.locator("#model-settings > summary").click();
  await page.locator(".run-options summary").click();
  return page;
}

test("JSON fields format without losing number precision, key order or escapes", async () => {
  const page = await editorPage();
  const fields = page.locator("textarea[data-json-editor]");
  expect(await fields.count()).toBe(3);
  for (const field of await fields.all()) {
    expect(await field.inputValue()).toBe("");
    expect(await field.getAttribute("placeholder")).toContain("\n");
  }
  expect(await page.locator("#secret-bindings .json-editor").count()).toBe(0);
  const field = page.getByLabel("Goal parameters · JSON", { exact: true });
  const editor = page.locator(".json-editor").filter({ has: field });
  const source = String.raw`{"city":"تهران","10":1e+20,"2":9007199254740993,"quote":"a\"b\\c\u0041","items":[true,false,null,{},[]],"city":"Lisbon"}`;
  await field.fill(source);
  await editor
    .getByRole("button", { name: "Format Goal parameters JSON" })
    .click();
  const formatted = await field.inputValue();
  expect(formatted).toBe(String.raw`{
  "city": "تهران",
  "10": 1e+20,
  "2": 9007199254740993,
  "quote": "a\"b\\c\u0041",
  "items": [
    true,
    false,
    null,
    {},
    []
  ],
  "city": "Lisbon"
}`);
  expect(JSON.parse(formatted)).toEqual(JSON.parse(source));
  expect(
    await editor.locator(".json-highlight").getAttribute("aria-hidden"),
  ).toBe("true");
  expect(await editor.locator(".json-key").allTextContents()).toEqual([
    '"city"',
    '"10"',
    '"2"',
    '"quote"',
    '"items"',
    '"city"',
  ]);
  expect(await editor.locator(".json-literal").allTextContents()).toEqual([
    "true",
    "false",
    "null",
  ]);
  expect(await editor.locator(".json-number").allTextContents()).toEqual([
    "1e+20",
    "9007199254740993",
  ]);
  expect(await editor.locator(".json-string").count()).toBe(3);

  await field.fill('{"ok":true}');
  await field.press("Control+Shift+F");
  expect(await field.inputValue()).toBe('{\n  "ok": true\n}');
  await field.fill('{"ok":false}');
  await field.press("Meta+Shift+F");
  expect(await field.inputValue()).toBe('{\n  "ok": false\n}');
  await field.fill("");
  expect(
    await field.evaluate((el: HTMLTextAreaElement) => el.validity.valid),
  ).toBe(true);
  expect(await editor.getByRole("button").isDisabled()).toBe(true);
}, 20_000);

test("invalid JSON blocks submission and formatting while valid JSON reaches the existing API", async () => {
  const page = await editorPage();
  const requests: Record<string, unknown>[] = [];
  await page.route("**/api/reset", (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({
      status: 400,
      contentType: "application/json",
      body: JSON.stringify({ error: "Test intercepted run" }),
    });
  });
  const field = page.locator("#workflow-params");
  const editor = page.locator(".json-editor").filter({ has: field });
  await field.fill('{"city":');
  expect(await field.getAttribute("aria-invalid")).toBe("true");
  expect(await editor.getByRole("status").textContent()).toContain(
    "Invalid JSON",
  );
  expect(await editor.getByRole("button").isDisabled()).toBe(true);
  await page.locator(".run-options summary").click();
  await page.getByRole("button", { name: "Start task" }).click();
  expect(
    await page.locator(".run-options").getAttribute("open"),
  ).not.toBeNull();
  expect(requests).toHaveLength(0);
  expect(await field.inputValue()).toBe('{"city":');

  await page.locator("#workflow-name").fill("hotel-search");
  await field.fill('{"city":"Lisbon","guests":2}');
  await page
    .locator("#output-schema")
    .fill('{"type":"object","properties":{"title":{"type":"string"}}}');
  await Promise.all([
    page.waitForResponse("**/api/reset"),
    page.getByRole("button", { name: "Start task" }).click(),
  ]);
  expect(requests[0]?.workflow).toEqual({
    name: "hotel-search",
    parameters: { city: "Lisbon", guests: 2 },
  });
  expect(requests[0]?.outputSchema).toEqual({
    type: "object",
    properties: { title: { type: "string" } },
  });
  expect(await field.getAttribute("aria-invalid")).toBe("false");
  await field.fill("   \n ");
  await Promise.all([
    page.waitForResponse("**/api/reset"),
    page.getByRole("button", { name: "Start task" }).click(),
  ]);
  expect(requests[1]?.workflow).toEqual({
    name: "hotel-search",
    parameters: {},
  });
}, 20_000);

test("highlighting treats pasted markup as text and leaves large input editable", async () => {
  const page = await editorPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const field = page.locator("#workflow-params");
  const editor = page.locator(".json-editor").filter({ has: field });
  const source = JSON.stringify({
    html: '<img src=x onerror="window.pwned=true">',
    script: "</script><script>alert(1)</script>",
  });
  await field.fill(source);
  expect(await editor.locator("img,script").count()).toBe(0);
  expect(await editor.locator(".json-highlight").textContent()).toBe(
    source + "\n",
  );
  await field.press("End");
  await field.press("ArrowLeft");
  await page.keyboard.insertText(" ");
  expect(await field.inputValue()).toBe(source.slice(0, -1) + " }");
  expect(
    await field.evaluate((el: HTMLTextAreaElement) => el.selectionStart),
  ).toBe(source.length);

  const large = JSON.stringify({ value: "x".repeat(65_000) });
  await field.fill(large);
  expect(await field.inputValue()).toBe(large);
  expect(
    await field.evaluate(
      (el: HTMLTextAreaElement) => getComputedStyle(el).color,
    ),
  ).not.toBe("rgba(0, 0, 0, 0)");
  expect(await editor.locator(".json-highlight").textContent()).toBe("");
  expect(await editor.getByRole("status").textContent()).toContain(
    "preview paused",
  );
  await field.fill('{"city":"Lisbon"}');
  expect(await editor.locator(".json-key").textContent()).toBe('"city"');
  expect(errors).toEqual([]);
}, 20_000);

test("highlighted text stays aligned while scrolling, resizing and switching themes", async () => {
  const page = await editorPage();
  const field = page.locator("#output-schema");
  const editor = page.locator(".json-editor").filter({ has: field });
  const source = JSON.stringify(
    {
      entries: Array.from({ length: 60 }, (_, i) => ({
        index: i,
        text: "x".repeat(250),
      })),
    },
    null,
    2,
  );
  await field.fill(source);
  await field.evaluate((el: HTMLTextAreaElement) => {
    el.style.height = "500px";
    el.scrollTop = 300;
    el.scrollLeft = 240;
    el.dispatchEvent(new Event("scroll"));
  });
  const alignment = await editor.evaluate((el) => {
    const input = el.querySelector("textarea")!;
    const pre = el.querySelector("pre")!;
    const geometry = (node: HTMLElement) => {
      const css = getComputedStyle(node);
      return [
        node.clientHeight,
        css.font,
        css.padding,
        node.scrollTop,
        node.scrollLeft,
      ];
    };
    return [geometry(input), geometry(pre)];
  });
  expect(alignment[0]).toEqual(alignment[1]);
  const colors: string[] = [];
  for (const colorScheme of ["dark", "light"] as const) {
    await page
      .getByRole("combobox", { name: "Color theme" })
      .selectOption(colorScheme);
    colors.push(
      await editor
        .locator(".json-key")
        .first()
        .evaluate((el) => getComputedStyle(el).color),
    );
    for (const width of [320, 390, 768, 1238]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  }
  expect(colors[0]).not.toBe(colors[1]);
  await page.emulateMedia({ forcedColors: "active" });
  expect(await editor.locator(".json-highlight").isVisible()).toBe(false);
  expect(
    await field.evaluate(
      (el: HTMLTextAreaElement) => getComputedStyle(el).color,
    ),
  ).not.toBe("rgba(0, 0, 0, 0)");
  expect(await field.inputValue()).toBe(source);
}, 20_000);

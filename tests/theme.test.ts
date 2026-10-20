import { afterEach, expect, test } from "bun:test";
import { chromium } from "playwright";
import { startServer } from "../src/server";
import { SettingsStore } from "../src/config";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("configuration cards stay visible and toggle by keyboard without losing form edits", async () => {
  const inspector = startServer({
    port: 0,
    settings: new SettingsStore(
      `/tmp/jev-settings-cards-${crypto.randomUUID()}`,
      {
        TYPESAFE_MODEL: "test-decision",
        TEXT_MODEL: "test-helper",
      },
    ),
  });
  cleanup.push(() => inspector.close());
  const browser = await chromium.launch();
  cleanup.push(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1238, height: 900 },
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(inspector.url);
  await page.waitForFunction(
    () => !document.querySelector<HTMLDetailsElement>("#model-settings")!.open,
  );
  const settings = page.locator("#model-settings > summary");
  const lab = page.locator("#model-lab > summary");
  const options = page.locator(".run-options > summary");
  for (const colorScheme of ["light", "dark"] as const) {
    await page
      .getByRole("combobox", { name: "Color theme" })
      .selectOption(colorScheme);
    for (const width of [320, 390, 768, 1238]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => scrollTo(0, 0));
      for (const card of [settings, lab, options]) {
        const box = await card.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(80);
        expect(box!.y).toBeGreaterThanOrEqual(0);
        expect(box!.y + box!.height).toBeLessThanOrEqual(900);
        expect(await card.isVisible()).toBe(true);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  }
  await settings.focus();
  await settings.press("Enter");
  expect(await page.locator("#decision-model").isVisible()).toBe(true);
  await page.setViewportSize({ width: 320, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 1238, height: 900 });
  await page.locator("#decision-model").fill("updated-model");
  await settings.press("Space");
  expect(await page.locator("#decision-model").isVisible()).toBe(false);
  await settings.press("Enter");
  expect(await page.locator("#decision-model").inputValue()).toBe(
    "updated-model",
  );
  expect(await settings.locator(".settings-label-open").isVisible()).toBe(true);
  await settings.press("Space");
  await lab.focus();
  await lab.press("Enter");
  expect(await page.locator("#evaluation-label").isVisible()).toBe(true);
  await page.locator("#evaluation-label").fill("Comparison draft");
  await lab.press("Space");
  expect(await page.locator("#evaluation-label").isVisible()).toBe(false);
  await lab.press("Enter");
  expect(await page.locator("#evaluation-label").inputValue()).toBe(
    "Comparison draft",
  );
  expect(await lab.locator(".settings-label-open").isVisible()).toBe(true);
  await lab.press("Space");
  await options.focus();
  await options.press("Enter");
  await page.locator("#workflow-name").fill("saved-draft");
  await page.locator("#workflow-params").fill('{"city":"Lisbon"}');
  await options.press("Space");
  expect(await page.locator("#workflow-name").isVisible()).toBe(false);
  await options.press("Enter");
  expect(await page.locator("#workflow-name").inputValue()).toBe("saved-draft");
  expect(await page.locator("#workflow-params").inputValue()).toBe(
    '{"city":"Lisbon"}',
  );
  expect(await options.locator(".settings-label-closed").isVisible()).toBe(
    false,
  );
  expect(errors).toEqual([]);
}, 20_000);

test("inspector applies Zinc before styles load and preserves an explicit theme across reloads", async () => {
  const inspector = startServer({ port: 0 });
  cleanup.push(() => inspector.close());
  const browser = await chromium.launch();
  cleanup.push(() => browser.close());
  const page = await browser.newPage({
    colorScheme: "dark",
    reducedMotion: "reduce",
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const stylesheet = Promise.withResolvers<void>();
  await page.route("**/style.css", async (route) => {
    await stylesheet.promise;
    await route.continue();
  });
  try {
    await page.goto(inspector.url, { waitUntil: "commit" });
    await page.waitForFunction(
      () => document.documentElement.dataset.theme === "dark",
    );
    expect(await page.evaluate(() => document.styleSheets.length)).toBe(0);
  } finally {
    stylesheet.resolve();
  }
  await page.waitForLoadState();
  const theme = page.getByRole("combobox", { name: "Color theme" });
  expect(await theme.inputValue()).toBe("system");
  expect(await theme.isEnabled()).toBe(true);
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).backgroundColor,
    ),
  ).toBe("rgb(9, 9, 11)");
  const surfaces = page.locator(
    "header, #task-form, #scenario, .browser-bar, .viewport, #decision-base",
  );
  const dark = await surfaces.evaluateAll((elements) =>
    elements.map((el) => getComputedStyle(el).backgroundColor),
  );

  await theme.focus();
  await theme.press("Space");
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  expect(await theme.inputValue()).toBe("light");
  expect(await page.locator("html").getAttribute("data-theme")).toBe("light");
  const light = await surfaces.evaluateAll((elements) =>
    elements.map((el) => getComputedStyle(el).backgroundColor),
  );
  expect(light.length).toBe(6);
  for (let i = 0; i < light.length; i++) expect(light[i]).not.toBe(dark[i]);
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await page.locator("html").getAttribute("data-theme")).toBe("light");
  await page.reload();
  expect(await theme.inputValue()).toBe("light");
  expect(await page.locator("html").getAttribute("data-theme")).toBe("light");

  await theme.selectOption("dark");
  await page.emulateMedia({ colorScheme: "light" });
  await page.reload();
  expect(await theme.inputValue()).toBe("dark");
  expect(
    await page.locator('meta[name="theme-color"]').getAttribute("content"),
  ).toBe("#09090b");
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).colorScheme,
    ),
  ).toBe("dark");

  await theme.selectOption("system");
  expect(await page.locator("html").getAttribute("data-theme")).toBe("light");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "dark",
  );
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    await page.waitForFunction(
      (value) => document.documentElement.dataset.theme === value,
      colorScheme,
    );
    for (const width of [320, 390, 768, 1238]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await theme.isVisible()).toBe(true);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  }
  await page.evaluate(() => localStorage.setItem("jev-theme", "invalid"));
  await page.reload();
  expect(await theme.inputValue()).toBe("system");
  expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
  expect(errors).toEqual([]);
}, 20_000);

test("theme switching remains usable when browser storage is unavailable", async () => {
  const inspector = startServer({ port: 0 });
  cleanup.push(() => inspector.close());
  const browser = await chromium.launch();
  cleanup.push(() => browser.close());
  const page = await browser.newPage({ colorScheme: "light" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    for (const method of ["getItem", "setItem"]) {
      Object.defineProperty(Storage.prototype, method, {
        value() {
          throw new DOMException("Storage blocked", "SecurityError");
        },
      });
    }
  });
  await page.goto(inspector.url);
  const theme = page.getByRole("combobox", { name: "Color theme" });
  expect(await theme.inputValue()).toBe("system");
  await theme.selectOption("dark");
  expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
  await page.reload();
  expect(await theme.inputValue()).toBe("system");
  expect(await page.locator("html").getAttribute("data-theme")).toBe("light");
  expect(errors).toEqual([]);
}, 15_000);

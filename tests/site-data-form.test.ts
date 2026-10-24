import { afterEach, expect, test } from "bun:test";
import { chromium, type Locator } from "playwright";
import { SettingsStore } from "../src/config";
import { siteDataOptions, type SiteData } from "../src/site-data";
import { startServer } from "../src/server";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Exercise the shipped form in an isolated inspector without the user's models or settings. */
async function formPage() {
  const inspector = startServer({
    port: 0,
    settings: new SettingsStore(
      `/tmp/jev-site-data-ui-${crypto.randomUUID()}`,
      {},
    ),
  });
  cleanup.push(() => inspector.close());
  const browser = await chromium.launch();
  cleanup.push(() => browser.close());
  const page = await browser.newPage({ reducedMotion: "reduce" });
  await page.goto(inspector.url);
  await page.locator(".run-options > summary").click();
  await page
    .getByRole("combobox", { name: "Execution mode" })
    .selectOption("manual");
  return page;
}

/** Enter fake values through the accessible form, preserving whitespace and empty values. */
async function fillEntry(card: Locator, name: string, value = "") {
  await card.getByLabel("Site origin").fill("https://example.com/");
  await card.getByLabel("Name", { exact: true }).fill(name);
  await card.getByLabel("Value", { exact: true }).fill(value);
}

test("site data cards edit all stores, distinguish deletes from empty values and discard submitted drafts", async () => {
  const page = await formPage();
  const snapshot = await page.evaluate(() =>
    fetch("/api/state").then((r) => r.json()),
  );
  const bodies: { siteData?: SiteData }[] = [];
  const received = Promise.withResolvers<void>(),
    respond = Promise.withResolvers<void>();
  await page.route("**/api/reset", async (route) => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) {
      received.resolve();
      await respond.promise;
      await route.fulfill({
        status: 400,
        json: { error: "Test connection unavailable" },
      });
    } else await route.fulfill({ json: snapshot });
  });
  await page.getByRole("button", { name: "+ Cookie", exact: true }).click();
  const cookie = page.getByRole("article", { name: "Cookie 01", exact: true });
  await fillEntry(cookie, "login", "fake-cookie-token");
  await cookie.locator("summary").click();
  await cookie.getByLabel("HttpOnly", { exact: false }).check();
  await cookie.getByLabel("Path", { exact: true }).fill("/account");
  await cookie.getByLabel("Expires", { exact: false }).fill("2000000000");
  await cookie.getByLabel("SameSite", { exact: true }).selectOption("Strict");
  await cookie.getByRole("button", { name: "Show Cookie 01 value" }).click();
  expect(
    await cookie.getByLabel("Value", { exact: true }).getAttribute("type"),
  ).toBe("text");
  await page
    .getByRole("button", { name: "+ localStorage", exact: true })
    .click();
  const local = page.getByRole("article", {
    name: "localStorage 02",
    exact: true,
  });
  await fillEntry(local, "__proto__", "  literal value  ");
  await page
    .getByRole("button", { name: "+ localStorage", exact: true })
    .click();
  const deleted = page.getByRole("article", {
    name: "localStorage 03",
    exact: true,
  });
  await fillEntry(deleted, "old", "ignored");
  await deleted.getByLabel("Delete this stored entry when starting").check();
  expect(await deleted.getByLabel("Value", { exact: true }).isDisabled()).toBe(
    true,
  );
  await page
    .getByRole("button", { name: "+ sessionStorage", exact: true })
    .click();
  const session = page.getByRole("article", {
    name: "sessionStorage 04",
    exact: true,
  });
  await fillEntry(session, "empty");
  await page.getByRole("button", { name: "Start task" }).click();
  await received.promise;
  expect(
    await cookie.getByLabel("Value", { exact: true }).getAttribute("type"),
  ).toBe("password");
  expect(await cookie.getByLabel("Value", { exact: true }).isDisabled()).toBe(
    true,
  );
  expect(
    await page
      .getByRole("button", { name: "+ Cookie", exact: true })
      .isDisabled(),
  ).toBe(true);
  respond.resolve();
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>("#start")!.disabled,
  );
  expect(await cookie.getByLabel("Value", { exact: true }).inputValue()).toBe(
    "fake-cookie-token",
  );
  expect(bodies[0]?.siteData).toEqual({
    cookies: [
      {
        origin: "https://example.com",
        name: "login",
        value: "fake-cookie-token",
        path: "/account",
        expires: 2000000000,
        httpOnly: true,
        sameSite: "Strict",
      },
    ],
    localStorage: {
      "https://example.com": JSON.parse(
        '{"__proto__":"  literal value  ","old":null}',
      ),
    },
    sessionStorage: { "https://example.com": { empty: "" } },
  });
  expect(() => siteDataOptions(bodies[0]?.siteData)).not.toThrow();
  await page.getByRole("button", { name: "Start task" }).click();
  await page.waitForFunction(
    () => !document.querySelector("#site-data-list")!.children.length,
  );
  expect(await page.locator("#site-data-empty").isVisible()).toBe(true);
  expect(await page.locator("body").innerHTML()).not.toContain(
    "fake-cookie-token",
  );
  await page.getByRole("button", { name: "Start task" }).click();
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>("#start")!.disabled,
  );
  expect(bodies).toHaveLength(3);
  expect(bodies[2]).not.toHaveProperty("siteData");
}, 25_000);

test("site data validates origins and duplicate identities and remains usable in both themes on mobile", async () => {
  const page = await formPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let requests = 0;
  await page.route("**/api/reset", async (route) => {
    requests++;
    await route.abort();
  });
  await page.getByRole("button", { name: "+ Cookie", exact: true }).click();
  const card = page.getByRole("article", { name: "Cookie 01", exact: true });
  await fillEntry(card, "pref", "test");
  await card.getByLabel("Site origin").fill("https://example.com/path");
  await page.getByRole("button", { name: "Start task" }).click();
  expect(
    await card.getByLabel("Site origin").getAttribute("aria-invalid"),
  ).toBe("true");
  await card.getByLabel("Site origin").fill("https://example.com:444");
  await page.getByRole("button", { name: "+ Cookie", exact: true }).click();
  const duplicate = page.getByRole("article", {
    name: "Cookie 02",
    exact: true,
  });
  await fillEntry(duplicate, "pref");
  await page.getByRole("button", { name: "Start task" }).click();
  expect(
    await card.getByLabel("Name", { exact: true }).getAttribute("aria-invalid"),
  ).toBe("true");
  expect(requests).toBe(0);
  await page
    .getByRole("button", { name: "Remove Cookie 02", exact: true })
    .click();
  expect(
    await card.getByLabel("Name", { exact: true }).getAttribute("aria-invalid"),
  ).toBe("false");
  await card.locator("summary").click();
  for (const theme of ["dark", "light"] as const) {
    await page
      .getByRole("combobox", { name: "Color theme" })
      .selectOption(theme);
    for (const width of [320, 390, 768, 1238]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
  }
  expect(
    await page.evaluate(() =>
      JSON.stringify({
        local: { ...localStorage },
        session: { ...sessionStorage },
      }),
    ),
  ).not.toContain("example.com");
  await page.reload();
  await page.locator(".run-options > summary").click();
  expect(await page.locator(".site-data-card").count()).toBe(0);
  expect(errors).toEqual([]);
}, 25_000);

import { afterEach, expect, test } from "bun:test";
import { chromium, type Locator } from "playwright";
import { SettingsStore } from "../src/config";
import { SecretVault, type Secrets } from "../src/credentials";
import { startServer } from "../src/server";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

/** Test the real form without using configured credentials or contacting a provider. */
async function formPage() {
  const inspector = startServer({
    port: 0,
    settings: new SettingsStore(
      `/tmp/jev-secrets-ui-${crypto.randomUUID()}`,
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
  await page
    .getByRole("combobox", { name: "Execution mode" })
    .selectOption("manual");
  return page;
}

/** Use clearly fake values to exercise each required binding field. */
async function fillSecret(card: Locator, name = "password") {
  await card.getByLabel("Reference name", { exact: true }).fill(name);
  await card
    .getByLabel("Secret value", { exact: true })
    .fill("  fake-password-123  ");
  await card
    .getByLabel("Allowed site", { exact: true })
    .fill("https://example.com/");
  await card.getByLabel("Destination field", { exact: true }).fill("Password");
}

test("secret cards add, mask, reveal and remove values with accessible references", async () => {
  const page = await formPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  expect(await page.locator("#secret-empty").isVisible()).toBe(true);
  await page.getByRole("button", { name: "Add secret", exact: true }).click();
  const card = page.getByRole("article", { name: "Secret 01" });
  expect(
    await card
      .getByLabel("Reference name", { exact: true })
      .evaluate((el) => el === document.activeElement),
  ).toBe(true);
  await fillSecret(card);
  expect(await card.locator(".secret-reference code").textContent()).toBe(
    "{{secret:password}}",
  );
  const value = card.getByLabel("Secret value", { exact: true });
  expect(await value.getAttribute("type")).toBe("password");
  await card.getByRole("button", { name: "Show secret 1 value" }).click();
  expect(await value.getAttribute("type")).toBe("text");
  expect(
    await card
      .getByRole("button", { name: "Hide secret 1 value" })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  await card.getByRole("button", { name: "Hide secret 1 value" }).click();
  expect(await value.getAttribute("type")).toBe("password");
  expect(await page.locator("body").textContent()).not.toContain(
    "fake-password-123",
  );
  expect(await page.locator("body").innerHTML()).not.toContain(
    "fake-password-123",
  );
  expect(
    await page.evaluate(() => JSON.stringify([localStorage, sessionStorage])),
  ).not.toContain("fake-password-123");

  await page.getByRole("button", { name: "Add secret", exact: true }).click();
  const second = page.getByRole("article", { name: "Secret 02" });
  await fillSecret(second, "token");
  await card.getByRole("button", { name: "Remove secret 1" }).click();
  const remaining = page.getByRole("article", { name: "Secret 01" });
  expect(
    await remaining.getByLabel("Reference name", { exact: true }).inputValue(),
  ).toBe("token");
  expect(
    await remaining
      .getByLabel("Reference name", { exact: true })
      .evaluate((el) => el === document.activeElement),
  ).toBe(true);
  await remaining.getByRole("button", { name: "Remove secret 1" }).click();
  expect(await page.locator("#secret-list input").count()).toBe(0);
  expect(await page.locator("#secret-empty").isVisible()).toBe(true);
  expect(
    await page
      .locator("#add-secret")
      .evaluate((el) => el === document.activeElement),
  ).toBe(true);
  expect(errors).toEqual([]);
}, 20_000);

test("binding validation rejects incomplete, duplicate and unsafe destinations before starting", async () => {
  const page = await formPage();
  let requests = 0;
  await page.route("**/api/reset", (route) => {
    requests++;
    return route.fulfill({
      status: 400,
      json: { error: "Unexpected submission" },
    });
  });
  await page.getByRole("button", { name: "Add secret", exact: true }).click();
  await page.locator(".run-options summary").click();
  await page.getByRole("button", { name: "Start task" }).click();
  expect(
    await page.locator(".run-options").getAttribute("open"),
  ).not.toBeNull();
  const first = page.getByRole("article", { name: "Secret 01" });
  expect(await first.locator(".secret-error:not([hidden])").count()).toBe(4);
  await fillSecret(first);
  const origin = first.getByLabel("Allowed site", { exact: true });
  for (const invalid of [
    "https://example.com/login",
    "https://example.com?q=x",
    "https://example.com/#x",
    "https://user:pass@example.com",
    "javascript:alert(1)",
    "file:///tmp/password",
  ]) {
    await origin.fill(invalid);
    expect(await origin.getAttribute("aria-invalid")).toBe("true");
    await page.getByRole("button", { name: "Start task" }).click();
  }
  await origin.fill("https://example.com/");
  await first.getByLabel("Reference name", { exact: true }).fill("bad name");
  expect(
    await first
      .getByLabel("Reference name", { exact: true })
      .getAttribute("aria-invalid"),
  ).toBe("true");
  await first.getByLabel("Reference name", { exact: true }).fill("password");
  await first
    .getByLabel("Secret value", { exact: true })
    .fill("{{secret:password}}");
  expect(
    await first
      .getByLabel("Secret value", { exact: true })
      .getAttribute("aria-invalid"),
  ).toBe("true");
  await first.getByLabel("Secret value", { exact: true }).fill("test-value");
  await page.getByRole("button", { name: "Add secret", exact: true }).click();
  const second = page.getByRole("article", { name: "Secret 02" });
  await fillSecret(second);
  expect(
    await first
      .getByLabel("Reference name", { exact: true })
      .getAttribute("aria-invalid"),
  ).toBe("true");
  expect(
    await second
      .getByLabel("Reference name", { exact: true })
      .getAttribute("aria-invalid"),
  ).toBe("true");
  await second
    .getByLabel("Reference name", { exact: true })
    .fill("otherPassword");
  expect(
    await second
      .getByLabel("Destination field", { exact: true })
      .getAttribute("aria-invalid"),
  ).toBe("true");
  await page.getByRole("button", { name: "Start task" }).click();
  await second.getByLabel("Destination field", { exact: true }).fill("Token");
  expect(
    await page
      .locator("#task-form")
      .evaluate((el: HTMLFormElement) => el.checkValidity()),
  ).toBe(true);
  expect(requests).toBe(0);
}, 20_000);

test("submission preserves private values, masks failures and clears successful requests", async () => {
  const page = await formPage();
  const snapshot = await page.evaluate(() =>
    fetch("/api/state").then((r) => r.json()),
  );
  const bodies: { secrets?: Secrets }[] = [];
  const received = Promise.withResolvers<void>();
  const respond = Promise.withResolvers<void>();
  await page.route("**/api/reset", async (route) => {
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1) {
      received.resolve();
      await respond.promise;
      await route.fulfill({
        status: 400,
        json: { error: "Test model unavailable" },
      });
    } else await route.fulfill({ json: snapshot });
  });
  await page.getByRole("button", { name: "Add secret", exact: true }).click();
  const card = page.getByRole("article", { name: "Secret 01" });
  await fillSecret(card);
  await card.getByRole("button", { name: "Show secret 1 value" }).click();
  await page.getByRole("button", { name: "Start task" }).click();
  await received.promise;
  expect(
    await card.getByLabel("Secret value", { exact: true }).isDisabled(),
  ).toBe(true);
  expect(
    await card.getByLabel("Secret value", { exact: true }).getAttribute("type"),
  ).toBe("password");
  expect(await page.locator("#add-secret").isDisabled()).toBe(true);
  respond.resolve();
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>("#start")!.disabled,
  );
  expect(
    await card.getByLabel("Secret value", { exact: true }).inputValue(),
  ).toBe("  fake-password-123  ");
  expect(bodies[0]?.secrets).toEqual({
    password: {
      value: "  fake-password-123  ",
      origin: "https://example.com",
      label: "Password",
    },
  });
  expect(new SecretVault(bodies[0]?.secrets).enabled).toBe(true);
  await page.getByRole("button", { name: "Start task" }).click();
  await page.waitForFunction(
    () => !document.querySelector("#secret-list")!.children.length,
  );
  expect(await page.locator("#secret-empty").isVisible()).toBe(true);
  expect(await page.locator("#secret-count").textContent()).toBe(
    "No secrets added",
  );
  expect(await page.locator("body").innerHTML()).not.toContain(
    "fake-password-123",
  );
  await page.getByRole("button", { name: "Start task" }).click();
  await page.waitForFunction(
    () => !document.querySelector<HTMLButtonElement>("#start")!.disabled,
  );
  expect(bodies).toHaveLength(3);
  expect(bodies[2]).not.toHaveProperty("secrets");
}, 20_000);

test("the secrets form fits both themes on mobile, respects the vault limit and discards reloads", async () => {
  const page = await formPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const add = page.getByRole("button", { name: "Add secret", exact: true });
  await add.click();
  await fillSecret(page.getByRole("article", { name: "Secret 01" }));
  for (const colorScheme of ["dark", "light"] as const) {
    await page
      .getByRole("combobox", { name: "Color theme" })
      .selectOption(colorScheme);
    for (const width of [320, 390, 768, 1238]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const overlap = await page
        .locator(".secret-value-control")
        .evaluate((el) => {
          const input = el.querySelector("input")!;
          const button = el.querySelector("button")!;
          return (
            parseFloat(getComputedStyle(input).paddingRight) >=
            button.getBoundingClientRect().width
          );
        });
      expect(overlap).toBe(true);
    }
  }
  for (let i = 1; i < 20; i++) await add.click();
  expect(await page.locator(".secret-card").count()).toBe(20);
  expect(await add.isDisabled()).toBe(true);
  await page
    .getByRole("button", { name: "Remove secret 20", exact: true })
    .click();
  expect(await add.isEnabled()).toBe(true);
  await page.reload();
  await page.locator(".run-options summary").click();
  expect(await page.locator(".secret-card").count()).toBe(0);
  expect(await page.locator("#secret-empty").isVisible()).toBe(true);
  expect(errors).toEqual([]);
}, 30_000);

import { expect, test } from "bun:test";
import { chromium } from "playwright";

test("landing examples copy independently and remain usable across themes and narrow screens", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const file = Bun.file(
        new URL(
          `../assets${path === "/" ? "/index.html" : path}`,
          import.meta.url,
        ),
      );
      return (await file.exists())
        ? new Response(file)
        : new Response(null, { status: 404 });
    },
  });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      permissions: ["clipboard-read", "clipboard-write"],
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.href);
    expect(await page.locator("#scenarios .scenario-grid li").count()).toBe(8);
    const answer = (await page.locator("#answer-example").innerText()).trim();
    await page.locator("[data-copy-target]").click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      answer,
    );
    expect(answer).toContain("[2, 4, 6]");
    expect(answer).toContain("[2, 3]");

    await page.getByRole("tab", { name: "04 CLI" }).click();
    const commands = await page.locator("#panel-cli pre code").innerText();
    await page.locator(".code-window [data-copy]").click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      commands,
    );
    expect(commands).toContain("bun add --global @usex/jev-browser-agent");
    expect(commands).toContain("--log-level debug --log-detail high");
    expect(commands).toContain("--color auto");
    await page.getByRole("tab", { name: "04 CLI" }).press("Home");
    expect(await page.locator("#panel-install").isVisible()).toBe(true);
    expect(await page.locator("#panel-cli").isVisible()).toBe(false);
    expect(
      await page.locator(".code-window [data-copy-label]").textContent(),
    ).toBe("Copy");

    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.waitForFunction(
        (theme) => document.documentElement.dataset.theme === theme,
        colorScheme,
      );
      for (const width of [320, 390, 768, 1280, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      }
    }

    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async () => {
            throw new Error("Clipboard denied");
          },
        },
      });
    });
    await page.locator("[data-copy-target]").click();
    expect(
      await page.locator(".answer-preview [data-copy-status]").textContent(),
    ).toContain("Clipboard unavailable");
    expect(
      await page.evaluate(() => window.getSelection()?.toString()),
    ).toContain("[2, 4, 6]");
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await server.stop(true);
  }
}, 20000);

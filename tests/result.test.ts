import { afterEach, expect, test } from "bun:test";
import { chromium } from "playwright";
import { renderAnswer } from "../src/result";
import { startServer } from "../src/server";
import { page as observedPage } from "./helpers";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("answer formatting preserves code, paragraphs, lists, tables and literal HTML safely", () => {
  const html = renderAnswer(
    "## Comparison\n\n`map()` returns **a new array**.\n\n- One\n- Two\n\n" +
      "| Method | Output |\n| --- | --- |\n| map | New array |\n\n" +
      '```js\nx < y && value === "<script>"\n```\n\n' +
      "<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29)\n\n" +
      "[encoded](javascript&#58;alert%281%29)\n\n[site](https://example.test/?a=1&b=2)\n\n" +
      "![tracking](https://example.test/tracker.png)\n\nمتن فارسی",
  );
  expect(html).toContain("<code>map()</code>");
  expect(html).toContain("<strong>a new array</strong>");
  expect(html).toContain("<ul><li>One</li><li>Two</li></ul>");
  expect(html).toContain("<table>");
  expect(html).toContain(
    "x &lt; y &amp;&amp; value === &quot;&lt;script&gt;&quot;",
  );
  expect(html).not.toContain("&amp;lt;");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<script");
  expect(html).not.toContain('href="javascript');
  expect(html).toContain('href="https://example.test/?a=1&amp;b=2"');
  expect(html).toContain('rel="noopener noreferrer"');
  expect(html).toContain('<p dir="auto">متن فارسی</p>');
});

test("result UI renders sources without duplication and copies original answer, code, URLs and quotes", async () => {
  const inspector = startServer({ port: 0 });
  cleanup.push(() => inspector.close());
  const browser = await chromium.launch();
  cleanup.push(() => browser.close());
  const context = await browser.newContext({
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const source = `https://example.test/reference/${"long-path-".repeat(25)}map`;
  const answer =
    `## Comparison\n\nThe \`map()\` method returns **a new array**.\n\n- First item\n- Second item\n\n` +
    `| Method | Mutates input |\n| --- | --- |\n| map | No |\n\n` +
    `\`\`\`js\nconst result = values.filter(x => x < 10);\n\`\`\`\n\n` +
    `Reference: ${source}\n\nمتن فارسی با \`map()\` درست نمایش داده می‌شود.\n\n` +
    `<img src=x onerror="window.compromised=true"> [unsafe](javascript:alert%281%29)`;
  const quote = "Returns a new array.";
  const state = {
    ...(await (await fetch(`${inspector.url}/api/state`)).json()),
    status: "done",
    page: observedPage(),
    answer,
    answer_html: renderAnswer(answer),
    completion_reviews: [
      {
        complete: true,
        evidence: [
          { url: source, quote },
          { url: source, quote },
          { url: source, quote: "Existing input remains unchanged." },
          {
            url: "https://example.test/filter",
            quote: "Selects matching elements.",
          },
          { url: "javascript:alert(1)", quote: "Unsafe source." },
        ],
      },
    ],
    read_sources: [{ url: source, title: "Array.prototype.map()" }],
    checkpoints: [],
    elapsed_ms: 80000,
  };
  await page.route("**/api/state", (route) => route.fulfill({ json: state }));
  await page.route("**/api/events", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: `event: state\ndata: ${JSON.stringify(state)}\n\n`,
    }),
  );
  await page.goto(inspector.url);
  await page.locator("#task-result").waitFor({ state: "visible" });
  expect(await page.locator("#answer h4").textContent()).toBe("Comparison");
  expect(await page.locator("#answer strong").textContent()).toBe(
    "a new array",
  );
  expect(
    await page.locator("#answer table tbody td").allTextContents(),
  ).toEqual(["map", "No"]);
  expect(await page.locator("#answer-sources > li").count()).toBe(2);
  expect(await page.locator(".source-evidence figure").count()).toBe(3);
  expect(
    await page
      .locator(
        "#answer img, #answer script, #task-result a[href^='javascript:']",
      )
      .count(),
  ).toBe(0);
  expect(await page.locator("#answer p").last().textContent()).toContain(
    "<img src=x",
  );
  expect(
    await page
      .locator("#answer p")
      .filter({ hasText: "متن فارسی" })
      .evaluate((el) => getComputedStyle(el).direction),
  ).toBe("rtl");

  await page.locator("#copy-answer").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    answer,
  );
  await page.locator("[data-copy-code]").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "const result = values.filter(x => x < 10);\n",
  );
  await page.locator("[data-copy-source]").first().click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    source,
  );
  await page.locator(".source-evidence summary").first().click();
  await page.locator("[data-copy-quote]").first().click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(quote);
  expect(await page.locator("#result-copy-status").textContent()).toBe(
    "Quote copied to clipboard.",
  );

  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("Denied")) },
    });
    document.execCommand = () => false;
  });
  await page.locator("#copy-answer").click();
  expect(await page.locator("#result-copy-status").textContent()).toContain(
    "Could not access",
  );
  expect(await page.locator("#copy-answer").isEnabled()).toBe(true);

  for (const width of [1238, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  expect(errors).toEqual([]);
}, 15_000);

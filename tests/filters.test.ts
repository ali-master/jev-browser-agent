import { afterEach, expect, spyOn, test } from "bun:test";
import { Browser } from "../src/browser";
import { Agent } from "../src/agent";
import { blockedUrlMatcher, loadAdBlocker, pageFilters } from "../src/filters";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function site(fetch: (request: Request) => Response) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  cleanup.push(() => server.stop(true));
  return String(server.url);
}

test("URL patterns match complete URLs without treating dots or brackets as regex", () => {
  const normalized = pageFilters({
    blockedUrls: ["*://ADS.example.com/*", "https://example.com/a?x=1"],
  });
  const blocked = blockedUrlMatcher(normalized.blockedUrls);
  expect(blocked("https://ads.example.com/banner/a.png")).toBe(true);
  expect(blocked("http://ads.example.com/banner")).toBe(true);
  expect(blocked("https://ads.example.com.evil.test/banner")).toBe(false);
  expect(
    blocked("https://safe.test/?next=https://ads.example.com/banner"),
  ).toBe(false);
  expect(blocked("https://example.com/a?x=1#section")).toBe(true);
  expect(blocked("https://example.com/a?x=2")).toBe(false);
});

test("custom rules block direct requests, redirects and link choices without blocking allowed pages", async () => {
  const received: string[] = [];
  const url = site((request) => {
    const path = new URL(request.url).pathname;
    received.push(path);
    if (path === "/redirect")
      return Response.redirect(new URL("/blocked/secret", request.url), 302);
    return new Response(
      '<h1>Useful page</h1><a href="/blocked/link">Blocked link</a><a href="/allowed">Allowed link</a>',
      { headers: { "Content-Type": "text/html" } },
    );
  });
  const filters = { blockedUrls: [`${url}blocked/*`] };
  await expect(
    Browser.create(`${url}blocked/start`, { filters }),
  ).rejects.toThrow("starting URL is blocked");
  expect(received).toEqual([]);
  const browser = await Browser.create(url, { filters });
  cleanup.push(() => browser.close());
  const state = await browser.observe();
  expect(state.actions.some((a) => a.label === "Blocked link")).toBe(false);
  expect(state.actions.some((a) => a.label === "Allowed link")).toBe(true);
  for (const path of ["/blocked/direct", "/redirect"])
    expect(
      await browser.evaluate(
        `fetch(${JSON.stringify(path)}).then(() => false, () => true)`,
      ),
    ).toBe(true);
  let navigationError: unknown;
  try {
    const unexpected = await Browser.create(`${url}redirect`, { filters });
    cleanup.push(() => unexpected.close());
  } catch (error) {
    navigationError = error;
  }
  expect(navigationError).toBeInstanceOf(Error);
  expect((navigationError as Error).message).toContain("ERR_BLOCKED_BY_CLIENT");
  expect(received.some((path) => path.startsWith("/blocked/"))).toBe(false);
  await browser.act(
    state.actions.find((a) => a.label === "Allowed link")!,
    state,
  );
  expect((await browser.observe()).url).toBe(`${url}allowed`);
});

test("cleanup removes dynamic and destination elements before analysis while retaining useful read evidence", async () => {
  const url = site(
    () =>
      new Response(
        '<h1>Useful heading</h1><p>Keep this evidence</p><aside><button>Advertisement</button></aside><video></video><a href="/next">Next page</a>',
        { headers: { "Content-Type": "text/html" } },
      ),
  );
  const browser = await Browser.create(url, {
    filters: { removeSelectors: ["aside", "video"] },
  });
  cleanup.push(() => browser.close());
  let state = await browser.observe();
  expect(state.text).toContain("Keep this evidence");
  expect(state.text).not.toContain("Advertisement");
  expect(
    await browser.evaluate("document.querySelectorAll('aside,video').length"),
  ).toBe(0);
  await browser.evaluate(
    "document.body.insertAdjacentHTML('beforeend','<aside>Late advertisement</aside>');true",
  );
  state = await browser.observe();
  expect(state.read_text).toContain("Keep this evidence");
  expect(state.read_text).not.toContain("Late advertisement");
  await browser.act(
    state.actions.find((a) => a.label === "Next page")!,
    state,
  );
  state = await browser.observe();
  expect(state.url).toBe(`${url}next`);
  expect(state.text).not.toContain("Advertisement");
  expect(
    await browser.evaluate("document.querySelectorAll('aside,video').length"),
  ).toBe(0);
});

test("invalid CSS fails before navigation, and filtering stays optional", async () => {
  let requests = 0;
  const url = site(() => {
    requests++;
    return new Response(
      "<aside>Keep by default</aside><button>Continue</button>",
      { headers: { "Content-Type": "text/html" } },
    );
  });
  let selectorError: unknown;
  try {
    const unexpected = await Browser.create(url, {
      filters: { removeSelectors: ["aside["] },
    });
    cleanup.push(() => unexpected.close());
  } catch (error) {
    selectorError = error;
  }
  expect(selectorError).toBeInstanceOf(Error);
  expect((selectorError as Error).message).toContain("Invalid CSS selector");
  expect(requests).toBe(0);
  const browser = await Browser.create(url);
  cleanup.push(() => browser.close());
  expect((await browser.observe()).text).toContain("Keep by default");
});

test("agents read filters for each new run and allow an explicit per-run override", async () => {
  const url = site(
    () =>
      new Response("<aside>Optional content</aside><button>Continue</button>", {
        headers: { "Content-Type": "text/html" },
      }),
  );
  let filters = { removeSelectors: ["aside"] };
  const endpoint = {
    baseUrl: "http://127.0.0.1:1/v1",
    apiKey: "",
    model: "unused",
  };
  const read = async () => ({ decision: endpoint, text: endpoint, filters });
  const first = await Agent.create(url, "Read the page", { settings: read });
  cleanup.push(() => first.close());
  expect(first.state.page.text).not.toContain("Optional content");
  filters = { removeSelectors: [] };
  await (first.browser as Browser).evaluate(
    "document.body.insertAdjacentHTML('beforeend','<aside>Still removed</aside>');true",
  );
  expect((await first.browser.observe()).text).not.toContain("Still removed");
  const second = await Agent.create(url, "Read the page", { settings: read });
  cleanup.push(() => second.close());
  expect(second.state.page.text).toContain("Optional content");
  filters = { removeSelectors: ["aside"] };
  const override = await Agent.create(url, "Read the page", {
    settings: read,
    filters: {},
  });
  cleanup.push(() => override.close());
  expect(override.state.page.text).toContain("Optional content");
});

test("ad blocking retries a failed list load, caches rules and blocks ads while allowing site scripts", async () => {
  const originalFetch = globalThis.fetch;
  let downloads = 0;
  const download = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (...args: Parameters<typeof fetch>) => {
        if (String(args[0]) !== "https://easylist.to/easylist/easylist.txt")
          return originalFetch(...args);
        downloads++;
        return Promise.resolve(
          new Response(
            downloads === 1
              ? "Unavailable"
              : "[Adblock Plus 2.0]\n/ads-banner.js$script\n",
            { status: downloads === 1 ? 503 : 200 },
          ),
        );
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  cleanup.push(() => download.mockRestore());
  await expect(loadAdBlocker()).rejects.toThrow(
    "Could not load the ad blocker rules",
  );
  const received: string[] = [];
  const url = site((request) => {
    const path = new URL(request.url).pathname;
    received.push(path);
    if (path === "/redirect-script")
      return Response.redirect(new URL("/ads-banner.js", request.url), 302);
    if (path === "/frame")
      return new Response('<script src="/redirect-script"></script>', {
        headers: { "Content-Type": "text/html" },
      });
    if (path.endsWith(".js"))
      return new Response("window.appReady=true", {
        headers: { "Content-Type": "text/javascript" },
      });
    return new Response(
      `<button>Continue</button><script src="/ads-banner.js"></script><script src="/app.js"></script><iframe src="${request.url.replace("127.0.0.1", "localhost")}frame"></iframe>`,
      { headers: { "Content-Type": "text/html" } },
    );
  });
  const browser = await Browser.create(url, { filters: { blockAds: true } });
  cleanup.push(() => browser.close());
  await browser.evaluate(
    "document.readyState === 'complete' ? true : new Promise(resolve => window.addEventListener('load', () => resolve(true), { once: true }))",
  );
  expect((await browser.observe()).readiness).toBe("ready");
  expect(received).toContain("/app.js");
  expect(received).toContain("/frame");
  expect(received).toContain("/redirect-script");
  expect(received).not.toContain("/ads-banner.js");
  expect(await browser.evaluate("window.appReady")).toBe(true);
  await loadAdBlocker();
  expect(downloads).toBe(2);
  const unfiltered = await Browser.create(url);
  cleanup.push(() => unfiltered.close());
  expect(received).toContain("/ads-banner.js");
});

import { afterEach, expect, test } from "bun:test";
import { Browser } from "../src/browser";
import { initialSiteData, siteDataOptions } from "../src/site-data";
import { SettingsStore } from "../src/config";
import { ProfileStore } from "../src/credentials";
import { startServer } from "../src/server";
import { chromium } from "playwright";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("site data rejects invalid scopes, ambiguous cookies and oversized or non-string values", () => {
  for (const input of [
    null,
    [],
    { other: true },
    { cookies: {} },
    { localStorage: { "https://example.com/path": { key: "value" } } },
    { sessionStorage: { "https://user:pass@example.com": { key: "value" } } },
    { localStorage: { "https://example.com": { key: 123 } } },
    { localStorage: { "https://example.com": { key: "x".repeat(8193) } } },
    {
      cookies: [
        { origin: "https://example.com", name: "bad;name", value: "value" },
      ],
    },
    {
      cookies: [
        { origin: "https://example.com", name: "token", value: "value\r\n" },
      ],
    },
    {
      cookies: [
        {
          origin: "https://example.com",
          name: "token",
          value: "x",
          sameSite: "None",
          secure: false,
        },
      ],
    },
    {
      cookies: [
        {
          origin: "http://example.com",
          name: "token",
          value: "x",
          secure: true,
        },
      ],
    },
    {
      cookies: [
        {
          origin: "https://example.com",
          name: "__Host-token",
          value: "x",
          path: "/other",
        },
      ],
    },
    {
      cookies: [
        { origin: "https://example.com", name: "__Http-token", value: "x" },
      ],
    },
    {
      cookies: [
        {
          origin: "https://example.com",
          name: "token",
          value: "x",
          expires: NaN,
        },
      ],
    },
    {
      cookies: [443, 444].map((port) => ({
        origin: `https://example.com:${port}`,
        name: "token",
        value: "x",
      })),
    },
    {
      localStorage: {
        "https://example.com": Object.fromEntries(
          Array.from({ length: 101 }, (_, i) => [String(i), "x"]),
        ),
      },
    },
    {
      localStorage: Object.fromEntries(
        Array.from({ length: 21 }, (_, i) => [
          `https://site${i}.test`,
          { key: "x" },
        ]),
      ),
    },
    {
      localStorage: {
        "https://example.com": Object.fromEntries(
          Array.from({ length: 10 }, (_, i) => [String(i), "x".repeat(8000)]),
        ),
      },
    },
  ])
    expect(() => siteDataOptions(input)).toThrow();
  const data = siteDataOptions(
    JSON.parse(
      '{"localStorage":{"https://example.com":{"__proto__":"literal","empty":"","remove":null}}}',
    ),
  );
  expect(Object.keys(data!.localStorage!["https://example.com"]!)).toContain(
    "__proto__",
  );
  expect(siteDataOptions(undefined)).toBeUndefined();
});

test("explicit site data overlays a profile without losing unrelated keys, cookie paths or IndexedDB", () => {
  const cookie = {
    name: "session",
    value: "old",
    domain: "example.com",
    path: "/",
    expires: -1,
    secure: true,
    httpOnly: true,
    sameSite: "Lax" as const,
  };
  const saved = {
    cookies: [cookie, { ...cookie, path: "/account" }],
    origins: [
      {
        origin: "https://example.com",
        localStorage: [
          { name: "keep", value: "yes" },
          { name: "delete", value: "old" },
        ],
        indexedDB: [],
      },
    ],
  };
  const original = structuredClone(saved);
  const updated = initialSiteData(
    saved,
    siteDataOptions({
      cookies: [
        { origin: "https://example.com", name: "session", value: null },
      ],
      localStorage: {
        "https://example.com": { delete: null, empty: "", keep: "new" },
      },
    }),
  )!;
  expect(updated.cookies.map((c) => c.path)).toEqual(["/account"]);
  expect(updated.origins[0]?.origin).toBe("https://example.com");
  expect(updated.origins[0]?.localStorage).toEqual([
    { name: "keep", value: "new" },
    { name: "empty", value: "" },
  ]);
  expect(updated.origins[0]).toHaveProperty("indexedDB", []);
  expect(saved).toEqual(original);
});

test("cookies reach the first request and both stores exist before page scripts, without contacting primed origins", async () => {
  const requests: { url: string; cookie: string }[] = [];
  const site = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push({
        url: request.url,
        cookie: request.headers.get("cookie") ?? "",
      });
      return new Response(
        `<script>window.initial={local:{...localStorage},session:{...sessionStorage},cookies:document.cookie};</script><h1>Ready</h1>`,
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  cleanup.push(() => site.stop(true));
  const origin = `http://127.0.0.1:${site.port}`;
  const other = `http://localhost:${site.port}`;
  const browser = await Browser.create(origin + "/start", {
    siteData: {
      cookies: [
        { origin, name: "session", value: "test-token", httpOnly: true },
        { origin, name: "locale", value: "en" },
      ],
      localStorage: { [origin]: { theme: "dark", empty: "" } },
      sessionStorage: {
        [origin]: { step: "1" },
        [other]: { other: "separate" },
      },
    },
  });
  cleanup.push(() => browser.close());
  expect(requests.every((r) => new URL(r.url).hostname === "127.0.0.1")).toBe(
    true,
  );
  expect(requests[0]?.url).toBe(origin + "/start");
  expect(requests[0]?.cookie).toContain("session=test-token");
  expect(await browser.evaluate("window.initial")).toEqual({
    local: { theme: "dark", empty: "" },
    session: { step: "1" },
    cookies: "locale=en",
  });
  await browser.evaluate(
    "localStorage.setItem('theme','light');sessionStorage.setItem('step','2');true",
  );
  // Reload through a real link so the next observation also checks navigation freshness.
  await browser.evaluate(
    "document.body.innerHTML='<a href=\"/next\">Continue</a>';true",
  );
  const page = await browser.observe();
  await browser.act(
    page.actions.find((a) => a.label === "Continue")!,
    page,
  );
  await browser.observe();
  expect(await browser.evaluate("window.initial.session")).toEqual({
    step: "2",
  });
  expect(await browser.evaluate("window.initial.local.theme")).toBe("light");
  await browser.evaluate(
    `sessionStorage.clear();document.body.innerHTML='<a href="${other}/other">Other site</a>';true`,
  );
  const next = await browser.observe();
  await browser.act(
    next.actions.find((a) => a.label === "Other site")!,
    next,
  );
  await browser.observe();
  expect(await browser.evaluate("window.initial")).toEqual({
    local: {},
    session: { other: "separate" },
    cookies: "",
  });
  await browser.evaluate(
    `document.body.innerHTML='<a href="${origin}/back">Back</a>';true`,
  );
  const last = await browser.observe();
  await browser.act(
    last.actions.find((a) => a.label === "Back")!,
    last,
  );
  await browser.observe();
  expect(await browser.evaluate("window.initial.session")).toEqual({});
  const isolated = await Browser.create(origin);
  cleanup.push(() => isolated.close());
  expect(await isolated.evaluate("window.initial")).toEqual({
    local: {},
    session: {},
    cookies: "",
  });
}, 25_000);

test("real profile overrides persist cookies and localStorage while sessionStorage stays transient", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-site-data-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.JEV_PROFILE_KEY;
  process.env.JEV_PROFILE_KEY = Buffer.alloc(32, 9).toString("base64");
  cleanup.push(() => {
    if (previous === undefined) delete process.env.JEV_PROFILE_KEY;
    else process.env.JEV_PROFILE_KEY = previous;
  });
  const site = Bun.serve({
    port: 0,
    fetch: () =>
      new Response("<h1>Account</h1>", {
        headers: { "Content-Type": "text/html" },
      }),
  });
  cleanup.push(() => site.stop(true));
  const origin = `http://localhost:${site.port}`;
  const profile = { name: "test", directory };
  const first = await Browser.create(origin, {
    profile,
    siteData: {
      cookies: [
        { origin, name: "remove", value: "old" },
        { origin, name: "keep", value: "yes" },
      ],
      localStorage: { [origin]: { remove: "old", keep: "yes" } },
    },
  });
  cleanup.push(() => first.close(false));
  await first.close();
  const second = await Browser.create(origin, {
    profile,
    siteData: {
      cookies: [
        { origin, name: "remove", value: null },
        { origin, name: "keep", value: "updated" },
      ],
      localStorage: { [origin]: { remove: null, empty: "" } },
      sessionStorage: { [origin]: { transient: "yes" } },
    },
  });
  cleanup.push(() => second.close(false));
  expect(
    await second.evaluate(
      "({cookies:document.cookie,local:{...localStorage},session:{...sessionStorage}})",
    ),
  ).toEqual({
    cookies: "keep=updated",
    local: { keep: "yes", empty: "" },
    session: { transient: "yes" },
  });
  await second.close();
  const saved = await new ProfileStore(profile, origin).load();
  expect(saved?.cookies.map((c) => c.name)).toEqual(["keep"]);
  const restored = await Browser.create(origin, { profile });
  cleanup.push(() => restored.close(false));
  expect(
    await restored.evaluate(
      "({cookies:document.cookie,local:{...localStorage},session:{...sessionStorage}})",
    ),
  ).toEqual({
    cookies: "keep=updated",
    local: { keep: "yes", empty: "" },
    session: {},
  });
}, 20_000);

test("inspector applies site data without returning configuration values and rejects invalid input before replacing a run", async () => {
  let cookie = "";
  const site = Bun.serve({
    port: 0,
    fetch(request) {
      cookie = request.headers.get("cookie") ?? "";
      return new Response(
        `<script>document.title=localStorage.theme==='dark'&&sessionStorage.step==='1'?'Initialized':'Missing';</script><h1>Account</h1>`,
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  cleanup.push(() => site.stop(true));
  const origin = `http://localhost:${site.port}`;
  const inspector = startServer({
    port: 0,
    settings: new SettingsStore(
      `/tmp/jev-site-data-api-${crypto.randomUUID()}`,
      { TYPESAFE_MODEL: "test", TEXT_MODEL: "test" },
    ),
  });
  cleanup.push(() => inspector.close());
  const html = await fetch(inspector.url).then((r) => r.text());
  const token = html.match(/name="demo-token" content="([^"]+)"/)![1]!;
  const reset = (siteData: unknown) =>
    fetch(`${inspector.url}/api/reset`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-demo-token": token },
      body: JSON.stringify({
        scenario: "custom",
        url: origin,
        goal: "Read the account",
        siteData,
      }),
    });
  const result = await reset({
    cookies: [
      { origin, name: "login", value: "fake-session-token", httpOnly: true },
    ],
    localStorage: { [origin]: { theme: "dark" } },
    sessionStorage: { [origin]: { step: "1" } },
  });
  expect(result.status).toBe(200);
  const text = await result.text();
  const state = JSON.parse(text);
  expect(state.page.title).toBe("Initialized");
  expect(cookie).toContain("login=fake-session-token");
  expect(text).not.toContain("fake-session-token");
  expect(state).not.toHaveProperty("siteData");
  const invalid = await reset({
    localStorage: { [origin + "/path"]: { key: "do-not-echo-this" } },
  });
  expect(invalid.status).toBe(400);
  expect(await invalid.text()).not.toContain("do-not-echo-this");
  const current = await fetch(`${inspector.url}/api/state`).then((r) =>
    r.json(),
  );
  expect(current.run_id).toBe(state.run_id);
  expect(current.page.title).toBe("Initialized");
  expect(
    await fetch(`${inspector.url}/api/settings`).then((r) => r.text()),
  ).not.toContain("fake-session-token");
}, 20_000);

test("cookie security flags, path and host restrictions survive Chromium initialization", async () => {
  const browser = await chromium.launch();
  cleanup.push(() => browser.close());
  const expires = Math.floor(Date.now() / 1000) + 86_400;
  const context = await browser.newContext({
    storageState: initialSiteData(
      undefined,
      siteDataOptions({
        cookies: [
          {
            origin: "https://example.test",
            name: "__Host-Http-login",
            value: "fake",
            httpOnly: true,
            sameSite: "Strict",
            expires,
          },
          {
            origin: "https://example.test",
            name: "restricted",
            value: "ok",
            path: "/account",
          },
        ],
      }),
    ),
  });
  const cookies = await context.cookies("https://example.test/account");
  expect(cookies).toHaveLength(2);
  expect(cookies.find((c) => c.name === "__Host-Http-login")).toMatchObject({
    domain: "example.test",
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    path: "/",
    expires,
  });
  // Check actual request headers: Playwright's cookies(URL) filter also lists host-only cookies for subdomains.
  const page = await context.newPage();
  const sent = new Map<string, string>();
  await page.route("**/*", async (route) => {
    sent.set(
      route.request().url(),
      (await route.request().allHeaders()).cookie ?? "",
    );
    await route.fulfill({ contentType: "text/html", body: "<h1>Account</h1>" });
  });
  for (const url of [
    "https://example.test/account",
    "https://example.test/other",
    "https://sub.example.test/account",
  ])
    await page.goto(url);
  expect(sent.get("https://example.test/account")).toContain("restricted=ok");
  expect(sent.get("https://example.test/account")).toContain(
    "__Host-Http-login=fake",
  );
  expect(sent.get("https://example.test/other")).toBe("__Host-Http-login=fake");
  expect(sent.get("https://sub.example.test/account")).toBe("");
});

test("CLI accepts the site-data option and keeps JSON parsing failures private", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-site-cli-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "site.json");
  await Bun.write(path, '{"private":"do-not-echo-this",bad}');
  const child = Bun.spawn(
    [
      Bun.which("bun")!,
      new URL("../src/cli.ts", import.meta.url).pathname,
      "run",
      "--url",
      "https://example.test",
      "--goal",
      "Read the page",
      "--site-data",
      path,
      "--color",
      "never",
    ],
    { cwd: directory, stdout: "pipe", stderr: "pipe" },
  );
  const error = await new Response(child.stderr).text();
  expect(await child.exited).toBe(1);
  expect(error).toContain("Invalid site data JSON file.");
  expect(error).not.toContain("do-not-echo-this");
});

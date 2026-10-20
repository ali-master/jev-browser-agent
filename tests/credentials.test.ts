import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser, StalePage } from "../src/browser";
import { ProfileStore, SecretVault } from "../src/credentials";
import { Agent } from "../src/agent";
import {
  chatResponse,
  completionResponse,
  decisionResponse,
  provider,
} from "./helpers";
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const html = (text: string) =>
  new Response(text, { headers: { "Content-Type": "text/html" } });
const secretValue = "test-password-3491";

test("secrets are entered only in bound fields and never appear in model traffic, traces or images", async () => {
  const site = Bun.serve({
    port: 0,
    fetch: () =>
      html(
        `<label>Password<input type="password" aria-label="Password" oninput="document.querySelector('output').textContent=this.value"></label><output></output>`,
      ),
  });
  cleanup.push(() => site.stop(true));
  const origin = `http://localhost:${site.port}`;
  const secrets = {
    password: { value: secretValue, origin, label: "Password" },
  };
  let calls = 0;
  const model = provider(async (request) => {
    const body = await request.json();
    calls++;
    expect(JSON.stringify(body)).not.toContain(secretValue);
    if (request.url.endsWith("systemone"))
      return Response.json(decisionResponse(body));
    if (body.response_format.json_schema.name === "completion_review")
      return completionResponse(body);
    return chatResponse({
      steps: [
        {
          instruction: "Enter the password",
          checks: [
            { kind: "value", label: "Password", equals: "{{secret:password}}" },
          ],
        },
      ],
    });
  });
  cleanup.push(() => model.server.stop(true));
  const agent = await Agent.create(
    origin,
    "Enter {{secret:password}} in Password",
    { secrets, screenshots: true, settings: async () => model.settings },
  );
  cleanup.push(() => agent.close());
  for await (const _ of agent.run()) {
  }
  expect(agent.state.status).toBe("done");
  expect(calls).toBeGreaterThan(1);
  expect(
    await (agent.browser as Browser).evaluate(
      "document.querySelector('input').value",
    ),
  ).toBe(secretValue);
  expect(JSON.stringify(agent.snapshot())).not.toContain(secretValue);
  expect(agent.state.history[0]?.text).toBe("{{secret:password}}");
  expect(agent.state.page.screenshot).toBeUndefined();
  await expect(
    (agent.browser as Browser).watchFrames(() => {}),
  ).rejects.toThrow("disabled");
}, 15000);

test("secret freshness detects a changed password, even one with the same length", async () => {
  const site = Bun.serve({
    port: 0,
    fetch: () => html('<input type="password" aria-label="Password">'),
  });
  cleanup.push(() => site.stop(true));
  const origin = `http://localhost:${site.port}`;
  const browser = await Browser.create(origin, {
    secrets: { password: { value: secretValue, origin, label: "Password" } },
  });
  cleanup.push(() => browser.close());
  let page = await browser.observe();
  await browser.act(
    page.actions.find((a) => a.kind === "fill")!,
    page,
    "{{secret:password}}",
  );
  page = await browser.observe();
  await browser.evaluate(
    "document.querySelector('input').value='another-password-x';true",
  );
  await expect(
    browser.act(
      page.actions.find((a) => a.kind === "fill")!,
      page,
      "{{secret:password}}",
    ),
  ).rejects.toBeInstanceOf(StalePage);
  expect(JSON.stringify(await browser.observe())).not.toContain(
    "another-password-x",
  );
}, 15000);

test("secret bindings reject different origins, labels and non-placeholder values", () => {
  const vault = new SecretVault({
    p: {
      value: secretValue,
      origin: "https://allowed.test",
      label: "Password",
    },
  });
  const action = {
    id: "a",
    kind: "fill" as const,
    node: 1,
    role: "textbox",
    label: "Password",
    secret_key: "p",
  };
  expect(vault.resolve(action, "https://allowed.test", "{{secret:p}}")).toBe(
    secretValue,
  );
  expect(() =>
    vault.resolve(action, "https://other.test", "{{secret:p}}"),
  ).toThrow();
  expect(() =>
    vault.resolve(
      { ...action, label: "Search" },
      "https://allowed.test",
      "{{secret:p}}",
    ),
  ).toThrow();
  expect(() =>
    vault.resolve(action, "https://allowed.test", "anything"),
  ).toThrow();
  const named = new SecretVault({
    password: {
      value: "password",
      origin: "https://allowed.test",
      label: "Password",
    },
  });
  expect(named.redact(named.redact("password {{secret:password}}"))).toBe(
    "{{secret:password}} {{secret:password}}",
  );
});

test("encrypted profiles restore a login without storing plaintext and reject wrong keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "jev-profile-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.JEV_PROFILE_KEY;
  process.env.JEV_PROFILE_KEY = Buffer.from(
    crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64");
  cleanup.push(() => {
    if (previous === undefined) delete process.env.JEV_PROFILE_KEY;
    else process.env.JEV_PROFILE_KEY = previous;
  });
  const site = Bun.serve({ port: 0, fetch: () => html("<h1>Account</h1>") });
  cleanup.push(() => site.stop(true));
  const origin = `http://localhost:${site.port}`;
  const profile = { name: "account", directory };
  const browser = await Browser.create(origin, { profile });
  await browser.evaluate(
    `document.cookie='login=${secretValue};path=/';localStorage.setItem('session','${secretValue}');true`,
  );
  await browser.close();
  const path = join(directory, "account.enc");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect(await Bun.file(path).text()).not.toContain(secretValue);
  const restored = await Browser.create(origin, { profile });
  expect(await restored.evaluate("document.cookie")).toContain(secretValue);
  expect(await restored.evaluate("localStorage.getItem('session')")).toBe(
    secretValue,
  );
  await restored.close(false);
  const original = await Bun.file(path).arrayBuffer();
  process.env.JEV_PROFILE_KEY = Buffer.alloc(32, 7).toString("base64");
  await expect(Browser.create(origin, { profile })).rejects.toThrow(
    "decrypted",
  );
  expect(await Bun.file(path).arrayBuffer()).toEqual(original);
}, 15000);

test("profiles reject path traversal and only persist permitted site storage", async () => {
  expect(
    () => new ProfileStore({ name: "../bad" }, "https://example.test"),
  ).toThrow();
  expect(
    () =>
      new ProfileStore(
        { name: "safe", origins: ["https://other.test"] },
        "https://example.test",
      ),
  ).toThrow();
  const directory = await mkdtemp(join(tmpdir(), "jev-scope-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const previous = process.env.JEV_PROFILE_KEY;
  process.env.JEV_PROFILE_KEY = Buffer.alloc(32, 4).toString("base64");
  cleanup.push(() => {
    if (previous === undefined) delete process.env.JEV_PROFILE_KEY;
    else process.env.JEV_PROFILE_KEY = previous;
  });
  const store = new ProfileStore(
    { name: "scope", directory },
    "https://example.test",
  );
  const cookie = {
    name: "session",
    value: secretValue,
    path: "/",
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  };
  await store.save({
    storageState: async () => ({
      cookies: [
        { ...cookie, domain: ".example.test" },
        { ...cookie, domain: "other.test" },
      ],
      origins: [
        { origin: "https://example.test", localStorage: [] },
        { origin: "https://other.test", localStorage: [] },
      ],
    }),
  } as any);
  const state = await store.load();
  expect(state?.cookies.map((c) => c.domain)).toEqual(["example.test"]);
  expect(state?.origins.map((o) => o.origin)).toEqual(["https://example.test"]);
  await expect(
    new ProfileStore({ name: "scope", directory }, "https://other.test").load(),
  ).rejects.toThrow();
});

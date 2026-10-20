import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "../src/config";

const directories: string[] = [];
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "jev-config-"));
  directories.push(directory);
  return { directory, store: new SettingsStore(directory, {}) };
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

test("reads edited .env values afresh on every call", async () => {
  const { directory, store } = await setup();
  await Bun.write(
    join(directory, ".env"),
    'TYPESAFE_BASE_URL="http://localhost:1234/v1"\nTYPESAFE_API_KEY=first\nTYPESAFE_MODEL=local\n',
  );
  expect((await store.read()).decision.model).toBe("local");
  await Bun.write(
    join(directory, ".env"),
    "TYPESAFE_BASE_URL=https://api.typesafe.ai/v1\nTYPESAFE_API_KEY=second\nTYPESAFE_MODEL=jev-latest\n",
  );
  expect((await store.read()).decision).toEqual({
    baseUrl: "https://api.typesafe.ai/v1",
    apiKey: "second",
    model: "jev-latest",
  });
});

test("settings persist, redact keys, retain omitted keys, clear explicit empty keys and protect file permissions", async () => {
  const { directory, store } = await setup();
  const saved = await store.save({
    decision: { model: "jev", apiKey: "secret-one" },
  });
  expect(JSON.stringify(saved)).not.toContain("secret-one");
  expect(saved.decision.hasApiKey).toBe(true);
  expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  expect((await stat(join(directory, ".jev"))).mode & 0o777).toBe(0o700);
  const restarted = new SettingsStore(directory, {});
  await restarted.save({ decision: { model: "jev-new" } });
  expect((await restarted.read()).decision.apiKey).toBe("secret-one");
  await restarted.save({ decision: { apiKey: "" } });
  expect((await restarted.read()).decision.apiKey).toBe("");
  await Bun.write(
    store.path,
    (await Bun.file(store.path).text()).replace("jev-new", "externally-edited"),
  );
  expect((await store.read()).decision.model).toBe("externally-edited");
});

test("changing a Base URL does not leak the previous provider key", async () => {
  const { store } = await setup();
  await store.save({ decision: { apiKey: "cloud-secret" } });
  await store.save({ decision: { baseUrl: "https://api.typesafe.ai/v1" } });
  expect((await store.read()).decision.apiKey).toBe("");
  await store.save({
    decision: { baseUrl: "http://localhost:1234/v1", apiKey: "replacement" },
  });
  expect((await store.read()).decision.apiKey).toBe("replacement");
});

test.each([
  "file:///tmp/key",
  "https://user:pass@example.com/v1",
  "https://example.com/v1?key=secret",
  "http://localhost:1234/v1/systemone",
])("rejects invalid provider Base URL %s", async (baseUrl) => {
  const { store } = await setup();
  await expect(store.save({ decision: { baseUrl } })).rejects.toThrow();
});

test("malformed saved settings fail closed without echoing file contents", async () => {
  const { store } = await setup();
  await store.save({});
  await Bun.write(store.path, "super-secret malformed JSON");
  await expect(store.read()).rejects.toThrow(
    "Local model settings contain invalid JSON.",
  );
});

test("optional prices persist and clear on provider or model changes", async () => {
  const { store } = await setup();
  const pricing = { inputUsdPerMillion: 0, outputUsdPerMillion: 0.4 };
  await store.save({ decision: { pricing } });
  expect((await store.publicSettings()).decision.pricing).toEqual(pricing);
  await store.save({ decision: { model: "different-model" } });
  expect((await store.read()).decision.pricing).toBeUndefined();
  await store.save({ decision: { pricing } });
  await store.save({ decision: { baseUrl: "https://different.test/v1" } });
  expect((await store.read()).decision.pricing).toBeUndefined();
  await store.save({ decision: { pricing } });
  await store.save({ decision: { pricing: null } });
  expect((await store.read()).decision.pricing).toBeUndefined();
});

test.each([
  { inputUsdPerMillion: 1 },
  { inputUsdPerMillion: -1, outputUsdPerMillion: 1 },
  { inputUsdPerMillion: "0", outputUsdPerMillion: 1 },
  { inputUsdPerMillion: 1, outputUsdPerMillion: 1, other: 1 },
])("rejects invalid token prices: %j", async (pricing) => {
  const { store } = await setup();
  await expect(store.save({ text: { pricing } })).rejects.toThrow("prices");
});

test("browser filters default off, persist independently and can be cleared", async () => {
  const { store, directory } = await setup();
  const defaults = { blockAds: false, blockedUrls: [], removeSelectors: [] };
  expect((await store.read()).filters).toEqual(defaults);
  const filters = {
    blockAds: true,
    blockedUrls: ["https://ads.example.com/*"],
    removeSelectors: [" aside ", "aside", ".banner"],
  };
  await store.save({ decision: { apiKey: "secret" }, filters });
  await store.save({ text: { model: "another-helper" } });
  const restarted = new SettingsStore(directory, {});
  expect((await restarted.publicSettings()).filters).toEqual({
    ...filters,
    removeSelectors: ["aside", ".banner"],
  });
  expect((await restarted.read()).decision.apiKey).toBe("secret");
  await restarted.save({ filters: {} });
  expect((await restarted.read()).filters).toEqual(defaults);
});

test.each([
  null,
  { blockAds: "yes" },
  { blockedUrls: null },
  { blockedUrls: ["javascript:alert(1)"] },
  { blockedUrls: ["https://user:password@example.com/*"] },
  { blockedUrls: ["https://example.com/#section"] },
  { blockedUrls: ["ads.example.com"] },
  { removeSelectors: [""] },
  { removeSelectors: ["x".repeat(501)] },
  { removeSelectors: Array(101).fill("aside") },
  { removeSelectors: ["aside\nscript"] },
  { unknown: true },
])(
  "rejects invalid browser filters without changing saved settings: %j",
  async (filters) => {
    const { store } = await setup();
    await store.save({});
    const before = await Bun.file(store.path).text();
    await expect(store.save({ filters })).rejects.toThrow();
    expect(await Bun.file(store.path).text()).toBe(before);
  },
);

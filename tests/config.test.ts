import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsStore } from "../src/config.js";

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
  await writeFile(
    join(directory, ".env"),
    'TYPESAFE_BASE_URL="http://localhost:1234/v1"\nTYPESAFE_API_KEY=first\nTYPESAFE_MODEL=local\n',
  );
  expect((await store.read()).decision.model).toBe("local");
  await writeFile(
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
  const saved = await store.save({ decision: { model: "jev", apiKey: "secret-one" } });
  expect(JSON.stringify(saved)).not.toContain("secret-one");
  expect(saved.decision.hasApiKey).toBe(true);
  expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  const restarted = new SettingsStore(directory, {});
  await restarted.save({ decision: { model: "jev-new" } });
  expect((await restarted.read()).decision.apiKey).toBe("secret-one");
  await restarted.save({ decision: { apiKey: "" } });
  expect((await restarted.read()).decision.apiKey).toBe("");
  await writeFile(
    store.path,
    (await readFile(store.path, "utf8")).replace("jev-new", "externally-edited"),
  );
  expect((await store.read()).decision.model).toBe("externally-edited");
});

test("changing a Base URL does not leak the previous provider key", async () => {
  const { store } = await setup();
  await store.save({ decision: { apiKey: "cloud-secret" } });
  await store.save({ decision: { baseUrl: "https://api.typesafe.ai/v1" } });
  expect((await store.read()).decision.apiKey).toBe("");
  await store.save({ decision: { baseUrl: "http://localhost:1234/v1", apiKey: "replacement" } });
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
  await writeFile(store.path, "super-secret malformed JSON");
  await expect(store.read()).rejects.toThrow("Local model settings contain invalid JSON.");
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

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseEnv } from "node:util";
import type { Endpoint, Settings } from "./types";
import { pageFilters } from "./filters";

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function httpUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTP(S) URL.`);
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(
      `${label} must use HTTP(S), without credentials or a fragment.`,
    );
  }
  return url.href;
}

function endpoint(value: unknown): Endpoint {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) => !["baseUrl", "apiKey", "model", "pricing"].includes(key),
    ) ||
    typeof value.baseUrl !== "string" ||
    typeof value.apiKey !== "string" ||
    typeof value.model !== "string"
  ) {
    throw new Error(
      "Each model connection needs baseUrl, apiKey and model strings.",
    );
  }
  const baseUrl = httpUrl(value.baseUrl.trim(), "Model Base URL").replace(
    /\/+$/,
    "",
  );
  if (
    new URL(baseUrl).search ||
    /\/(systemone|chat\/completions)$/.test(baseUrl)
  ) {
    throw new Error(
      "Use the API base URL (usually ending in /v1), without a query or endpoint path.",
    );
  }
  if (
    value.apiKey.length > 8192 ||
    /[\r\n]/.test(value.apiKey) ||
    value.model.length > 256
  )
    throw new Error("Invalid API key or model identifier.");
  const result: Endpoint = {
    baseUrl,
    apiKey: value.apiKey.trim(),
    model: value.model.trim(),
  };
  if (value.pricing !== undefined && value.pricing !== null) {
    const pricing = value.pricing;
    if (
      !object(pricing) ||
      Object.keys(pricing).length !== 2 ||
      ![pricing.inputUsdPerMillion, pricing.outputUsdPerMillion].every(
        (rate) =>
          typeof rate === "number" &&
          Number.isFinite(rate) &&
          rate >= 0 &&
          rate <= 1e9,
      )
    )
      throw new Error(
        "Set both input and output prices in USD per million tokens, between 0 and 1,000,000,000; leave both blank for unknown.",
      );
    result.pricing = {
      inputUsdPerMillion: pricing.inputUsdPerMillion as number,
      outputUsdPerMillion: pricing.outputUsdPerMillion as number,
    };
  }
  return result;
}

async function optionalFile(path: string): Promise<string | undefined> {
  try {
    return await Bun.file(path).text();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("Cannot read local model settings.");
  }
}

export class SettingsStore {
  readonly path: string;
  constructor(
    private directory = process.cwd(),
    private environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.path = resolve(directory, ".jev/settings.json");
  }
  async read(): Promise<Settings> {
    const dotenv = await optionalFile(resolve(this.directory, ".env"));
    const env = { ...this.environment, ...parseEnv(dotenv ?? "") };
    const defaults: Settings = {
      decision: {
        baseUrl: env.TYPESAFE_BASE_URL ?? "http://127.0.0.1:1234/v1",
        apiKey: env.TYPESAFE_API_KEY ?? "",
        model: env.TYPESAFE_MODEL ?? "",
      },
      text: {
        baseUrl: env.TEXT_MODEL_BASE_URL ?? "http://127.0.0.1:1234/v1",
        apiKey: env.TEXT_MODEL_API_KEY ?? "",
        model: env.TEXT_MODEL ?? "",
      },
    };
    const saved = await optionalFile(this.path);
    let value: unknown = defaults;
    if (saved !== undefined) {
      try {
        value = JSON.parse(saved);
      } catch {
        throw new Error("Local model settings contain invalid JSON.");
      }
    }
    if (
      !object(value) ||
      Object.keys(value).some(
        (key) => !["decision", "text", "filters"].includes(key),
      )
    )
      throw new Error("Invalid model settings.");
    return {
      decision: endpoint(value.decision),
      text: endpoint(value.text),
      filters: pageFilters(value.filters),
    };
  }
  async publicSettings() {
    const settings = await this.read();
    const publicEndpoint = ({ baseUrl, model, apiKey, pricing }: Endpoint) => ({
      baseUrl,
      model,
      hasApiKey: Boolean(apiKey),
      ...(pricing ? { pricing } : {}),
    });
    return {
      decision: publicEndpoint(settings.decision),
      text: publicEndpoint(settings.text),
      filters: settings.filters,
    };
  }
  async save(input: unknown) {
    if (
      !object(input) ||
      Object.keys(input).some(
        (key) => !["decision", "text", "filters"].includes(key),
      )
    )
      throw new Error("Invalid model settings.");
    const previous = await this.read();
    const updated = { ...previous };
    if (input.filters !== undefined)
      updated.filters = pageFilters(input.filters);
    for (const key of ["decision", "text"] as const) {
      const patch = input[key];
      if (patch === undefined) continue;
      if (!object(patch)) throw new Error("Invalid model connection.");
      const merged = { ...previous[key], ...patch };
      if (
        patch.pricing === undefined &&
        ((patch.model !== undefined && patch.model !== previous[key].model) ||
          (patch.baseUrl !== undefined &&
            patch.baseUrl !== previous[key].baseUrl))
      )
        delete merged.pricing;
      // Never carry a provider's credential to a newly selected endpoint implicitly.
      if (
        patch.baseUrl !== undefined &&
        patch.baseUrl !== previous[key].baseUrl &&
        patch.apiKey === undefined
      )
        merged.apiKey = "";
      updated[key] = endpoint(merged);
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    // Bun 1.4.3 did not honor Bun.write's mode for string input on macOS.
    await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.path);
    return this.publicSettings();
  }
}

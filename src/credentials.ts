import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { BrowserContext } from "playwright";
import { httpUrl, object } from "./config";
import type { Action } from "./types";

export interface ProfileOptions {
  name: string;
  /** Exact origins whose login state may be restored. Defaults to the starting origin. */
  origins?: string[];
  directory?: string;
}
export type Secrets = Record<
  string,
  { value: string; origin: string; label: string }
>;
type Storage = Awaited<ReturnType<BrowserContext["storageState"]>>;

/** Keep opaque secret references in model context, resolving values only for a bound field. */
export class SecretVault {
  private entries: Secrets;
  constructor(value: unknown = {}) {
    if (!object(value) || Object.keys(value).length > 20)
      throw new Error("Supply at most 20 named secrets.");
    this.entries = {};
    for (const [key, entry] of Object.entries(value)) {
      if (
        !/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(key) ||
        !object(entry) ||
        typeof entry.value !== "string" ||
        !entry.value ||
        entry.value.includes("{{secret:") ||
        entry.value.length > 2000 ||
        typeof entry.label !== "string" ||
        !entry.label.trim() ||
        entry.label.length > 200 ||
        typeof entry.origin !== "string" ||
        new URL(httpUrl(entry.origin, "Secret origin")).origin !== entry.origin
      )
        throw new Error(
          "Each secret needs a value, exact HTTP(S) origin and exact field label.",
        );
      if (
        Object.values(this.entries).some(
          (e) => e.origin === entry.origin && e.label === entry.label,
        )
      )
        throw new Error("A secret field may have only one binding.");
      this.entries[key] = {
        value: entry.value,
        origin: entry.origin,
        label: entry.label,
      };
    }
  }
  get enabled() {
    return Object.keys(this.entries).length > 0;
  }
  /** Publish field metadata only; values are never sent with an observation request. */
  fields(url: string) {
    const origin = new URL(url).origin;
    return Object.entries(this.entries)
      .filter(([, e]) => e.origin === origin)
      .map(([key, e]) => ({ key, label: e.label }));
  }
  /** Resolve only an observed field on the configured origin, using the original placeholder. */
  resolve(action: Action, origin: string, text: string): string {
    if (!("secret_key" in action) || !action.secret_key) return text;
    const entry = this.entries[action.secret_key];
    if (
      !entry ||
      entry.origin !== origin ||
      entry.label !== action.label ||
      text !== `{{secret:${action.secret_key}}}`
    )
      throw new Error(
        "Secret field binding does not match its permitted origin and label.",
      );
    return entry.value;
  }
  /** Compare browser field contents locally without exposing another password to the model. */
  matches(key: string, value: string) {
    return this.entries[key]?.value === value;
  }
  /** Redact values recursively before any observation, trace or diagnostic leaves the browser. */
  redact<T>(input: T): T {
    if (!this.enabled) return input;
    const entries = Object.entries(this.entries).sort(
      (a, b) => b[1].value.length - a[1].value.length,
    );
    const replace = (value: unknown): unknown => {
      if (typeof value === "string" && entries.length)
        return value.replace(
          new RegExp(
            "\\{\\{secret:[a-zA-Z][a-zA-Z0-9_-]{0,31}\\}\\}|" +
              entries.map(([, e]) => RegExp.escape(e.value)).join("|"),
            "g",
          ),
          (match) =>
            match.startsWith("{{secret:")
              ? match
              : `{{secret:${entries.find(([, e]) => e.value === match)![0]}}}`,
        );
      if (Array.isArray(value)) return value.map(replace);
      if (object(value))
        return Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, replace(v)]),
        );
      return value;
    };
    return replace(input) as T;
  }
}

/** Persist only explicitly scoped login state using authenticated encryption and private files. */
export class ProfileStore {
  private readonly path: string;
  readonly origins: string[];
  constructor(options: ProfileOptions, startUrl: string) {
    if (
      !object(options) ||
      typeof options.name !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(options.name) ||
      (options.directory !== undefined &&
        typeof options.directory !== "string") ||
      (options.origins !== undefined &&
        (!Array.isArray(options.origins) ||
          !options.origins.length ||
          options.origins.length > 20))
    )
      throw new Error("Invalid profile name or origins.");
    this.origins = [
      ...new Set(
        (options.origins ?? [new URL(startUrl).origin]).map((origin) => {
          if (
            typeof origin !== "string" ||
            new URL(httpUrl(origin, "Profile origin")).origin !== origin
          )
            throw new Error("Profile origins must be exact HTTP(S) origins.");
          return origin;
        }),
      ),
    ];
    if (!this.origins.includes(new URL(startUrl).origin))
      throw new Error("Starting origin is not allowed by this profile.");
    this.path = resolve(
      options.directory ?? ".jev/profiles",
      `${options.name}.enc`,
    );
  }
  /** Use the OS credential store by default; CI can provide a 32-byte base64 environment key. */
  private async key(create: boolean) {
    let value = process.env.JEV_PROFILE_KEY;
    if (!value) {
      try {
        const id = { service: "jev-browser-agent", name: this.path };
        value = (await Bun.secrets.get(id)) ?? undefined;
        if (!value && create) {
          value = Buffer.from(
            crypto.getRandomValues(new Uint8Array(32)),
          ).toString("base64");
          await Bun.secrets.set({ ...id, value });
        }
      } catch {
        throw new Error(
          "Profile key storage is unavailable. Configure JEV_PROFILE_KEY or unlock the OS credential store.",
        );
      }
    }
    if (
      !value ||
      !/^[A-Za-z0-9+/]{43}=$/.test(value) ||
      Buffer.from(value, "base64").length !== 32
    )
      throw new Error("Profile encryption requires a 32-byte base64 key.");
    return crypto.subtle.importKey(
      "raw",
      Buffer.from(value, "base64"),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
  }
  /** Remove unrelated origin storage and parent-domain cookies that were not explicitly scoped. */
  private scoped(state: Storage): Storage {
    const hosts = this.origins.map((origin) => new URL(origin).hostname);
    return {
      cookies: state.cookies
        .filter((c) => hosts.includes(c.domain.replace(/^\./, "")))
        .map((c) => ({ ...c, domain: c.domain.replace(/^\./, "") })),
      origins: state.origins.filter((o) => this.origins.includes(o.origin)),
    };
  }
  async load(): Promise<Storage | undefined> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) return;
    if (file.size > 4_000_000) throw new Error("Profile exceeds 4 MB.");
    const key = await this.key(false);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const plain = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bytes.subarray(0, 12),
          additionalData: new TextEncoder().encode(this.path),
        },
        key,
        bytes.subarray(12),
      );
      const saved = JSON.parse(new TextDecoder().decode(plain));
      if (
        !object(saved) ||
        saved.version !== 1 ||
        !Array.isArray(saved.allowedOrigins) ||
        saved.allowedOrigins.length !== this.origins.length ||
        !this.origins.every((o) =>
          (saved.allowedOrigins as unknown[]).includes(o),
        ) ||
        !object(saved.state) ||
        !Array.isArray(saved.state.cookies) ||
        !Array.isArray(saved.state.origins)
      )
        throw new Error();
      return this.scoped(saved.state as unknown as Storage);
    } catch {
      throw new Error(
        "Profile could not be decrypted. Check its encryption key; the existing profile was not changed.",
      );
    }
  }
  async save(context: BrowserContext) {
    const state = this.scoped(await context.storageState({ indexedDB: true }));
    const plain = new TextEncoder().encode(
      JSON.stringify({ version: 1, allowedOrigins: this.origins, state }),
    );
    if (plain.length > 4_000_000) throw new Error("Profile exceeds 4 MB.");
    const key = await this.key(true),
      iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: new TextEncoder().encode(this.path),
      },
      key,
      plain,
    );
    await mkdir(resolve(this.path, ".."), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, Buffer.concat([iv, new Uint8Array(encrypted)]), {
      mode: 0o600,
    });
    await rename(temporary, this.path);
  }
}

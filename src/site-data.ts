import type { BrowserContext, Page } from "playwright";
import { httpUrl, object } from "./config";

export interface SiteCookie {
  /** An HTTP(S) origin. Cookies use its host, not its port, and exclude subdomains. */
  origin: string;
  name: string;
  /** null deletes the cookie at this host and path. */
  value: string | null;
  path?: string;
  /** Unix seconds; omit or use -1 for a session cookie. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}
export interface SiteData {
  cookies?: SiteCookie[];
  /** Exact origins mapped to keys. null deletes a key restored from a profile. */
  localStorage?: Record<string, Record<string, string | null>>;
  /** Initial values for the first task tab; subsequent changes follow browser semantics. */
  sessionStorage?: Record<string, Record<string, string | null>>;
}
type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

/** Validate run input before opening a browser; diagnostics never echo stored values. */
export function siteDataOptions(input: unknown): SiteData | undefined {
  if (input === undefined) return;
  if (
    !object(input) ||
    Object.keys(input).some(
      (k) => !["cookies", "localStorage", "sessionStorage"].includes(k),
    )
  )
    throw new Error(
      "Site data must contain only cookies, localStorage and sessionStorage.",
    );
  const origins = new Set<string>();
  let count = 0;
  const origin = (value: unknown) => {
    if (
      typeof value !== "string" ||
      new URL(httpUrl(value, "Site data origin")).origin !== value
    )
      throw new Error(
        "Site data needs exact HTTP(S) origins without paths or login details.",
      );
    origins.add(value);
    if (origins.size > 20)
      throw new Error("Site data is limited to 20 origins.");
    return value;
  };
  const entry = (name: unknown, value: unknown) => {
    if (
      typeof name !== "string" ||
      !name.length ||
      name.length > 256 ||
      (value !== null && (typeof value !== "string" || value.length > 8192))
    )
      throw new Error(
        "Site data keys must be 1–256 characters; values must be strings up to 8,192 characters or null to delete.",
      );
    count++;
    if (count > 100) throw new Error("Site data is limited to 100 entries.");
  };
  const result: SiteData = {};
  if (input.cookies !== undefined) {
    if (!Array.isArray(input.cookies))
      throw new Error("Site data cookies must be an array.");
    const seen = new Set<string>();
    result.cookies = input.cookies.map((cookie) => {
      if (
        !object(cookie) ||
        Object.keys(cookie).some(
          (k) =>
            ![
              "origin",
              "name",
              "value",
              "path",
              "expires",
              "httpOnly",
              "secure",
              "sameSite",
            ].includes(k),
        )
      )
        throw new Error("Invalid cookie fields in site data.");
      const site = origin(cookie.origin);
      entry(cookie.name, cookie.value);
      const path = cookie.path === undefined ? "/" : cookie.path;
      const secure =
        cookie.secure === undefined ? site.startsWith("https:") : cookie.secure;
      const sameSite = cookie.sameSite === undefined ? "Lax" : cookie.sameSite;
      const expires = cookie.expires === undefined ? -1 : cookie.expires;
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name as string) ||
        (cookie.value !== null &&
          (!/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/.test(
            cookie.value as string,
          ) ||
            (cookie.name as string).length + (cookie.value as string).length >
              4096))
      )
        throw new Error(
          "Cookie names must be HTTP tokens and values must be URL-encoded ASCII; name and value must fit in 4,096 bytes.",
        );
      if (
        typeof path !== "string" ||
        !path.startsWith("/") ||
        path.length > 1024 ||
        /[\x00-\x20\x7f;]/.test(path) ||
        typeof secure !== "boolean" ||
        (cookie.httpOnly !== undefined &&
          typeof cookie.httpOnly !== "boolean") ||
        !["Strict", "Lax", "None"].includes(sameSite as string) ||
        typeof expires !== "number" ||
        !Number.isFinite(expires) ||
        (expires !== -1 && (expires < 0 || expires > 253402300799))
      )
        throw new Error(
          "Invalid cookie path, expiry, flags or SameSite policy.",
        );
      if (
        cookie.value !== null &&
        ((secure && !site.startsWith("https:")) ||
          (sameSite === "None" && !secure) ||
          (/^__(Secure|Host|Http)-/.test(cookie.name as string) && !secure) ||
          ((cookie.name as string).startsWith("__Host-") && path !== "/") ||
          (/^__(Http|Host-Http)-/.test(cookie.name as string) &&
            cookie.httpOnly !== true))
      )
        throw new Error(
          "Secure cookies require HTTPS; SameSite=None and cookie prefixes must satisfy their security rules.",
        );
      const identity = JSON.stringify([
        new URL(site).hostname,
        path,
        cookie.name,
      ]);
      if (seen.has(identity))
        throw new Error(
          "Duplicate cookie host, path and name; cookies do not distinguish ports.",
        );
      seen.add(identity);
      return {
        origin: site,
        name: cookie.name as string,
        value: cookie.value as string | null,
        path,
        secure,
        sameSite: sameSite as SiteCookie["sameSite"],
        expires,
        httpOnly: cookie.httpOnly === true,
      };
    });
  }
  for (const kind of ["localStorage", "sessionStorage"] as const) {
    const storage = input[kind];
    if (storage === undefined) continue;
    if (!object(storage))
      throw new Error(`${kind} must map exact origins to key/value objects.`);
    result[kind] = Object.fromEntries(
      Object.entries(storage).map(([site, values]) => {
        origin(site);
        if (!object(values))
          throw new Error(`${kind} entries must be key/value objects.`);
        return [
          site,
          Object.fromEntries(
            Object.entries(values).map(([name, value]) => {
              entry(name, value);
              return [name, value as string | null];
            }),
          ),
        ];
      }),
    );
  }
  if (
    count > 100 ||
    origins.size > 20 ||
    new TextEncoder().encode(JSON.stringify(result)).length > 65_536
  )
    throw new Error(
      "Site data is limited to 100 entries, 20 origins and 64 KiB.",
    );
  return result;
}

/** Overlay only specified cookies and local keys, preserving unrelated profile state. */
export function initialSiteData(
  saved: StorageState | undefined,
  data?: SiteData,
): StorageState | undefined {
  if (!data) return saved;
  const state = structuredClone(saved ?? { cookies: [], origins: [] });
  for (const {
    origin,
    name,
    value,
    path = "/",
    expires = -1,
    httpOnly = false,
    secure = origin.startsWith("https:"),
    sameSite = "Lax",
  } of data.cookies ?? []) {
    const domain = new URL(origin).hostname;
    state.cookies = state.cookies.filter(
      (c) => !(c.domain === domain && c.path === path && c.name === name),
    );
    if (value !== null)
      state.cookies.push({
        name,
        value,
        domain,
        path,
        expires,
        httpOnly,
        secure,
        sameSite,
      });
  }
  for (const [origin, values] of Object.entries(data.localStorage ?? {})) {
    let target = state.origins.find((o) => o.origin === origin);
    if (!target) state.origins.push((target = { origin, localStorage: [] }));
    const entries = new Map(target.localStorage.map((e) => [e.name, e.value]));
    for (const [name, value] of Object.entries(values)) {
      if (value === null) entries.delete(name);
      else entries.set(name, value);
    }
    target.localStorage = [...entries].map(([name, value]) => ({
      name,
      value,
    }));
  }
  return state;
}

/** Seed the initial tab on empty, intercepted documents without contacting those sites. */
export async function seedSessionStorage(page: Page, data?: SiteData) {
  const origins = Object.entries(data?.sessionStorage ?? {}).filter(
    ([, values]) => Object.keys(values).length,
  );
  if (!origins.length) return;
  const empty = (route: import("playwright").Route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title></title>",
    });
  await page.route("**/*", empty);
  try {
    for (const [origin, entries] of origins) {
      await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 5000 });
      for (const [name, value] of Object.entries(entries)) {
        if (value === null) await page.sessionStorage.removeItem(name);
        else await page.sessionStorage.setItem(name, value);
      }
    }
    await page.goto("about:blank");
  } catch {
    throw new Error("Could not initialize sessionStorage for this run.");
  } finally {
    await page.unroute("**/*", empty);
  }
}

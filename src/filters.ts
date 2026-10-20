import { FiltersEngine, Request } from "@ghostery/adblocker";
import type { PlaywrightRequestType } from "@ghostery/adblocker";
import type { CDPSession, Page } from "playwright";
import type { PageFilters } from "./types";

export class PageFilterError extends Error {}

/** Validate user-owned filtering settings without accepting executable code. */
export function pageFilters(value: unknown = {}): Required<PageFilters> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !["blockAds", "blockedUrls", "removeSelectors"].includes(key),
    )
  )
    throw new PageFilterError("Invalid browser filter settings.");
  const input = value as Record<string, unknown>;
  if (input.blockAds !== undefined && typeof input.blockAds !== "boolean")
    throw new PageFilterError("blockAds must be true or false.");
  const list = (key: "blockedUrls" | "removeSelectors") => {
    const entries = input[key] === undefined ? [] : input[key];
    if (
      !Array.isArray(entries) ||
      entries.length > 100 ||
      entries.some(
        (item) =>
          typeof item !== "string" ||
          !item.trim() ||
          item.length > 500 ||
          /[\r\n\0]/.test(item),
      )
    )
      throw new PageFilterError(
        `${key} must contain at most 100 non-empty lines of up to 500 characters.`,
      );
    return [...new Set((entries as string[]).map((item) => item.trim()))];
  };
  const blockedUrls = list("blockedUrls").map((pattern) => {
    try {
      if (!/^(https?|\*):\/\//.test(pattern)) throw new Error();
      const url = new URL(pattern.replace(/^\*:/, "https:"));
      if (!url.hostname || url.username || url.password || url.hash)
        throw new Error();
      const normalized = pattern.startsWith("*:")
        ? url.href.replace(/^https:/, "*:")
        : url.href;
      new URLPattern(normalized);
      return normalized;
    } catch {
      throw new PageFilterError(
        "Blocked URLs must be HTTP(S) URLs or URL patterns using *, without credentials or fragments.",
      );
    }
  });
  return {
    blockAds: input.blockAds === true,
    blockedUrls,
    removeSelectors: list("removeSelectors"),
  };
}

/** Match URL components without accidentally blocking a URL merely mentioned in a query. */
export function blockedUrlMatcher(patterns: string[]) {
  const expressions = patterns.map((pattern) => new URLPattern(pattern));
  return (url: string) =>
    expressions.some((expression) => expression.test(url));
}

let adBlocker: Promise<FiltersEngine> | undefined;

/** Reuse one network-only EasyList engine per process, retrying failed loads. */
export function loadAdBlocker(): Promise<FiltersEngine> {
  return (adBlocker ??= (async () => {
    try {
      const response = await fetch(
        "https://easylist.to/easylist/easylist.txt",
        {
          signal: AbortSignal.timeout(15_000),
          redirect: "error",
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const rules = await response.text();
      if (!rules.startsWith("[Adblock Plus") || rules.length > 8_000_000)
        throw new Error("Invalid EasyList response");
      return FiltersEngine.parse(rules, {
        loadCosmeticFilters: false,
        loadCSPFilters: false,
        enableHtmlFiltering: false,
      });
    } catch (cause) {
      adBlocker = undefined;
      throw new PageFilterError(
        "Could not load the ad blocker rules. Check your connection or turn off Block ad requests and retry.",
        { cause },
      );
    }
  })());
}

/** Inspect every HTTP request and redirect in the agent's controlled tab. */
export async function installNetworkFilters(
  page: Page,
  session: CDPSession,
  filters: Required<PageFilters>,
  blocked: (url: string) => boolean,
) {
  if (!filters.blockAds && !filters.blockedUrls.length) return;
  const engine = filters.blockAds ? await loadAdBlocker() : undefined;
  const { frameTree } = await session.send("Page.getFrameTree");
  // Context routes skip redirect hops; Fetch pauses each hop before it reaches the network.
  session.on("Fetch.requestPaused", async (request) => {
    try {
      const match =
        blocked(request.request.url) ||
        engine?.match(
          Request.fromRawDetails({
            url: request.request.url,
            sourceUrl: page.url(),
            type:
              request.resourceType === "Document"
                ? request.frameId === frameTree.frame.id
                  ? "main_frame"
                  : "sub_frame"
                : (request.resourceType.toLowerCase() as PlaywrightRequestType),
          }),
        ).match;
      if (match)
        await session.send("Fetch.failRequest", {
          requestId: request.requestId,
          errorReason: "BlockedByClient",
        });
      else
        await session.send("Fetch.continueRequest", {
          requestId: request.requestId,
        });
    } catch {
      // A closing tab cancels requests; never resume a request after a matcher failure.
      await session
        .send("Fetch.failRequest", {
          requestId: request.requestId,
          errorReason: "BlockedByClient",
        })
        .catch(() => {});
    }
  });
  await session.send("Fetch.enable", {
    patterns: [
      { urlPattern: "http://*", requestStage: "Request" },
      { urlPattern: "https://*", requestStage: "Request" },
    ],
  });
}

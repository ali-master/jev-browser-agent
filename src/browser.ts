import { isDeepStrictEqual } from "node:util";
import { chromium, errors } from "playwright";
import type {
  Browser as PlaywrightBrowser,
  BrowserContext,
  CDPSession,
  Frame,
  Page,
} from "playwright";
import { httpUrl } from "./config";
import { ProfileStore, SecretVault } from "./credentials";
import type { ProfileOptions, Secrets } from "./credentials";
import type { VisualScreen, VisualPoint } from "./vision";
import {
  blockedUrlMatcher,
  installNetworkFilters,
  pageFilters,
  PageFilterError,
} from "./filters";
import type { Action, PageState, PageFilters } from "./types";

const READ_STATE = await Bun.file(
  new URL("./snapshot.js", import.meta.url),
).text();

export class StalePage extends Error {}
export interface BrowserDriver {
  screen?(page: PageState): Promise<VisualScreen>;
  bindVisual?(
    page: PageState,
    point: VisualPoint,
    hash: string,
  ): Promise<PageState>;
  observe(screenshot?: boolean): Promise<PageState>;
  settle?(page: PageState, screenshot?: boolean): Promise<PageState>;
  fresh(page: PageState, action?: Action): Promise<boolean>;
  act(
    action: Action,
    page: PageState,
    text?: string,
  ): Promise<void | "popup_opened">;
  close(): Promise<void>;
}
export interface BrowserOptions {
  profile?: ProfileOptions;
  secrets?: Secrets;
  filters?: PageFilters;
  headless?: boolean;
  cdpUrl?: string;
  /** Enable animated pointer events for an onPointer viewer. Defaults to false. */
  showPointer?: boolean;
  onPointer?: (pointer: AgentPointer) => void;
}
export interface AgentPointer {
  x: number;
  y: number;
  w: number;
  h: number;
  url: string;
  phase: "move" | "press" | "release" | "scroll" | "idle";
  label: string;
  deltaY?: number;
}

export function fingerprint(page: PageState): string {
  const actions = page.actions.map((action) => {
    if (!("node" in action)) return action;
    const { rect: _, ...semantic } = action;
    return semantic;
  });
  return new Bun.CryptoHasher("sha256")
    .update(
      JSON.stringify({
        url: page.url,
        title: page.title,
        text: page.text,
        read_text: page.read_text,
        actions,
        scroll: page.scroll,
        document: page.marker[0],
        readiness: page.readiness,
      }),
    )
    .digest("hex");
}

export class Browser implements BrowserDriver {
  private afterInput: Action | null = null;
  private closed = false;
  private observed = false;
  private screenshotRequest: Promise<string> | null = null;
  private stopWatching: (() => Promise<void>) | null = null;
  private pointer = { x: 24, y: 24 };
  private frame: Frame;
  private contexts = new Map<string, Frame>();
  private frameIds = new WeakMap<Frame, string>();
  private frameViewer?: (frame: { image: string; url: string }) => void;
  private rawGuards = new Map<string, Pick<PageState, "page_key" | "guards">>();
  private visualBindings = new Map<string, Action>();
  private constructor(
    private browser: PlaywrightBrowser,
    private context: BrowserContext,
    private session: CDPSession,
    private tab: Page,
    private sessions: Map<Page, Promise<CDPSession>>,
    private vault: SecretVault,
    private profile?: ProfileStore,
    private onPointer?: BrowserOptions["onPointer"],
    private blockedUrl: (url: string) => boolean = () => false,
  ) {
    this.frame = tab.mainFrame();
  }

  static async create(
    url: string,
    options: BrowserOptions = {},
  ): Promise<Browser> {
    const targetUrl = httpUrl(url, "Page URL");
    const vault = new SecretVault(options.secrets);
    const profile = options.profile
      ? new ProfileStore(options.profile, targetUrl)
      : undefined;
    const storageState = await profile?.load();
    const filters = pageFilters(options.filters);
    const blockedUrl = blockedUrlMatcher(filters.blockedUrls);
    if (blockedUrl(targetUrl))
      throw new PageFilterError(
        "The starting URL is blocked by your browser filters.",
      );
    let browser: PlaywrightBrowser;
    try {
      browser = options.cdpUrl
        ? await chromium.connectOverCDP(options.cdpUrl, { noDefaults: true })
        : await chromium.launch({
            headless: options.headless ?? true,
            // The CLI owns shutdown; Playwright still cleans child processes on exit.
            handleSIGINT: false,
            handleSIGTERM: false,
          });
    } catch (cause) {
      throw new Error(
        "Cannot open Chromium. Run `bun run browser:install` or check BROWSER_CDP_URL.",
        { cause },
      );
    }
    let context: BrowserContext | undefined;
    try {
      context = await browser.newContext({
        storageState,
        viewport: { width: 1120, height: 780 },
        acceptDownloads: false,
        serviceWorkers:
          filters.blockAds || filters.blockedUrls.length ? "block" : "allow",
      });
      const sessions = new Map<Page, Promise<CDPSession>>();
      const prepare = (page: Page) => {
        let ready = sessions.get(page);
        if (!ready) {
          ready = (async () => {
            const session = await context!.newCDPSession(page);
            await installNetworkFilters(page, session, filters, blockedUrl);
            await session.send("Emulation.setFocusEmulationEnabled", {
              enabled: true,
            });
            return session;
          })();
          sessions.set(page, ready);
        }
        return ready;
      };
      // A popup's first request precedes its page event; pause it until filters are installed.
      if (filters.blockAds || filters.blockedUrls.length)
        await context.route("**/*", async (route) => {
          try {
            if (blockedUrl(route.request().url()))
              return await route.abort("blockedbyclient");
            await prepare(route.request().frame().page());
            await route.continue();
          } catch {
            await route.abort().catch(() => {});
          }
        });
      context.on("page", (page) => {
        void prepare(page).catch(() => {});
      });
      if (filters.removeSelectors.length)
        await context.addInitScript(
          `Object.defineProperty(window,"__jevRemoveSelectors",{value:Object.freeze(${JSON.stringify(filters.removeSelectors)})});`,
        );
      await context.addInitScript(`window.__jevLoadedScripts=new WeakSet();
        for(const type of ['load','error']) document.addEventListener(type,event=>{
          if(event.target instanceof HTMLScriptElement) window.__jevLoadedScripts.add(event.target);
        },true);`);
      const page = await context.newPage();
      if (filters.removeSelectors.length) {
        const validSelectors = await page.evaluate((selectors) => {
          try {
            for (const selector of selectors) document.querySelector(selector);
            return true;
          } catch {
            return false;
          }
        }, filters.removeSelectors);
        if (!validSelectors)
          throw new PageFilterError(
            "Invalid CSS selector in Remove elements. Fix the selector before starting a task.",
          );
      }
      if (options.headless === false) await page.bringToFront();
      const session = await prepare(page);
      await page.goto(targetUrl, {
        waitUntil: "commit",
        timeout: 30_000,
      });
      try {
        await page.waitForLoadState("domcontentloaded", { timeout: 3000 });
      } catch (error) {
        // A committed page can still be observed while its scripts load.
        if (!(error instanceof errors.TimeoutError)) throw error;
      }
      return new Browser(
        browser,
        context,
        session,
        page,
        sessions,
        vault,
        profile,
        options.showPointer && !vault.enabled ? options.onPointer : undefined,
        blockedUrl,
      );
    } catch (cause) {
      await context?.close().catch(() => {});
      await browser.close().catch(() => {});
      if (cause instanceof PageFilterError) throw cause;
      const detail =
        cause instanceof errors.TimeoutError
          ? "The site did not respond within 30 seconds. Check the address and your connection, then try again."
          : cause instanceof Error &&
            cause.message.match(/\bnet::ERR_[A-Z0-9_]+\b/)?.[0];
      throw new Error(
        `Could not open ${new URL(targetUrl).origin}. ${
          detail ||
          "Browser initialization failed. Check Chromium or BROWSER_CDP_URL and try again."
        }`,
        { cause },
      );
    }
  }

  async evaluate<T = unknown>(
    expression: string,
    mutating = false,
  ): Promise<T> {
    try {
      if (this.frame !== this.tab.mainFrame())
        return (await this.frame.evaluate(expression)) as T;
      const result = await this.session.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails || !("value" in result.result))
        throw new Error();
      return result.result.value as T;
    } catch (error) {
      if (mutating)
        throw new Error(
          "Browser mutation was interrupted; inspect the page before starting a new run.",
        );
      if (
        this.closed ||
        !this.browser.isConnected() ||
        (error instanceof Error &&
          /Target closed|Session closed|browser has been closed|Connection closed/i.test(
            error.message,
          ))
      )
        throw new Error(
          "Browser disconnected. Start a fresh task to open a new browser.",
        );
      throw new StalePage("Document changed during observation.");
    }
  }

  /** Keep frame/tab identities private and stable for the lifetime of the owned context. */
  private contextId(frame: Frame) {
    let id = this.frameIds.get(frame);
    if (!id) {
      id = crypto.randomUUID();
      this.frameIds.set(frame, id);
    }
    return id;
  }

  /** Map local frame input to the tab viewport, rejecting hidden or transformed ancestors. */
  private async frameOffset(
    frame = this.frame,
  ): Promise<{ x: number; y: number }> {
    if (!frame.parentFrame()) return { x: 0, y: 0 };
    const element = await frame.frameElement();
    try {
      const local = await element.evaluate((node) => {
        const e = node as HTMLElement;
        const r = e.getBoundingClientRect(),
          x = r.x + r.width / 2,
          y = r.y + r.height / 2;
        for (let p: Element | null = e; p; p = p.parentElement)
          if (getComputedStyle(p).transform !== "none") return null;
        const root = e.getRootNode() as Document | ShadowRoot;
        if (
          !e.checkVisibility({
            checkOpacity: true,
            checkVisibilityCSS: true,
          }) ||
          x < 0 ||
          y < 0 ||
          x >= innerWidth ||
          y >= innerHeight ||
          root.elementFromPoint(x, y) !== e
        )
          return null;
        return {
          x: r.x + (e as HTMLElement).clientLeft,
          y: r.y + (e as HTMLElement).clientTop,
        };
      });
      if (!local)
        throw new StalePage("Frame is hidden, covered or transformed.");
      const parent = await this.frameOffset(frame.parentFrame()!);
      return { x: parent.x + local.x, y: parent.y + local.y };
    } finally {
      await element.dispose();
    }
  }

  /** Hit-test the exact input point through every ancestor frame, not just its center. */
  private async framePoint(
    point: { x: number; y: number },
    frame = this.frame,
  ): Promise<{ x: number; y: number }> {
    if (!frame.parentFrame()) return point;
    const element = await frame.frameElement();
    try {
      const next = await element.evaluate((node, p) => {
        const e = node as HTMLElement;
        const r = e.getBoundingClientRect(),
          x = r.x + (e as HTMLElement).clientLeft + p.x,
          y = r.y + (e as HTMLElement).clientTop + p.y;
        const root = e.getRootNode() as Document | ShadowRoot;
        return x >= 0 &&
          y >= 0 &&
          x < innerWidth &&
          y < innerHeight &&
          root.elementFromPoint(x, y) === e
          ? { x, y }
          : null;
      }, point);
      if (!next) throw new StalePage("Frame target is covered or clipped.");
      return await this.framePoint(next, frame.parentFrame()!);
    } finally {
      await element.dispose();
    }
  }

  /** Switch only to an owned, previously observed context and restart its live viewer. */
  private async switchContext(frame: Frame) {
    if (frame.isDetached() || frame.page().isClosed())
      throw new StalePage("Browser context disappeared.");
    if (frame.page() !== this.tab) {
      await this.stopWatching?.();
      this.tab = frame.page();
      this.session = await this.sessions.get(this.tab)!;
      this.screenshotRequest = null;
      if (this.frameViewer) await this.watchFrames(this.frameViewer);
    }
    this.frame = frame;
    this.afterInput = null;
    this.observed = false;
  }

  /** Expose context navigation as runtime-owned controls; never accept model-supplied URLs. */
  private async readState(): Promise<PageState | null> {
    if (this.vault.enabled) {
      const url = await this.evaluate<string>("location.href");
      await this.evaluate(
        `window.__jevSecretFields=${JSON.stringify(this.vault.fields(url))};true`,
      );
    }
    const state = await this.evaluate<PageState | null>(READ_STATE);
    if (!state) return null;
    for (const action of state.actions) {
      if (!("secret_key" in action) || !action.secret_key) continue;
      const value = await this.evaluate<string>(
        `String(window.__jevFast.nodes.get(${action.node})?.value ?? "")`,
      );
      action.value = this.vault.matches(action.secret_key, value)
        ? `{{secret:${action.secret_key}}}`
        : value
          ? "[redacted]"
          : "";
    }
    const offset = await this.frameOffset();
    state.context_id = this.contextId(this.frame);
    state.frame_offset = offset;
    this.contexts.clear();
    const add = (frame: Frame, label: string) => {
      const id = this.contextId(frame);
      this.contexts.set(id, frame);
      state.actions.push({
        id: `context_${id}`,
        node: -this.contexts.size,
        kind: "click",
        role: "button",
        label,
        context_id: id,
        ref: `context:${id}`,
        context: frame.url(),
        ...(/^https?:/.test(frame.url()) ? { href: frame.url() } : {}),
        native_navigation: true,
      });
    };
    for (const frame of this.frame.childFrames()) {
      if (this.blockedUrl(frame.url())) continue;
      try {
        await this.frameOffset(frame);
        add(frame, `Enter frame: ${frame.name() || frame.url()}`);
      } catch {
        /* Offscreen/covered frames are revealed by ordinary scrolling first. */
      }
    }
    if (this.frame.parentFrame())
      add(this.frame.parentFrame()!, "Return to parent frame");
    for (const tab of this.context.pages())
      if (tab !== this.tab && !tab.isClosed() && !this.blockedUrl(tab.url()))
        add(
          tab.mainFrame(),
          `Switch tab: ${(await tab.title().catch(() => "")) || tab.url()}`,
        );
    for (const action of state.actions)
      if ("rect" in action && action.rect) {
        action.rect.x += offset.x;
        action.rect.y += offset.y;
      }
    const viewport = this.tab.viewportSize();
    if (viewport) {
      state.w = viewport.width;
      state.h = viewport.height;
    }
    state.marker.push(
      state.context_id,
      offset,
      state.actions.filter((a) => "context_id" in a),
    );
    if (state.readiness === "empty" && this.contexts.size)
      state.readiness = "ready";
    state.actions = state.actions.filter(
      (action) =>
        !("href" in action && action.href && this.blockedUrl(action.href)),
    );
    const redacted = this.vault.enabled ? this.vault.redact(state) : state;
    redacted.fingerprint = fingerprint(redacted);
    if (this.vault.enabled) {
      this.rawGuards.set(redacted.fingerprint, {
        page_key: state.page_key,
        guards: state.guards,
      });
      while (this.rawGuards.size > 8)
        this.rawGuards.delete(this.rawGuards.keys().next().value!);
    }
    return redacted;
  }

  async observe(screenshot = false): Promise<PageState> {
    if (this.tab.isClosed() || this.frame.isDetached()) {
      const tab = this.context.pages().find((page) => !page.isClosed());
      if (!tab) throw new Error("All owned tabs were closed.");
      await this.switchContext(tab.mainFrame());
    }
    const action = this.afterInput;
    const waitForControls = !this.observed || Boolean(action);
    this.afterInput = null;
    if (action) {
      // Read-only settling happens after the action has been recorded by Agent.
      try {
        await this.evaluate(`(action => new Promise(resolve => {
          const field=window.__jevFast?.nodes.get(action.node);
          const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
          const section=action.kind==='click' && field instanceof HTMLAnchorElement && field.hash &&
            field.href.split('#')[0]===location.href.split('#')[0];
          let frames=0, stable=0, x=scrollX, y=scrollY, stopped=false;
          const finish=()=>{stopped=true;resolve(true)};
          setTimeout(finish,section ? 2000 : autocomplete ? 200 : 50);
          const ready=()=>{
            if(stopped) return;
            stable=scrollX===x && scrollY===y ? stable+1 : 0;
            x=scrollX; y=scrollY;
            const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'').split(/\\s+/).filter(Boolean);
            const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
            const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
            if(++frames>=2 && (!section || stable>=4) && (!autocomplete || options.some(e=>{
              const r=e.getBoundingClientRect();
              return r.width && r.height && r.bottom>0 && r.top<innerHeight && e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
            }))) finish(); else requestAnimationFrame(ready);
          };
          requestAnimationFrame(ready);
        }))(${JSON.stringify(action)})`);
      } catch (error) {
        if (!(error instanceof StalePage)) throw error;
      }
    }
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const state = await this.readState();
        if (!state) throw new StalePage("Document is navigating.");
        if (
          attempt < 9 &&
          (state.readiness === "loading" ||
            (waitForControls && state.readiness === "empty"))
        ) {
          await Bun.sleep(100);
          continue;
        }
        state.actions = state.actions.filter(
          (action) =>
            !("href" in action && action.href && this.blockedUrl(action.href)),
        );
        state.fingerprint = fingerprint(state);
        this.observed = true;
        if (screenshot) await this.capture(state);
        return state;
      } catch (error) {
        if (!(error instanceof StalePage) || attempt === 29) throw error;
        await Bun.sleep(100);
      }
    }
    throw new StalePage("Page did not settle.");
  }

  private async capture(state: PageState) {
    if (this.vault.enabled) {
      state.screenshot_status = "unavailable";
      state.screenshot_error =
        "Images are disabled for runs containing secrets.";
      return;
    }
    state.screenshot_status = "unavailable";
    state.screenshot_error =
      "Screenshot unavailable; DOM observation remains usable.";
    if (this.screenshotRequest) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = this.session
        .send("Page.captureScreenshot", { format: "jpeg", quality: 72 })
        .then((result) => result.data);
      this.screenshotRequest = request;
      const clear = () => {
        if (this.screenshotRequest === request) this.screenshotRequest = null;
      };
      void request.then(clear, clear);
      state.screenshot = await Promise.race([
        request,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Screenshot timeout")),
            1000,
          );
        }),
      ]);
      state.screenshot_status = "captured";
      delete state.screenshot_error;
    } catch {
      /* A missing frame must not discard a healthy DOM observation. */
    } finally {
      clearTimeout(timer);
    }
  }

  async settle(page: PageState, screenshot = false): Promise<PageState> {
    const deadline = Date.now() + 1000;
    let current = page;
    do {
      await Bun.sleep(100);
      current = await this.observe();
      if (
        current.fingerprint !== page.fingerprint &&
        current.readiness !== "loading"
      )
        break;
    } while (Date.now() < deadline);
    if (screenshot) await this.capture(current);
    return current;
  }

  /** Capture an optional vision frame separately from recordings, with a bounded wait. */
  async screen(page: PageState): Promise<VisualScreen> {
    if (this.vault.enabled)
      throw new Error("Vision is disabled for runs containing secrets.");
    if (!(await this.fresh(page)))
      throw new StalePage("Page changed before vision.");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.session.send("Page.captureScreenshot", { format: "png" }),
        new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Vision capture timed out.")),
              3000,
            );
        }),
      ]);
      if (result.data.length > 7_000_000)
        throw new Error("Vision image exceeds its size budget.");
      return {
        image: result.data,
        hash: new Bun.CryptoHasher("sha256").update(result.data).digest("hex"),
        w: page.w,
        h: page.h,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Bind a proposed pixel to an observed canvas/application node, never an arbitrary page coordinate. */
  async bindVisual(
    page: PageState,
    point: VisualPoint,
    hash: string,
  ): Promise<PageState> {
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y) ||
      point.x < 0 ||
      point.y < 0 ||
      point.x >= page.w ||
      point.y >= page.h ||
      typeof point.label !== "string" ||
      !point.label.trim() ||
      point.label.length > 120
    )
      throw new Error("Invalid visual point.");
    const offset = await this.frameOffset(),
      local = { x: point.x - offset.x, y: point.y - offset.y };
    const binding = await this.evaluate<{
      node: number;
      guard: unknown;
    } | null>(`(() => {
      const c=window.__jevFast, e=c?.hit(${local.x},${local.y})?.closest('canvas,[role="application"]');
      if(!e || !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
      if(!c.ids.has(e)) c.ids.set(e,c.next++);
      const node=c.ids.get(e);c.nodes.set(node,e);
      return {node,guard:c.guard(e)};
    })()`);
    if (!binding)
      throw new Error(
        "Visual target is not inside an observed canvas/application widget.",
      );
    if ((await this.screen(page)).hash !== hash)
      throw new StalePage("Image changed during vision.");
    const state = structuredClone(page);
    const action: Action = {
      id: `visual_${crypto.randomUUID()}`,
      kind: "click",
      node: binding.node,
      ref: `${page.document_id}:${binding.node}`,
      role: "canvas",
      label: point.label,
      visual: { ...local, hash },
      rect: { x: point.x - 3, y: point.y - 3, w: 6, h: 6 },
    };
    state.actions.push(action);
    state.guards[String(binding.node)] = binding.guard;
    state.fingerprint = fingerprint(state);
    this.visualBindings.set(state.fingerprint, structuredClone(action));
    while (this.visualBindings.size > 8)
      this.visualBindings.delete(this.visualBindings.keys().next().value!);
    return state;
  }

  async fresh(page: PageState, action?: Action): Promise<boolean> {
    if (page.context_id !== this.contextId(this.frame)) return false;
    if (!Bun.deepEquals(page.frame_offset, await this.frameOffset(), true))
      return false;
    if (
      action &&
      (action.kind === "click" || action.kind === "select") &&
      !action.context_id
    ) {
      if (!Number.isSafeInteger(action.node)) return false;
      const current = await this.evaluate(`(() => { const c=window.__jevFast;
        return c ? [c.pageKey(),c.guard(c.nodes.get(${action.node}))] : null; })()`);
      return Bun.deepEquals(
        this.vault.enabled ? this.vault.redact(current) : current,
        [page.page_key, page.guards[String(action.node)]],
        true,
      );
    }
    return Bun.deepEquals(
      (await this.readState())?.marker ?? null,
      page.marker,
      true,
    );
  }

  async act(
    action: Action,
    page: PageState,
    text?: string,
  ): Promise<void | "popup_opened"> {
    if ("href" in action && action.href && this.blockedUrl(action.href))
      throw new PageFilterError(
        "This link is blocked by your browser filters.",
      );
    // Bun.deepEquals accepts null-prototype copies, unlike this input guard.
    if (!page.actions.some((observed) => isDeepStrictEqual(action, observed)))
      throw new Error("Action is not from the observed page.");
    if (
      action.kind === "fill" &&
      (typeof text !== "string" || !text.trim() || text.length > 2000)
    )
      throw new Error("Invalid field text; nothing typed.");
    if (!(await this.fresh(page, action)))
      throw new StalePage("Page changed since this decision. Observe again.");
    if ("visual" in action && action.visual) {
      if (!isDeepStrictEqual(this.visualBindings.get(page.fingerprint), action))
        throw new StalePage("Visual binding expired.");
      const current = await this.framePoint({
        x: action.visual.x,
        y: action.visual.y,
      });
      await this.movePointer(current, page, action);
      if (
        (await this.screen(page)).hash !== action.visual.hash ||
        !(await this.fresh(page, action))
      )
        throw new StalePage("Image changed before visual input.");
      const hit = await this.evaluate<boolean>(
        `(()=>{const c=window.__jevFast,e=c?.nodes.get(${action.node});return Boolean(e?.contains(c.hit(${action.visual.x},${action.visual.y})));})()`,
      );
      if (!hit) throw new StalePage("Visual target is covered.");
      for (const type of ["mousePressed", "mouseReleased"] as const) {
        await this.session.send("Input.dispatchMouseEvent", {
          type,
          ...current,
          button: "left",
          clickCount: 1,
        });
        this.showPointer(
          page,
          action,
          type === "mousePressed" ? "press" : "release",
        );
      }
      this.afterInput = action;
      return;
    }
    if (action.kind === "fill" && action.secret_key)
      text = this.vault.resolve(
        action,
        await this.evaluate<string>("location.origin"),
        text!,
      );
    if ("context_id" in action && action.context_id) {
      const frame = this.contexts.get(action.context_id);
      if (!frame) throw new StalePage("Context is no longer offered.");
      if (this.blockedUrl(frame.url()))
        throw new PageFilterError("Context URL is blocked.");
      await this.switchContext(frame);
      return;
    }
    if (action.kind === "wait") {
      await Bun.sleep(300);
      return;
    }
    if (action.kind === "scroll") {
      const origin = await this.evaluate<{
        x: number;
        y: number;
      } | null>(`(() => {
        for (const [x,y] of [[.5,.5],[.9,.5],[.1,.5],[.5,.25],[.95,.9],[.05,.9]]) {
          const point={x:innerWidth*x,y:innerHeight*y};
          let e=document.elementFromPoint(point.x,point.y);
          if (!e || e.closest('iframe,canvas,embed,object,video,textarea,select,[contenteditable="true"],[role="application"]')) continue;
          for (;e && e!==document.body && e!==document.documentElement;e=e.parentElement)
            if (/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight>e.clientHeight+2) break;
          if (!e || e===document.body || e===document.documentElement) return point;
        }
        return null;
      })()`);
      if (origin) Object.assign(origin, await this.framePoint(origin));
      else if (this.frame.parentFrame())
        throw new StalePage("No unobstructed frame scroll point.");
      await this.movePointer(
        origin ?? { x: page.w / 2, y: page.h * 0.8 },
        page,
        action,
      );
      if (!(await this.fresh(page)))
        throw new StalePage(
          "Page changed while moving the pointer. Observe again.",
        );
      this.showPointer(page, action, "scroll");
      try {
        const frames = this.onPointer ? 8 : 1;
        for (let i = 0; i < frames; i++) {
          await this.session.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            ...this.pointer,
            deltaX: 0,
            deltaY: action.delta / frames,
          });
          if (frames > 1) await Bun.sleep(35);
        }
      } finally {
        this.showPointer(page, action, "idle");
      }
    } else {
      if (!Number.isSafeInteger(action.node))
        throw new Error("Invalid observed node.");
      const nativeFill =
        action.kind === "fill" &&
        [
          "date",
          "time",
          "datetime-local",
          "month",
          "week",
          "range",
          "color",
        ].includes(action.input_type ?? "");
      const guarded = this.rawGuards.get(page.fingerprint) ?? page;
      const expected = [guarded.page_key, guarded.guards[String(action.node)]];
      const resolveTarget = (
        apply: boolean,
        point?: { x: number; y: number },
      ) =>
        this.evaluate<{
          x: number;
          y: number;
          invalid?: boolean;
        } | null>(
          `(action => {
        const c=window.__jevFast, e=c?.nodes.get(action.node);
        if (!e?.isConnected || JSON.stringify([c.pageKey(),c.guard(e)])!==${JSON.stringify(JSON.stringify(expected))}) return null;
        if (e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') || !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
        if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
        const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
        if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight || !e.contains(c.hit(x,y))) return null;
        const point=${JSON.stringify(point ?? null)};
        if (point && (Math.abs(x-point.x)>1 || Math.abs(y-point.y)>1)) return null;
        if (${nativeFill}) {
          if (e.tagName!=='INPUT' || e.type!==action.input_type) return null;
          const value=${JSON.stringify(text ?? "")}, probe=document.createElement('input');
          probe.type=e.type;
          for (const key of ['min','max','step']) probe[key]=e[key];
          probe.value=value;
          if (!probe.value || !probe.validity.valid ||
            (e.type==='range' && (!Number.isFinite(Number(value)) || probe.valueAsNumber!==Number(value))) ||
            (e.type==='color' && !/^#[0-9a-f]{6}$/i.test(value))) return {x,y,invalid:true};
          if (${apply}) {
            e.value=probe.value;
            e.dispatchEvent(new Event('input',{bubbles:true}));
            e.dispatchEvent(new Event('change',{bubbles:true}));
          }
        }
        if (action.kind==='select') {
          const option=e.options?.[action.option_index];
          if (e.tagName!=='SELECT' || !Number.isSafeInteger(action.option_index) || !option || option!==c.nodes.get(action.option_node) || option.value!==action.value || option.disabled || option.closest('optgroup[disabled]')) return null;
          if (${apply}) {
            e.selectedIndex=action.option_index;
            e.dispatchEvent(new Event('input',{bubbles:true}));
            e.dispatchEvent(new Event('change',{bubbles:true}));
          }
        }
        if (${apply} && !action.popup_owner && (action.kind==='fill' ||
          ['combobox','textbox','searchbox','spinbutton'].includes(action.role)))
          c.beginPopup?.(action.ref);
        return {x,y};
      })(${JSON.stringify(action)})`,
          apply && (action.kind === "select" || nativeFill),
        );
      const target = await resolveTarget(false);
      if (!target)
        throw new StalePage("Target changed or is covered. Observe again.");
      if (target.invalid)
        throw new Error(
          "Invalid native input value or constraint; nothing entered.",
        );
      const offset = await this.frameOffset();
      await this.movePointer(await this.framePoint(target), page, action);
      // Hover can move, cover or replace the target; never click the old position.
      const current = await resolveTarget(true, target);
      if (!current)
        throw new StalePage(
          "Target changed while moving the pointer. Observe again.",
        );
      if (current.invalid)
        throw new Error("Native input constraints changed; nothing entered.");
      if (!Bun.deepEquals(offset, await this.frameOffset(), true))
        throw new StalePage("Frame moved before input.");
      Object.assign(current, await this.framePoint(current));
      if (action.scroll_delta) {
        this.showPointer(page, action, "scroll");
        await this.session.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: current.x,
          y: current.y,
          deltaX: 0,
          deltaY: action.scroll_delta,
        });
        this.afterInput = action;
        return;
      }
      if (action.kind !== "select" && !nativeFill) {
        // CDP inputs are never retried: a rejected response can follow a successful mutation.
        for (const type of ["mousePressed", "mouseReleased"] as const) {
          await this.session.send("Input.dispatchMouseEvent", {
            type,
            x: current.x,
            y: current.y,
            button: "left",
            clickCount: 1,
          });
          this.showPointer(
            page,
            action,
            type === "mousePressed" ? "press" : "release",
          );
          if (type === "mousePressed" && this.onPointer) await Bun.sleep(90);
        }
        if (action.kind === "fill") {
          const focused = await this.evaluate<boolean>(
            `window.__jevFast?.active()===window.__jevFast?.nodes.get(${action.node})`,
            true,
          );
          if (!focused) {
            const opened = await this.evaluate<boolean>(`(() => {
              const state=${READ_STATE};
              return Boolean(state?.actions.some(a=>a.popup_owner===${JSON.stringify(action.ref)}) &&
                [...(window.__jevFast?.popupOwners||[])].some(([root,owner])=>owner===${JSON.stringify(action.ref)} && root.contains(document.activeElement)));
            })()`);
            if (opened) {
              this.afterInput = { ...action, kind: "click" };
              return "popup_opened";
            }
            throw new Error("Field lost focus after clicking; nothing typed.");
          }
          const modifiers = process.platform === "darwin" ? 4 : 2;
          await this.session.send("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "a",
            code: "KeyA",
            modifiers,
            commands: ["selectAll"],
          });
          await this.session.send("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "a",
            code: "KeyA",
            modifiers,
          });
          await this.session.send("Input.insertText", { text: text! });
        }
      } else {
        this.showPointer(page, action, "release");
      }
    }
    this.afterInput = action;
  }

  private showPointer(
    page: PageState,
    action: Action,
    phase: AgentPointer["phase"],
  ) {
    try {
      this.onPointer?.({
        ...this.pointer,
        w: page.w,
        h: page.h,
        url: page.url,
        phase,
        label: action.label,
        ...(action.kind === "scroll" ? { deltaY: action.delta } : {}),
      });
    } catch {
      // Viewer failures must never interrupt or replay browser input.
    }
  }

  private async movePointer(
    target: { x: number; y: number },
    page: PageState,
    action: Action,
  ) {
    const from = this.pointer;
    const frames = this.onPointer ? 12 : 1;
    const moves: Promise<unknown>[] = [];
    let failure: unknown;
    for (let i = 1; i <= frames; i++) {
      if (failure) break;
      const t = i / frames;
      const ease = t * t * (3 - 2 * t);
      this.pointer = {
        x: from.x + (target.x - from.x) * ease,
        y: from.y + (target.y - from.y) * ease,
      };
      // Keep the animation clock independent of Chromium's compositor acknowledgements.
      moves.push(
        this.session
          .send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            ...this.pointer,
          })
          .catch((error) => {
            failure ??= error;
          }),
      );
      this.showPointer(page, action, "move");
      if (frames > 1) await Bun.sleep(25);
    }
    await Promise.all(moves);
    if (failure) throw failure;
  }

  async watchFrames(onFrame: (frame: { image: string; url: string }) => void) {
    if (this.vault.enabled)
      throw new Error("Live images are disabled for runs containing secrets.");
    this.frameViewer = onFrame;
    await this.stopWatching?.();
    await this.session.send("Page.enable");
    let main = (await this.session.send("Page.getFrameTree")).frameTree.frame;
    let active = true;
    const navigate = ({
      frame,
    }: {
      frame: { id: string; parentId?: string; url: string };
    }) => {
      if (!frame.parentId) main = { ...main, ...frame };
    };
    const withinDocument = ({
      frameId,
      url,
    }: {
      frameId: string;
      url: string;
    }) => {
      if (frameId === main.id) main.url = url;
    };
    const frame = ({
      data,
      sessionId,
    }: {
      data: string;
      sessionId: number;
    }) => {
      try {
        if (active)
          onFrame({
            image: data,
            url: this.frame.parentFrame() ? this.frame.url() : main.url,
          });
      } catch {
        // Viewer failures must not interrupt browser input or frame acknowledgements.
      } finally {
        void this.session
          .send("Page.screencastFrameAck", { sessionId })
          .catch(() => {});
      }
    };
    const stop = async () => {
      if (!active) return;
      active = false;
      this.session.off("Page.screencastFrame", frame);
      this.session.off("Page.frameNavigated", navigate);
      this.session.off("Page.navigatedWithinDocument", withinDocument);
      await this.session.send("Page.stopScreencast").catch(() => {});
    };
    this.stopWatching = stop;
    this.session.on("Page.screencastFrame", frame);
    this.session.on("Page.frameNavigated", navigate);
    this.session.on("Page.navigatedWithinDocument", withinDocument);
    try {
      await this.session.send("Page.startScreencast", {
        format: "jpeg",
        quality: 65,
        maxWidth: 1120,
        maxHeight: 780,
        everyNthFrame: 1,
      });
    } catch (error) {
      await stop();
      throw error;
    }
    return stop;
  }

  async close(persist = true): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.stopWatching?.();
      if (persist) await this.profile?.save(this.context);
    } finally {
      try {
        await this.context.close();
      } finally {
        await this.browser.close();
      }
    }
  }
}

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { chromium } from "playwright";
import type { Browser as PlaywrightBrowser, BrowserContext, CDPSession } from "playwright";
import { httpUrl } from "./config.js";
import type { Action, PageState } from "./types.js";

const READ_STATE = await Bun.file(new URL("./snapshot.js", import.meta.url)).text();

export class StalePage extends Error {}
export interface BrowserDriver {
  observe(screenshot?: boolean): Promise<PageState>;
  fresh(page: PageState, action?: Action): Promise<boolean>;
  act(action: Action, page: PageState, text?: string): Promise<void>;
  close(): Promise<void>;
}
export interface BrowserOptions {
  headless?: boolean;
  cdpUrl?: string;
}

export function fingerprint(page: PageState): string {
  const actions = page.actions.map((action) => {
    if (!("node" in action)) return action;
    const { rect: _, ...semantic } = action;
    return semantic;
  });
  return createHash("sha256")
    .update(
      JSON.stringify({
        url: page.url,
        title: page.title,
        text: page.text,
        actions,
        scroll: page.scroll,
        document: page.marker[0],
      }),
    )
    .digest("hex");
}

export class Browser implements BrowserDriver {
  private afterInput: Action | null = null;
  private closed = false;
  private stopWatching: (() => Promise<void>) | null = null;
  private constructor(
    private browser: PlaywrightBrowser,
    private context: BrowserContext,
    private session: CDPSession,
  ) {}

  static async create(url: string, options: BrowserOptions = {}): Promise<Browser> {
    const targetUrl = httpUrl(url, "Page URL");
    let browser: PlaywrightBrowser;
    try {
      browser = options.cdpUrl
        ? await chromium.connectOverCDP(options.cdpUrl, { noDefaults: true })
        : await chromium.launch({ headless: options.headless ?? true });
    } catch {
      throw new Error(
        "Cannot open Chromium. Run `bun run browser:install` or check BROWSER_CDP_URL.",
      );
    }
    let context: BrowserContext | undefined;
    try {
      context = await browser.newContext({
        viewport: { width: 1120, height: 780 },
        acceptDownloads: false,
      });
      const page = await context.newPage();
      const session = await context.newCDPSession(page);
      await session.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      return new Browser(browser, context, session);
    } catch {
      try {
        await context?.close();
      } finally {
        await browser.close();
      }
      throw new Error("Could not open the requested page; the owned browser context was closed.");
    }
  }

  async evaluate<T = unknown>(expression: string, mutating = false): Promise<T> {
    try {
      const result = await this.session.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails || !("value" in result.result)) throw new Error();
      return result.result.value as T;
    } catch {
      if (mutating)
        throw new Error(
          "Browser mutation was interrupted; inspect the page before starting a new run.",
        );
      throw new StalePage("Document changed during observation.");
    }
  }

  async observe(screenshot = false): Promise<PageState> {
    const action = this.afterInput;
    this.afterInput = null;
    if (action) {
      // Read-only settling happens after the action has been recorded by Agent.
      try {
        await this.evaluate(`(action => new Promise(resolve => {
          const field=window.__jevFast?.nodes.get(action.node);
          const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
          let frames=0, stopped=false;
          const finish=()=>{stopped=true;resolve(true)};
          setTimeout(finish,autocomplete ? 200 : 50);
          const ready=()=>{
            if(stopped) return;
            const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'').split(/\\s+/).filter(Boolean);
            const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
            const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
            if(++frames>=2 && (!autocomplete || options.some(e=>{
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
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const state = await this.evaluate<PageState | null>(READ_STATE);
        if (!state) throw new StalePage("Document is navigating.");
        state.fingerprint = fingerprint(state);
        if (screenshot)
          state.screenshot = (
            await this.session.send("Page.captureScreenshot", { format: "jpeg", quality: 72 })
          ).data;
        return state;
      } catch (error) {
        if (!(error instanceof StalePage) || attempt === 9) throw error;
        await Bun.sleep(20);
      }
    }
    throw new StalePage("Page did not settle.");
  }

  async fresh(page: PageState, action?: Action): Promise<boolean> {
    if (action && (action.kind === "click" || action.kind === "select")) {
      if (!Number.isSafeInteger(action.node)) return false;
      const current = await this.evaluate(`(() => { const c=window.__jevFast;
        return c ? [c.pageKey(),c.guard(c.nodes.get(${action.node}))] : null; })()`);
      return isDeepStrictEqual(current, [page.page_key, page.guards[String(action.node)]]);
    }
    return isDeepStrictEqual(
      await this.evaluate(`(() => { const state=${READ_STATE}; return state?.marker ?? null; })()`),
      page.marker,
    );
  }

  async act(action: Action, page: PageState, text?: string): Promise<void> {
    if (!page.actions.some((observed) => isDeepStrictEqual(action, observed)))
      throw new Error("Action is not from the observed page.");
    if (action.kind === "fill" && (typeof text !== "string" || !text.trim() || text.length > 2000))
      throw new Error("Invalid field text; nothing typed.");
    if (!(await this.fresh(page, action)))
      throw new StalePage("Page changed since this decision. Observe again.");
    if (action.kind === "wait") {
      await Bun.sleep(100);
      return;
    }
    if (action.kind === "scroll") {
      await this.session.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 550,
        y: 650,
        deltaX: 0,
        deltaY: action.delta,
      });
    } else {
      if (!Number.isSafeInteger(action.node)) throw new Error("Invalid observed node.");
      const nativeFill =
        action.kind === "fill" &&
        ["date", "time", "datetime-local", "month", "week", "range", "color"].includes(
          action.input_type ?? "",
        );
      const expected = [page.page_key, page.guards[String(action.node)]];
      const target = await this.evaluate<{ x: number; y: number; invalid?: boolean } | null>(
        `(action => {
        const c=window.__jevFast, e=c?.nodes.get(action.node);
        if (!e?.isConnected || JSON.stringify([c.pageKey(),c.guard(e)])!==${JSON.stringify(JSON.stringify(expected))}) return null;
        if (e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') || !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
        if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
        const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
        if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight || !e.contains(document.elementFromPoint(x,y))) return null;
        if (${nativeFill}) {
          if (e.tagName!=='INPUT' || e.type!==action.input_type) return null;
          const value=${JSON.stringify(text ?? "")}, probe=document.createElement('input');
          probe.type=e.type;
          for (const key of ['min','max','step']) probe[key]=e[key];
          probe.value=value;
          if (!probe.value || !probe.validity.valid ||
            (e.type==='range' && (!Number.isFinite(Number(value)) || probe.valueAsNumber!==Number(value))) ||
            (e.type==='color' && !/^#[0-9a-f]{6}$/i.test(value))) return {x,y,invalid:true};
          e.value=probe.value;
          e.dispatchEvent(new Event('input',{bubbles:true}));
          e.dispatchEvent(new Event('change',{bubbles:true}));
        }
        if (action.kind==='select') {
          const option=e.options?.[action.option_index];
          if (e.tagName!=='SELECT' || !Number.isSafeInteger(action.option_index) || !option || option!==c.nodes.get(action.option_node) || option.value!==action.value || option.disabled || option.closest('optgroup[disabled]')) return null;
          e.selectedIndex=action.option_index;
          e.dispatchEvent(new Event('input',{bubbles:true}));
          e.dispatchEvent(new Event('change',{bubbles:true}));
        }
        return {x,y};
      })(${JSON.stringify(action)})`,
        action.kind === "select" || nativeFill,
      );
      if (!target) throw new StalePage("Target changed or is covered. Observe again.");
      if (target.invalid)
        throw new Error("Invalid native input value or constraint; nothing entered.");
      if (action.kind !== "select" && !nativeFill) {
        // CDP inputs are never retried: a rejected response can follow a successful mutation.
        for (const type of ["mousePressed", "mouseReleased"] as const) {
          await this.session.send("Input.dispatchMouseEvent", {
            type,
            ...target,
            button: "left",
            clickCount: 1,
          });
        }
        if (action.kind === "fill") {
          const focused = await this.evaluate<boolean>(
            `document.activeElement===window.__jevFast?.nodes.get(${action.node})`,
            true,
          );
          if (!focused) throw new Error("Field lost focus after clicking; nothing typed.");
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
      }
    }
    this.afterInput = action;
  }

  async watchFrames(onFrame: (frame: { image: string; url: string }) => void) {
    await this.stopWatching?.();
    await this.session.send("Page.enable");
    let main = (await this.session.send("Page.getFrameTree")).frameTree.frame;
    let active = true;
    const navigate = ({ frame }: { frame: { id: string; parentId?: string; url: string } }) => {
      if (!frame.parentId) main = { ...main, ...frame };
    };
    const withinDocument = ({ frameId, url }: { frameId: string; url: string }) => {
      if (frameId === main.id) main.url = url;
    };
    const frame = ({ data, sessionId }: { data: string; sessionId: number }) => {
      try {
        if (active) onFrame({ image: data, url: main.url });
      } catch {
        // Viewer failures must not interrupt browser input or frame acknowledgements.
      } finally {
        void this.session.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
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

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.stopWatching?.();
      await this.context.close();
    } finally {
      await this.browser.close();
    }
  }
}

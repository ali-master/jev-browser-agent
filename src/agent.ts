import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Browser, StalePage } from "./browser.js";
import type { BrowserDriver, BrowserOptions } from "./browser.js";
import { SettingsStore } from "./config.js";
import { actionSpace, choose, fieldContext, fieldText } from "./model.js";
import { MAX_STEPS } from "./questions.js";
import { createPlan, updateProgress } from "./plan.js";
import type { Action, AgentState, ModelCall, SettingsReader } from "./types.js";

export interface AgentOptions extends BrowserOptions {
  screenshots?: boolean;
  recordDir?: string;
  maxSteps?: number;
  settings?: SettingsReader;
  onUpdate?: () => void;
}
const stopped = (state: AgentState) =>
  ["done", "blocked", "error", "closed"].includes(state.status);

export class Agent {
  readonly state: AgentState;
  readonly maxSteps: number;
  private startedAt: number | null = null;
  private busy = false;
  private pendingText: { key: string; text: string; helper: ModelCall } | null = null;
  private settings: SettingsReader;

  constructor(
    readonly browser: BrowserDriver,
    page: AgentState["page"],
    goal: string,
    private options: AgentOptions = {},
  ) {
    if (!goal.trim() || goal.length > 2000) throw new Error("Enter a goal of 1–2,000 characters.");
    this.maxSteps = options.maxSteps ?? MAX_STEPS;
    if (!Number.isSafeInteger(this.maxSteps) || this.maxSteps < 1 || this.maxSteps > 1000)
      throw new Error("maxSteps must be between 1 and 1000.");
    this.settings = options.settings ?? (() => new SettingsStore().read());
    this.state = {
      goal: goal.trim(),
      page,
      decision: null,
      history: [],
      status: "ready",
      activity: null,
      plan: [goal.trim()],
      plan_index: 0,
      checkpoints: [],
      planning_calls: [],
      decisions: [],
      text_calls: [],
      elapsed_ms: 0,
      record: Boolean(options.recordDir),
    };
  }

  static async create(url: string, goal: string, options: AgentOptions = {}): Promise<Agent> {
    if (!goal.trim() || goal.length > 2000) throw new Error("Enter a goal of 1–2,000 characters.");
    const browser = await Browser.create(url, options);
    try {
      const agent = new Agent(
        browser,
        await browser.observe(options.screenshots || Boolean(options.recordDir)),
        goal,
        options,
      );
      await agent.record();
      return agent;
    } catch (error) {
      await browser.close();
      throw error;
    }
  }

  snapshot() {
    return structuredClone({
      ...this.state,
      elements: actionSpace(this.state.page.actions).elements,
      max_steps: this.maxSteps,
    });
  }
  private elapsed() {
    return Math.round(performance.now() - (this.startedAt ?? performance.now()));
  }
  private notify() {
    this.state.elapsed_ms = this.elapsed();
    try {
      this.options.onUpdate?.();
    } catch {
      // A disconnected viewer must never change browser execution or retry an action.
    }
  }
  private activity(
    kind: NonNullable<AgentState["activity"]>["kind"],
    action?: Action,
    text?: string,
  ) {
    this.state.activity = { kind, started_at: Date.now(), action, text };
    this.notify();
  }

  async command(name: "predict" | "act" | "tick", body: { fingerprint?: string } = {}) {
    if (this.busy) throw new Error("A browser step is already running.");
    if (stopped(this.state)) throw new Error("This run has stopped. Start a fresh run.");
    this.busy = true;
    this.startedAt ??= performance.now();
    try {
      if (name === "predict" || name === "tick") await this.predict();
      if ((name === "act" || name === "tick") && !stopped(this.state))
        await this.act(name === "tick" ? this.state.page.fingerprint : body.fingerprint);
    } catch (error) {
      this.state.decision = null;
      if (error instanceof StalePage) {
        this.state.status = "ready";
        if (name !== "tick") throw error;
        this.state.page = await this.browser.observe(this.options.screenshots || this.state.record);
      } else {
        if (this.state.status !== "blocked") this.state.status = "error";
        this.pendingText = null;
        throw error;
      }
    } finally {
      this.state.activity = null;
      this.state.elapsed_ms = this.elapsed();
      try {
        await this.record();
      } finally {
        this.busy = false;
        this.notify();
      }
    }
    return this.snapshot();
  }

  private async predict() {
    const state = this.state;
    state.decision = null;
    this.activity("observing");
    if (!(await this.browser.fresh(state.page)))
      state.page = await this.browser.observe(this.options.screenshots || state.record);
    if (!state.checkpoints.length) {
      this.activity("planning");
      const { steps } = await createPlan(
        state.page,
        state.goal,
        async () => (await this.settings()).text,
        state.planning_calls,
      );
      state.plan = steps.map((step) => step.instruction);
      state.checkpoints = steps.map((step) => ({
        ...step,
        started_at_action: null,
        started_fingerprint: null,
        verified: null,
      }));
    }
    await this.progress();
    if (stopped(state)) return;
    if (state.decisions.length >= this.maxSteps * 2) {
      state.status = "blocked";
      throw new Error("Reached the model-call budget.");
    }
    const config = await this.settings();
    this.activity("deciding");
    state.decision = await choose(
      state.page,
      state.plan[state.plan_index]!,
      state.history,
      config.decision,
      false,
    );
    state.decisions.push({
      ...state.decision,
      fingerprint: state.page.fingerprint,
      elapsed_ms: this.elapsed(),
    });
    state.status = "predicted";
  }

  private async progress() {
    const state = this.state;
    if (!(await this.browser.fresh(state.page)))
      throw new StalePage("Page changed before checkpoint verification.");
    state.plan_index = updateProgress(state.checkpoints, state.page, state.history);
    if (state.checkpoints.length && state.plan_index === state.checkpoints.length) {
      state.status = "done";
      this.pendingText = null;
    }
  }

  private async act(expectedFingerprint?: string) {
    const state = this.state;
    const { decision, page } = state;
    if (!decision || expectedFingerprint !== page.fingerprint)
      throw new Error("Observe and choose before acting.");
    // Consume once before any model call or browser mutation.
    state.decision = null;
    if (decision.choice === "DONE")
      throw new Error("Completion requires verified checkpoints, not a model DONE response.");
    if (decision.choice === "BLOCKED") {
      if (!(await this.browser.fresh(page)))
        throw new StalePage("Page changed since the decision.");
      state.status = "blocked";
      this.pendingText = null;
      return;
    }
    const action = page.actions.find((candidate) => candidate.id === decision.choice);
    if (!action) throw new Error("Decision does not identify an observed action.");
    if (state.history.length >= this.maxSteps) {
      state.status = "blocked";
      throw new Error("Reached the browser-action budget.");
    }
    let text: string | undefined;
    let helper: ModelCall | undefined;
    if (action.kind === "fill") {
      if (!(await this.browser.fresh(page)))
        throw new StalePage("Page changed before text generation.");
      const context = fieldContext(
        `${state.plan[state.plan_index]}\nOriginal goal: ${state.goal}`,
        action,
        page,
        state.history,
      );
      const config = (await this.settings()).text;
      const key = JSON.stringify({ context, config });
      if (this.pendingText?.key === key) ({ text, helper } = this.pendingText);
      else {
        this.activity("writing", action);
        ({ text, helper } = await fieldText(context, config));
        this.pendingText = { key, text, helper };
        state.text_calls.push({ ...helper, field: action.label, value: text });
      }
    }
    this.activity("acting", action, text);
    await this.browser.act(action, page, text);
    this.pendingText = null;
    state.elapsed_ms = this.elapsed();
    const entry = {
      step: state.history.length + 1,
      action: action.label,
      kind: action.kind,
      choice: decision.choice,
      probability: decision.probabilities[decision.choice]!,
      confidence: decision.confidence,
      latency_ms: decision.latency_ms,
      text: text ?? null,
      text_helper: helper?.model ?? null,
      text_latency_ms: helper?.latency_ms ?? 0,
      operation: decision.operation,
      target: decision.target,
      page_changed: null as boolean | null,
      url: page.url,
      usage: decision.usage,
      executed_ms: state.elapsed_ms,
      elapsed_ms: state.elapsed_ms,
    };
    state.history.push(entry);
    this.activity("observing", action, text);
    await this.record(false);
    state.page = await this.browser.observe(this.options.screenshots || state.record);
    entry.page_changed = state.page.fingerprint !== page.fingerprint;
    entry.url = state.page.url;
    entry.elapsed_ms = this.elapsed();
    const repeated = state.history.slice(-3);
    state.status =
      repeated.length === 3 &&
      repeated.every((item) => item.page_changed === false && item.kind !== "wait")
        ? "blocked"
        : "ready";
    await this.progress();
  }

  private async record(screenshot = true) {
    if (!this.options.recordDir) return;
    const directory = resolve(this.options.recordDir);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const snapshot = this.snapshot();
    const { screenshot: frame, ...page } = snapshot.page;
    await Bun.write(
      resolve(directory, "state.json"),
      JSON.stringify({ ...snapshot, page }, null, 2),
    );
    if (screenshot && frame)
      await Bun.write(
        resolve(directory, `${String(this.state.elapsed_ms).padStart(6, "0")}.jpg`),
        Buffer.from(frame, "base64"),
      );
  }

  async *run() {
    while (!stopped(this.state)) yield await this.command("tick");
  }
  async close() {
    if (this.busy) throw new Error("Wait for the current browser step before closing.");
    this.pendingText = null;
    this.state.decision = null;
    if (!stopped(this.state)) this.state.status = "closed";
    await this.browser.close();
  }
  async [Symbol.asyncDispose]() {
    await this.close();
  }
}

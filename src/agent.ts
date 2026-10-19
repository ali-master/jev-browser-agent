import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Browser, StalePage } from "./browser.js";
import type { BrowserDriver, BrowserOptions } from "./browser.js";
import { SettingsStore } from "./config.js";
import { actionSpace, choose, fieldContext, fieldText } from "./model.js";
import { MAX_STEPS } from "./questions.js";
import { createPlan, reviewCompletion, updateProgress } from "./plan.js";
import { summarizeUsage } from "./usage.js";
import type {
  Action,
  AgentState,
  Decision,
  HistoryEntry,
  ModelCall,
  ModelRole,
  SettingsReader,
  TaskStep,
} from "./types.js";

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
  private pendingText: { key: string; text: string; helper: ModelCall } | null =
    null;
  private settings: SettingsReader;
  private selection: {
    fingerprint: string;
    decision: Decision;
    action?: Action;
  } | null = null;
  private pendingObservation: {
    entry: HistoryEntry;
    fingerprint: string;
  } | null = null;
  private plannedAt = "";
  private revisionCount = 0;
  private reviewCount = 0;

  constructor(
    readonly browser: BrowserDriver,
    page: AgentState["page"],
    goal: string,
    private options: AgentOptions = {},
  ) {
    if (!goal.trim() || goal.length > 2000)
      throw new Error("Enter a goal of 1–2,000 characters.");
    this.maxSteps = options.maxSteps ?? MAX_STEPS;
    if (
      !Number.isSafeInteger(this.maxSteps) ||
      this.maxSteps < 1 ||
      this.maxSteps > 1000
    )
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
      plan_revisions: [],
      completion_reviews: [],
      answer: null,
      planning_calls: [],
      decisions: [],
      text_calls: [],
      model_calls: [],
      elapsed_ms: 0,
      record: Boolean(options.recordDir),
    };
  }

  static async create(
    url: string,
    goal: string,
    options: AgentOptions = {},
  ): Promise<Agent> {
    if (!goal.trim() || goal.length > 2000)
      throw new Error("Enter a goal of 1–2,000 characters.");
    const browser = await Browser.create(url, options);
    try {
      const agent = new Agent(
        browser,
        await browser.observe(
          options.screenshots || Boolean(options.recordDir),
        ),
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
      usage: summarizeUsage(this.state.model_calls),
    });
  }
  private elapsed() {
    return Math.round(
      performance.now() - (this.startedAt ?? performance.now()),
    );
  }
  private modelObserver(role: ModelRole) {
    return (call: ModelCall) => {
      this.state.model_calls.push({ ...call, role });
    };
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

  async command(
    name: "predict" | "act" | "tick",
    body: { fingerprint?: string } = {},
  ) {
    if (this.busy) throw new Error("A browser step is already running.");
    if (stopped(this.state))
      throw new Error("This run has stopped. Start a fresh run.");
    this.busy = true;
    this.startedAt ??= performance.now();
    try {
      if (name === "predict" || name === "tick") await this.predict();
      if ((name === "act" || name === "tick") && !stopped(this.state))
        await this.act(
          name === "tick" ? this.state.page.fingerprint : body.fingerprint,
        );
    } catch (error) {
      this.state.decision = null;
      if (error instanceof StalePage) {
        this.state.status = "ready";
        if (name !== "tick") throw error;
        try {
          this.acceptObservation(
            await this.browser.observe(
              this.options.screenshots || this.state.record,
            ),
          );
          if (this.state.checkpoints.length) await this.progress();
        } catch (recoveryError) {
          this.state.status = "error";
          this.state.stop_reason = {
            code: "observation_failed",
            message:
              "Could not recover the page observation. Inspect the last action before starting a fresh task.",
          };
          throw recoveryError;
        }
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
    this.selection = null;
    state.decision = null;
    this.activity("observing");
    if (!(await this.browser.fresh(state.page)))
      state.page = await this.browser.observe(
        this.options.screenshots || state.record,
      );
    if (!state.checkpoints.length) {
      this.activity("planning");
      const { steps } = await createPlan(
        state.page,
        state.goal,
        async () => (await this.settings()).text,
        state.planning_calls,
        this.modelObserver("planning"),
      );
      this.setRemaining(steps);
    }
    await this.progress();
    if (stopped(state)) return;
    if (state.decisions.length >= this.maxSteps * 2) {
      state.status = "blocked";
      throw new Error("Reached the model-call budget.");
    }
    const config = await this.settings();
    this.activity("deciding");
    const observed = structuredClone(state.page);
    state.decision = await choose(
      observed,
      state.plan[state.plan_index]!,
      state.history,
      config.decision,
      false,
      this.modelObserver("decision"),
    );
    this.selection = {
      fingerprint: observed.fingerprint,
      decision: structuredClone(state.decision),
      action: observed.actions.find(
        (action) => action.id === state.decision!.choice,
      ),
    };
    state.decisions.push({
      ...state.decision,
      fingerprint: observed.fingerprint,
      elapsed_ms: this.elapsed(),
    });
    state.status = "predicted";
  }

  private async progress() {
    const state = this.state;
    if (!(await this.browser.fresh(state.page)))
      throw new StalePage("Page changed before checkpoint verification.");
    state.plan_index = updateProgress(
      state.checkpoints,
      state.page,
      state.history,
    );
    if (
      state.checkpoints.length &&
      state.plan_index === state.checkpoints.length
    ) {
      if (this.reviewCount++ >= 3) {
        state.status = "blocked";
        state.stop_reason = {
          code: "verification_budget",
          message:
            "The goal could not be verified within the review budget. Inspect the result and refine the task.",
        };
        return;
      }
      this.activity("verifying");
      const review = await reviewCompletion(
        state.page,
        state.goal,
        state.checkpoints,
        async () => (await this.settings()).text,
        this.modelObserver("verification"),
      );
      state.completion_reviews.push(review);
      if (!(await this.browser.fresh(state.page)))
        throw new StalePage("Page changed during the final goal review.");
      if (review.complete) {
        state.answer = review.answer;
        state.status = "done";
        delete state.stop_reason;
      } else if (review.missing_steps.length && this.revisionCount < 2) {
        this.revise(
          "The completion review found missing requirements.",
          review.missing_steps,
        );
        await this.progress();
      } else {
        state.status = "blocked";
        state.stop_reason = {
          code: "unverified_goal",
          message:
            "The original goal still lacks observed evidence. Review the remaining requirements before starting again.",
        };
      }
      this.pendingText = null;
    }
  }

  private setRemaining(steps: TaskStep[]) {
    const completed = this.state.checkpoints
      .slice(0, this.state.plan_index)
      .filter((step) => step.verified);
    this.state.checkpoints = [
      ...completed,
      ...steps.map((step) => ({
        ...step,
        started_at_action: null,
        started_fingerprint: null,
        verified: null,
      })),
    ];
    this.state.plan = this.state.checkpoints.map((step) => step.instruction);
    this.state.plan_index = completed.length;
    this.plannedAt = `${this.state.page.document_id}\n${this.state.page.url}`;
    this.state.status = "ready";
    this.state.answer = null;
    delete this.state.stop_reason;
  }

  private revise(reason: string, steps: TaskStep[]) {
    this.revisionCount++;
    this.state.plan_revisions.push({
      reason,
      checkpoints: structuredClone(this.state.checkpoints),
    });
    this.setRemaining(steps);
  }

  private async replanAfterNavigation() {
    const state = this.state;
    if (
      this.revisionCount >= 2 ||
      this.plannedAt === `${state.page.document_id}\n${state.page.url}`
    )
      return false;
    this.activity("planning");
    const { steps } = await createPlan(
      state.page,
      state.goal,
      async () => (await this.settings()).text,
      state.planning_calls,
      this.modelObserver("planning"),
      {
        completed: state.checkpoints.slice(0, state.plan_index),
        remaining: state.checkpoints.slice(state.plan_index),
      },
    );
    this.revise(
      "An observed destination did not match the remaining plan.",
      steps,
    );
    return true;
  }

  private async act(expectedFingerprint?: string) {
    const state = this.state;
    const { decision, page } = state;
    const selection = this.selection;
    this.selection = null;
    // Consume once before any model call or browser mutation.
    state.decision = null;
    if (!decision || !selection)
      throw new Error("Observe and choose before acting.");
    if (
      expectedFingerprint !== page.fingerprint ||
      selection.fingerprint !== page.fingerprint ||
      !isDeepStrictEqual(decision, selection.decision)
    )
      throw new StalePage(
        "Decision no longer matches its original observation. Choose again.",
      );
    if (decision.choice === "DONE")
      throw new Error(
        "Completion requires verified checkpoints, not a model DONE response.",
      );
    if (decision.choice === "BLOCKED") {
      if (!(await this.browser.fresh(page)))
        throw new StalePage("Page changed since the decision.");
      this.activity("observing");
      const settled = this.browser.settle
        ? await this.browser.settle(
            page,
            this.options.screenshots || state.record,
          )
        : await this.browser.observe(this.options.screenshots || state.record);
      state.page = settled;
      if (
        settled.fingerprint !== page.fingerprint &&
        settled.readiness !== "loading"
      ) {
        state.status = "ready";
        await this.progress();
        return;
      }
      if (
        settled.readiness !== "loading" &&
        !settled.omitted_actions &&
        !settled.discovery_limited &&
        (await this.replanAfterNavigation())
      )
        return;
      state.status = "blocked";
      state.stop_reason =
        settled.omitted_actions || settled.discovery_limited
          ? {
              code: "incomplete_observation",
              message:
                "Some controls were omitted from the observation. Narrow the page or scroll to the required control and start again.",
            }
          : settled.readiness === "loading" || settled.readiness === "empty"
            ? {
                code: "page_not_ready",
                message:
                  "No ready controls appeared within the bounded wait. Check whether the page is still loading, then start again.",
              }
            : {
                code: "unsupported_step",
                message:
                  "The model could not choose a supported action for the current step. Review the page and task.",
              };
      this.pendingText = null;
      return;
    }
    const action = page.actions.find(
      (candidate) => candidate.id === decision.choice,
    );
    if (!action)
      throw new Error("Decision does not identify an observed action.");
    const semanticAction = (value: Action) =>
      "node" in value ? { ...value, rect: undefined } : value;
    if (
      !selection.action ||
      !isDeepStrictEqual(
        semanticAction(action),
        semanticAction(selection.action),
      )
    )
      throw new StalePage(
        "The selected control changed identity. Choose again.",
      );
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
        const result = await fieldText(
          context,
          async () => (await this.settings()).text,
          this.modelObserver("text"),
        );
        helper = result.helper;
        state.text_calls.push({
          ...helper,
          field: action.label,
          value: result.text,
        });
        if (result.text === null) {
          state.status = "blocked";
          state.stop_reason = {
            code: "missing_value",
            message: `A required value for “${action.label}” is missing. Add it to the task and start again; nothing was typed.`,
          };
          this.pendingText = null;
          return;
        }
        text = result.text;
        this.pendingText = { key, text, helper };
      }
    }
    this.activity("acting", action, text);
    await this.browser.act(action, page, text);
    this.pendingText = null;
    state.elapsed_ms = this.elapsed();
    const entry = {
      step: state.history.length + 1,
      action: action.label,
      ref: "node" in action ? action.ref : undefined,
      scope: "node" in action ? action.scope : undefined,
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
    this.pendingObservation = { entry, fingerprint: page.fingerprint };
    this.activity("observing", action, text);
    await this.record(false);
    this.acceptObservation(
      await this.browser.observe(this.options.screenshots || state.record),
    );
    await this.progress();
  }

  private acceptObservation(page: AgentState["page"]) {
    this.state.page = page;
    if (!this.pendingObservation) return;
    const { entry, fingerprint } = this.pendingObservation;
    entry.page_changed = page.fingerprint !== fingerprint;
    entry.url = page.url;
    entry.elapsed_ms = this.elapsed();
    this.pendingObservation = null;
    const repeated = this.state.history.slice(-3);
    this.state.status =
      repeated.length === 3 &&
      repeated.every(
        (item) => item.page_changed === false && item.kind !== "wait",
      )
        ? "blocked"
        : "ready";
    if (this.state.status === "blocked")
      this.state.stop_reason = {
        code: "no_progress",
        message:
          "Three browser actions produced no observed progress. Review the current step before starting again.",
      };
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
        resolve(
          directory,
          `${String(this.state.elapsed_ms).padStart(6, "0")}.jpg`,
        ),
        Buffer.from(frame, "base64"),
      );
  }

  async *run() {
    while (!stopped(this.state)) yield await this.command("tick");
  }
  async close() {
    if (this.busy)
      throw new Error("Wait for the current browser step before closing.");
    this.pendingText = null;
    this.state.decision = null;
    if (!stopped(this.state)) this.state.status = "closed";
    await this.browser.close();
  }
  async [Symbol.asyncDispose]() {
    await this.close();
  }
}

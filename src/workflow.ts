import { mkdir, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { object } from "./config";
import type { Action, PageState, TaskStep } from "./types";

export interface WorkflowOptions {
  /** A local recipe name. Only successful runs replace its recorded actions. */
  name: string;
  /** Values for explicit {{name}} placeholders in the goal. */
  parameters?: Record<string, string>;
  /** Private recipe directory; defaults to .jev/workflows. */
  directory?: string;
}

/** Validate recipes before opening a browser or accessing their local files. */
export function workflowOptions(value: unknown): WorkflowOptions {
  if (
    !object(value) ||
    typeof value.name !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value.name) ||
    (value.directory !== undefined && typeof value.directory !== "string") ||
    (value.parameters !== undefined &&
      (!object(value.parameters) ||
        Object.entries(value.parameters).some(
          ([key, val]) =>
            !/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(key) ||
            typeof val !== "string" ||
            !val.trim() ||
            val.length > 500 ||
            val.includes("{{"),
        )))
  )
    throw new Error(
      "Use a workflow name and a JSON object of string parameters.",
    );
  const values = Object.values(value.parameters ?? {});
  if (new Set(values).size !== values.length)
    throw new Error("Workflow parameter values must be distinct.");
  return {
    name: value.name,
    parameters: { ...(value.parameters as Record<string, string> | undefined) },
    directory: value.directory as string | undefined,
  };
}

/** Substitute only explicit, supplied goal parameters; never infer missing data. */
export function workflowGoal(goal: string, options?: WorkflowOptions): string {
  if (!options) return goal;
  const { parameters } = workflowOptions(options);
  return goal.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (_, key) => {
    if (!Object.hasOwn(parameters!, key))
      throw new Error(`Missing workflow parameter: ${key}.`);
    return parameters![key]!;
  });
}

/** Bind a saved action to current semantic properties, excluding document-local IDs. */
function target(action: Action) {
  return {
    kind: action.kind,
    label: action.label,
    ...("node" in action
      ? {
          role: action.role,
          scope: action.scope,
          context: action.context,
          href: action.href,
          input_type: action.input_type,
          value: action.value,
          current_value: action.current_value,
          checked: action.checked,
          selected: action.selected,
          expanded: action.expanded,
          option_index:
            action.kind === "select" ? action.option_index : undefined,
        }
      : action.kind === "scroll"
        ? { delta: action.delta }
        : {}),
  };
}

interface SavedAction {
  before: string;
  after: string;
  step: string;
  target: string;
  text?: string;
}

/** Reuse verified action sequences locally while keeping planning and final review live. */
export class WorkflowCache {
  readonly stats: {
    name: string;
    hits: number;
    misses: number;
    saved: boolean;
    error?: string;
  };
  private cached: SavedAction[] = [];
  private recorded: SavedAction[] = [];
  private pending?: SavedAction;
  private expectedAfter?: string;
  private replay = true;
  private readonly path: string;
  private readonly parameters: Record<string, string>;

  constructor(
    readonly template: string,
    readonly startUrl: string,
    private options: WorkflowOptions,
  ) {
    this.parameters = options.parameters ?? {};
    this.path = resolve(
      options.directory ?? ".jev/workflows",
      `${options.name}.json`,
    );
    this.stats = { name: options.name, hits: 0, misses: 0, saved: false };
  }

  /** Load a bounded recipe for precisely the same goal template and starting URL. */
  async load() {
    const file = Bun.file(this.path);
    if (!(await file.exists())) return;
    if (file.size > 2_000_000) throw new Error("Workflow file exceeds 2 MB.");
    const saved = await file.json();
    if (
      !object(saved) ||
      saved.version !== 1 ||
      saved.template !== this.template ||
      saved.startUrl !== this.normalize(this.startUrl) ||
      !Array.isArray(saved.actions) ||
      saved.actions.length > 1000 ||
      !saved.actions.every(
        (item: unknown) =>
          object(item) &&
          ["before", "after", "step", "target"].every(
            (key) => typeof item[key] === "string",
          ) &&
          (item.text === undefined || typeof item.text === "string"),
      )
    )
      return;
    this.cached = saved.actions;
  }

  /** Replace values in a single pass so parameter values cannot introduce templates. */
  private normalize(value: string): string {
    const entries = Object.entries(this.parameters).sort(
      (a, b) => b[1].length - a[1].length,
    );
    if (!entries.length) return value;
    return value.replace(
      new RegExp(entries.map(([, val]) => RegExp.escape(val)).join("|"), "g"),
      (match) => `{{${entries.find(([, val]) => val === match)![0]}}}`,
    );
  }

  /** Hash observed state without persisting page text, coordinates or node references. */
  signature(page: PageState): string {
    const content = this.normalize(
      JSON.stringify({
        url: page.url,
        title: page.title,
        text: page.text,
        scroll: page.scroll,
        actions: page.actions.map(target),
      }),
    );
    return new Bun.CryptoHasher("sha256").update(content).digest("hex");
  }

  /** Require the new planner to request the same semantic step before replay. */
  private stepKey(step: TaskStep): string {
    return this.normalize(
      JSON.stringify({
        instruction: step.instruction,
        checks: step.checks.map((check) =>
          "ref" in check ? { ...check, ref: null } : check,
        ),
      }),
    );
  }

  /** Return a uniquely observed action, or fall back to the normal decision model. */
  choose(page: PageState, step: TaskStep) {
    const saved = this.cached[this.recorded.length];
    if (!this.replay || !saved || page.readiness === "loading") return null;
    const actions = page.actions.filter(
      (action) =>
        this.normalize(JSON.stringify(target(action))) === saved.target,
    );
    if (
      saved.before !== this.signature(page) ||
      saved.step !== this.stepKey(step) ||
      actions.length !== 1
    ) {
      this.stats.misses++;
      this.replay = false;
      return null;
    }
    this.expectedAfter = saved.after;
    this.stats.hits++;
    return {
      action: actions[0]!,
      text:
        saved.text === undefined
          ? undefined
          : workflowGoal(saved.text, this.options),
    };
  }

  /** Keep only actions whose browser input was confirmed; saving still requires DONE. */
  performed(page: PageState, step: TaskStep, action: Action, text?: string) {
    this.pending = {
      before: this.signature(page),
      after: "",
      step: this.stepKey(step),
      target: this.normalize(JSON.stringify(target(action))),
      ...(text === undefined ? {} : { text: this.normalize(text) }),
    };
  }

  /** Invalidate replay when a confirmed action reaches an unexpected observed state. */
  observed(page: PageState) {
    if (!this.pending) return;
    this.pending.after = this.signature(page);
    if (this.expectedAfter && this.expectedAfter !== this.pending.after) {
      this.replay = false;
      this.stats.misses++;
    }
    this.expectedAfter = undefined;
    this.recorded.push(this.pending);
    this.pending = undefined;
  }

  /** Atomically publish a private recipe only after the original goal was verified. */
  async save() {
    if (this.stats.saved || this.pending || !this.recorded.length) return;
    const directory = resolve(this.options.directory ?? ".jev/workflows");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({
        version: 1,
        template: this.template,
        startUrl: this.normalize(this.startUrl),
        actions: this.recorded,
      }),
      { mode: 0o600 },
    );
    await rename(temporary, this.path);
    this.stats.saved = true;
  }
}

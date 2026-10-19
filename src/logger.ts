import type { AgentState } from "./types";

const levels = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };
const details = { low: 0, normal: 1, high: 2 };
type Level = keyof typeof levels;
type Detail = keyof typeof details;
const colors: Record<Level, number> = {
  error: 31,
  warn: 33,
  info: 36,
  debug: 35,
  trace: 90,
};
const clean = (value: unknown) =>
  Bun.stripANSI(String(value))
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .slice(0, 400);

export class Logger {
  readonly level: Level;
  readonly detail: Detail;
  private color: boolean;
  private write: (line: string) => unknown;
  private started = performance.now();

  constructor(
    options: {
      level?: string;
      detail?: string;
      color?: string;
      env?: Record<string, string | undefined>;
      tty?: boolean;
      write?: (line: string) => unknown;
    } = {},
  ) {
    const { level = "info", detail = "normal", color = "auto" } = options;
    if (!Object.hasOwn(levels, level))
      throw new Error(
        "--log-level must be error, warn, info, debug, or trace.",
      );
    if (!Object.hasOwn(details, detail))
      throw new Error("--log-detail must be low, normal, or high.");
    if (!["auto", "always", "never"].includes(color))
      throw new Error("--color must be auto, always, or never.");
    this.level = level as Level;
    this.detail = detail as Detail;
    const env = options.env ?? process.env;
    this.color =
      color === "always" ||
      (color === "auto" &&
        env.NO_COLOR === undefined &&
        env.FORCE_COLOR !== "0" &&
        (env.FORCE_COLOR !== undefined ||
          ((options.tty ?? process.stderr.isTTY) && env.TERM !== "dumb")));
    this.write = options.write ?? ((line) => process.stderr.write(line));
  }

  log(
    level: Level,
    message: string,
    data: Record<string, unknown> = {},
    detail: Detail = "normal",
  ) {
    if (
      levels[level] > levels[this.level] ||
      (levels[level] > 1 && details[detail] > details[this.detail])
    )
      return;
    const elapsed = ((performance.now() - this.started) / 1000)
      .toFixed(1)
      .padStart(6);
    const label = level.toUpperCase().padEnd(5);
    const badge = this.color ? `\x1b[${colors[level]}m${label}\x1b[0m` : label;
    const fields = Object.entries(data)
      .map(([key, value]) => `${clean(key)}=${clean(value)}`)
      .join(" ");
    this.write(
      `${elapsed}s ${badge} ${clean(message)}${fields ? `  ${fields}` : ""}\n`,
    );
  }
}

// URLs may carry authentication, search terms, or personal data in their query.
export function logUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "(unavailable)";
  }
}

export class AgentReporter {
  private activity: AgentState["activity"] = null;
  private stageStarted = 0;
  private phases: Record<string, number> = {};
  private calls = 0;
  private decisions = 0;
  private actions = 0;
  private observed = 0;
  private verified = -1;
  private url = "";

  constructor(
    private logger: Logger,
    private now = () => performance.now(),
  ) {}

  update(state: AgentState) {
    const now = this.now();
    if (state.activity !== this.activity) {
      if (this.activity) {
        const ms = Math.round(now - this.stageStarted);
        const kind = this.activity.kind;
        this.phases[kind] = (this.phases[kind] ?? 0) + ms;
        this.logger.log("debug", `${kind} finished`, { ms }, "high");
      }
      this.activity = state.activity;
      this.stageStarted = now;
      if (this.activity) this.logger.log("info", `${this.activity.kind}…`);
    }
    for (; this.calls < state.model_calls.length; this.calls++) {
      const call = state.model_calls[this.calls]!;
      const failed = call.outcome && call.outcome !== "response";
      this.logger.log(failed ? "warn" : "debug", `${call.role} model`, {
        model: call.model,
        ms: call.latency_ms,
        outcome: call.outcome ?? "response",
        ...(call.http_status ? { http: call.http_status } : {}),
      });
      this.logger.log(
        "trace",
        "Model token counts",
        {
          input:
            call.usage.prompt_tokens ?? call.usage.input_tokens ?? "unknown",
          output:
            call.usage.completion_tokens ??
            call.usage.output_tokens ??
            "unknown",
        },
        "high",
      );
    }
    for (; this.decisions < state.decisions.length; this.decisions++) {
      const decision = state.decisions[this.decisions]!;
      this.logger.log("debug", "Decision selected", {
        operation: decision.operation,
        target: decision.target ?? "none",
        confidence: decision.confidence.toFixed(3),
        ms: decision.latency_ms,
      });
    }
    for (; this.actions < state.history.length; this.actions++) {
      const entry = state.history[this.actions]!;
      this.logger.log("info", `Action ${entry.step}: ${entry.kind}`, {
        target: entry.action,
      });
    }
    while (
      this.observed < state.history.length &&
      state.history[this.observed]!.page_changed !== null
    ) {
      const entry = state.history[this.observed++]!;
      this.logger.log("debug", "Observed result", {
        step: entry.step,
        changed: entry.page_changed,
        ms: entry.elapsed_ms - entry.executed_ms,
      });
    }
    if (state.page.url !== this.url) {
      this.url = state.page.url;
      this.logger.log("info", "Page", { url: logUrl(this.url) });
    }
    const count = state.checkpoints.filter(
      (checkpoint) => checkpoint.verified,
    ).length;
    if (state.checkpoints.length && count !== this.verified) {
      this.verified = count;
      this.logger.log("info", "Checklist", {
        verified: `${count}/${state.checkpoints.length}`,
      });
    }
  }

  finish(state: AgentState) {
    this.update(state);
    const models = state.model_calls.reduce(
      (sum, call) => sum + call.latency_ms,
      0,
    );
    this.logger.log(
      state.status === "done" ? "info" : "warn",
      state.status === "done" ? "Goal verified" : `Stopped: ${state.status}`,
      {
        actions: state.history.length,
        total_ms: state.elapsed_ms,
        model_ms: models,
        other_ms: Math.max(0, state.elapsed_ms - models),
        requests: state.model_calls.length,
      },
      "low",
    );
    this.logger.log("debug", "Stage time (ms)", this.phases);
    if (state.stop_reason)
      this.logger.log(
        "warn",
        state.stop_reason.message,
        { code: state.stop_reason.code },
        "low",
      );
  }
}

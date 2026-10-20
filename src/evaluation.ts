import { Agent } from "./agent";
import { validateSchema } from "./output";
import { updateProgress } from "./plan";
import { summarizeUsage } from "./usage";
import { httpUrl } from "./config";
import { scenarios } from "./scenarios";
import type { CompletionCheck, SettingsReader } from "./types";

export interface EvaluationCase {
  id: string;
  url: string;
  goal: string;
  assertions: CompletionCheck[];
}
export interface EvaluationVariant {
  name: string;
  settings: SettingsReader;
}
export interface EvaluationResult {
  case: string;
  variant: string;
  repeat: number;
  passed: boolean;
  agent_done: boolean;
  assertions_passed: boolean;
  status: string;
  failure_stage: string | null;
  reason: string | null;
  wall_ms: number;
  model_ms: number;
  other_ms: number;
  actions: number;
  usage: ReturnType<typeof summarizeUsage>;
}
export interface EvaluationReport {
  started_at: string;
  cancelled: boolean;
  results: EvaluationResult[];
  summary: {
    variant: string;
    runs: number;
    passed: number;
    success_rate: number;
    p50_ms: number;
    p95_ms: number;
  }[];
}
const assertion = (kind: string, fields: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: ["kind", ...Object.keys(fields)],
  properties: { kind: { const: kind }, ...fields },
});
const checkSchema = {
  anyOf: [
    ...["url", "title", "text"].map((kind) =>
      assertion(kind, {
        includes: { type: "string", minLength: 1, maxLength: 2000 },
      }),
    ),
    assertion("value", {
      label: { type: "string", minLength: 1 },
      equals: { type: "string" },
    }),
    ...["checked", "expanded"].map((kind) =>
      assertion(kind, {
        label: { type: "string", minLength: 1 },
        equals: { type: "boolean" },
      }),
    ),
  ],
};
const validate = validateSchema({
  type: "array",
  minItems: 1,
  maxItems: 20,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["id", "url", "goal", "assertions"],
    properties: {
      id: { type: "string", minLength: 1, maxLength: 80 },
      url: { type: "string" },
      goal: { type: "string", minLength: 1, maxLength: 2000 },
      assertions: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: checkSchema,
      },
    },
  },
});

/** Validate caller-owned scenarios before any browser or model is started. */
export function evaluationCases(input: unknown): EvaluationCase[] {
  if (!validate(input))
    throw new Error(
      "Invalid evaluation suite: use 1–20 cases with id, URL, goal and independent assertions.",
    );
  const cases = structuredClone(input) as EvaluationCase[];
  if (new Set(cases.map((c) => c.id)).size !== cases.length)
    throw new Error("Evaluation case IDs must be unique.");
  for (const item of cases) httpUrl(item.url, "Evaluation URL");
  return cases;
}

/** Use deterministic local demos; model completion alone cannot satisfy these expected outcomes. */
export function inspectorEvaluationCases(origin: string): EvaluationCase[] {
  return scenarios()
    .filter((s) => ["travel", "crowded", "research"].includes(s.id))
    .map((s) => ({
      id: s.id,
      url: new URL(s.url, origin).href,
      goal: s.goal,
      assertions:
        s.id === "research"
          ? [
              { kind: "url", includes: "#choices" },
              {
                kind: "title",
                includes: "A browser is a choice, not a conversation",
              },
              { kind: "text", includes: "Freshness is part of correctness." },
            ]
          : [
              { kind: "url", includes: "#casa-flora" },
              { kind: "title", includes: "Casa Flora" },
              {
                kind: "text",
                includes:
                  "Your filters: Design · Free cancellation enabled · Destination Lisbon",
              },
            ],
    }));
}

/** Compare model configurations sequentially in fresh contexts, with independent final-page assertions. */
export async function evaluateSuite(
  input: unknown,
  variants: EvaluationVariant[],
  options: {
    repeat?: number;
    maxSteps?: number;
    signal?: AbortSignal;
    onResult?: (result: EvaluationResult) => void;
    onProgress?: (progress: {
      case: string;
      variant: string;
      repeat: number;
      stage: string;
    }) => void;
  } = {},
): Promise<EvaluationReport> {
  const cases = evaluationCases(input),
    repeat = options.repeat ?? 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 5)
    throw new Error("Evaluation repeat must be between 1 and 5.");
  if (
    options.maxSteps !== undefined &&
    (!Number.isSafeInteger(options.maxSteps) ||
      options.maxSteps < 1 ||
      options.maxSteps > 1000)
  )
    throw new Error("maxSteps must be between 1 and 1000.");
  if (
    !variants.length ||
    variants.length > 8 ||
    variants.some(
      (v) =>
        !v.name.trim() ||
        v.name.length > 120 ||
        typeof v.settings !== "function",
    ) ||
    new Set(variants.map((v) => v.name)).size !== variants.length
  )
    throw new Error("Supply 1–8 uniquely named model variants.");
  const report: EvaluationReport = {
    started_at: new Date().toISOString(),
    cancelled: false,
    results: [],
    summary: [],
  };
  outer: for (const variant of variants)
    for (const item of cases)
      for (let iteration = 1; iteration <= repeat; iteration++) {
        if (options.signal?.aborted) break outer;
        const started = performance.now();
        let agent: Agent | undefined,
          stage = "opening",
          reason: string | null = null,
          assertions = false,
          done = false,
          status = "error";
        const progress = () => {
          stage = agent?.state.activity?.kind ?? stage;
          try {
            options.onProgress?.({
              case: item.id,
              variant: variant.name,
              repeat: iteration,
              stage,
            });
          } catch {}
        };
        const cancel = () => {
          void agent?.close().catch(() => {});
        };
        options.signal?.addEventListener("abort", cancel, { once: true });
        try {
          progress();
          agent = await Agent.create(item.url, item.goal, {
            settings: variant.settings,
            maxSteps: options.maxSteps,
            onUpdate: progress,
          });
          if (options.signal?.aborted) {
            await agent.close();
            break outer;
          }
          for await (const _ of agent.run()) if (options.signal?.aborted) break;
          done = agent.state.status === "done";
          status = agent.state.status;
          if (!options.signal?.aborted) {
            const page = await agent.browser.observe();
            const checks = [
              {
                instruction: "Independent evaluation assertions",
                checks: structuredClone(item.assertions),
                started_at_action: 0,
                started_fingerprint: "evaluation",
                verified: null,
              },
            ];
            assertions =
              updateProgress(checks, page, agent.state.history) === 1;
            if (done && !assertions) {
              stage = "assertions";
              reason =
                "The final page does not satisfy the independent expected outcome.";
            } else if (!done)
              reason =
                agent.state.stop_reason?.message ??
                "Agent did not complete the goal.";
          }
        } catch (error) {
          reason =
            error instanceof Error ? error.message : "Evaluation failed.";
        } finally {
          options.signal?.removeEventListener("abort", cancel);
          try {
            await agent?.close();
          } catch {
            reason ??= "Browser cleanup failed.";
            status = "error";
          }
        }
        const usage = summarizeUsage(agent?.state.model_calls ?? []),
          wall = Math.round(performance.now() - started);
        const passed =
          done && assertions && !reason && !options.signal?.aborted;
        const row: EvaluationResult = {
          case: item.id,
          variant: variant.name,
          repeat: iteration,
          passed,
          agent_done: done,
          assertions_passed: assertions,
          status: options.signal?.aborted ? "cancelled" : status,
          failure_stage: passed
            ? null
            : options.signal?.aborted
              ? "cancelled"
              : stage,
          reason: options.signal?.aborted
            ? "Cancelled by the operator."
            : reason,
          wall_ms: wall,
          model_ms: usage.total.latency_ms,
          other_ms: Math.max(0, wall - usage.total.latency_ms),
          actions: agent?.state.history.length ?? 0,
          usage,
        };
        report.results.push(row);
        try {
          options.onResult?.(structuredClone(row));
        } catch {}
      }
  report.cancelled = options.signal?.aborted ?? false;
  for (const variant of variants) {
    const rows = report.results.filter((r) => r.variant === variant.name),
      times = rows.map((r) => r.wall_ms).sort((a, b) => a - b);
    if (!rows.length) continue;
    const passed = rows.filter((r) => r.passed).length;
    report.summary.push({
      variant: variant.name,
      runs: rows.length,
      passed,
      success_rate: passed / rows.length,
      p50_ms: times[Math.ceil(times.length * 0.5) - 1]!,
      p95_ms: times[Math.ceil(times.length * 0.95) - 1]!,
    });
  }
  return report;
}

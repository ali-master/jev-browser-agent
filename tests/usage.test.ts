import { expect, test } from "bun:test";
import { formatUsage, summarizeUsage } from "../src/usage";
import type { ModelCall, ModelRole } from "../src/types";

const call = (
  patch: Partial<ModelCall & { role: ModelRole }> = {},
): ModelCall & { role: ModelRole } => ({
  role: "decision",
  model: "small",
  endpoint: "http://localhost:1234",
  latency_ms: 10,
  usage: { prompt_tokens: 100, completion_tokens: 20 },
  outcome: "response",
  pricing: { inputUsdPerMillion: 2, outputUsdPerMillion: 4 },
  ...patch,
});

test("usage includes every physical request, every role and both token formats", () => {
  const summary = summarizeUsage([
    call(),
    call({ outcome: "http_error", usage: {} }),
    call({
      role: "planning",
      model: "chat",
      usage: { input_tokens: 200, output_tokens: 40, total_tokens: 240 },
    }),
    call({ role: "text", model: "chat", pricing: undefined }),
    call({ role: "verification", model: "chat" }),
  ]);
  expect(summary.total).toEqual({
    requests: 5,
    failed_requests: 1,
    latency_ms: 50,
    input_tokens: 500,
    output_tokens: 100,
    unknown_usage_requests: 1,
    estimated_cost_usd: 0.00112,
    unknown_cost_requests: 2,
  });
  expect(summary.by_model).toHaveLength(4);
  expect(summary.by_model[0]!.requests).toBe(2);
  const rendered = formatUsage(summary);
  expect(rendered).toContain("usage unknown for 1 requests");
  expect(rendered).toContain(
    "unknown for 2 requests ($0.001120 priced subtotal)",
  );
  expect(rendered).toContain("verification · chat");
});

test.each([
  {},
  { total_tokens: 120 },
  { input_tokens: "100", output_tokens: -5 },
  { prompt_tokens: NaN, completion_tokens: Infinity },
  { input_tokens: 1.5, output_tokens: true },
])("malformed or absent usage stays unknown: %j", (usage) => {
  const summary = summarizeUsage([call({ usage })]);
  expect(summary.total.unknown_usage_requests).toBe(1);
  expect(summary.total.unknown_cost_requests).toBe(1);
  expect(formatUsage(summary)).toContain("unknown");
});

test("explicit zero prices differ from absent rates and changes apply per request", () => {
  const summary = summarizeUsage([
    call({ pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } }),
    call({ pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } }),
  ]);
  expect(summary.total.unknown_cost_requests).toBe(0);
  expect(summary.total.estimated_cost_usd).toBeCloseTo(0.00012, 8);
  expect(
    summarizeUsage([
      call({ pricing: { inputUsdPerMillion: -1, outputUsdPerMillion: 1 } }),
    ]).total.unknown_cost_requests,
  ).toBe(1);
  expect(
    summarizeUsage([call({ endpoint: "https://other.test" }), call()]).by_model,
  ).toHaveLength(2);
});

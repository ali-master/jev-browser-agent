import type { ModelCall, ModelRole } from "./types.js";

const empty = () => ({
  requests: 0,
  failed_requests: 0,
  latency_ms: 0,
  input_tokens: 0,
  output_tokens: 0,
  unknown_usage_requests: 0,
  estimated_cost_usd: 0,
  unknown_cost_requests: 0,
});
const tokens = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function summarizeUsage(calls: (ModelCall & { role: ModelRole })[]) {
  const total = empty();
  const groups = new Map<
    string,
    ReturnType<typeof empty> & { role: ModelRole; model: string; endpoint?: string }
  >();
  for (const call of calls) {
    const key = JSON.stringify([call.role, call.endpoint, call.model]);
    let group = groups.get(key);
    if (!group) {
      group = { ...empty(), role: call.role, model: call.model, endpoint: call.endpoint };
      groups.set(key, group);
    }
    const input = tokens(call.usage.input_tokens ?? call.usage.prompt_tokens);
    const output = tokens(call.usage.output_tokens ?? call.usage.completion_tokens);
    const rates = call.pricing;
    const priced =
      input !== null &&
      output !== null &&
      rates &&
      [rates.inputUsdPerMillion, rates.outputUsdPerMillion].every(
        (rate) => typeof rate === "number" && Number.isFinite(rate) && rate >= 0 && rate <= 1e9,
      );
    for (const row of [total, group]) {
      row.requests++;
      if (call.outcome && call.outcome !== "response") row.failed_requests++;
      row.latency_ms += call.latency_ms;
      row.input_tokens += input ?? 0;
      row.output_tokens += output ?? 0;
      if (input === null || output === null) row.unknown_usage_requests++;
      if (priced)
        row.estimated_cost_usd +=
          (input! * rates.inputUsdPerMillion + output! * rates.outputUsdPerMillion) / 1e6;
      else row.unknown_cost_requests++;
    }
  }
  return { total, by_model: [...groups.values()] };
}

export function formatUsage(usage: ReturnType<typeof summarizeUsage>) {
  const rows = [
    { ...usage.total, label: "Total" },
    ...usage.by_model.map((row) => ({
      ...row,
      label: `${row.role} · ${row.model} · ${row.endpoint ?? "unknown endpoint"}`,
    })),
  ];
  return rows
    .map((row) => {
      const cost = `$${row.estimated_cost_usd.toFixed(6)}`;
      return `${row.label}: ${row.requests} requests (${row.failed_requests} failed), ${row.input_tokens} input / ${row.output_tokens} output reported tokens${row.unknown_usage_requests ? `; usage unknown for ${row.unknown_usage_requests} requests` : ""}; estimated cost ${row.unknown_cost_requests ? `unknown for ${row.unknown_cost_requests} requests (${cost} priced subtotal)` : cost}.`;
    })
    .join("\n");
}

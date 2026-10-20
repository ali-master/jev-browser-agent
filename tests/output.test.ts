import { afterEach, expect, test } from "bun:test";
import { extractOutput, outputCSV, validateSchema } from "../src/output";
import { Agent } from "../src/agent";
import { chatResponse, completionResponse, page, provider } from "./helpers";
const cleanup: (() => unknown)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
const schema = {
  type: "object",
  properties: { price: { type: "number" } },
  required: ["price"],
  additionalProperties: false,
};
const source = {
  url: "https://example.test/",
  title: "Product",
  text: "Price: 20",
};
const valid = {
  data: { price: 20 },
  evidence: [{ path: "/price", url: source.url, quote: "Price: 20" }],
};

test("structured extraction validates types and per-field provenance", async () => {
  const model = provider(() => chatResponse(valid));
  cleanup.push(() => model.server.stop(true));
  const output = await extractOutput(
    schema,
    "Read the price",
    [source],
    async () => model.endpoint,
  );
  expect(output.data).toEqual({ price: 20 });
  expect(output.evidence[0]?.source_hash).toHaveLength(64);
  expect(new Date(output.extracted_at).getTime()).toBeGreaterThan(0);
});
for (const [name, value] of Object.entries({
  "invented source": {
    ...valid,
    evidence: [{ ...valid.evidence[0], url: "https://invented.test/" }],
  },
  "invented quote": {
    ...valid,
    evidence: [{ ...valid.evidence[0], quote: "Price: 5" }],
  },
  "missing evidence": { data: { price: 20 }, evidence: [] },
  "wrong type": { ...valid, data: { price: "20" } },
  "extra field": { ...valid, data: { price: 20, secret: true } },
  "wrong path": {
    ...valid,
    evidence: [{ ...valid.evidence[0], path: "/other" }],
  },
})) {
  test(`rejects ${name} without returning partial output`, async () => {
    let calls = 0;
    const model = provider(() => {
      calls++;
      return chatResponse(value);
    });
    cleanup.push(() => model.server.stop(true));
    await expect(
      extractOutput(
        schema,
        "Read the price",
        [source],
        async () => model.endpoint,
      ),
    ).rejects.toThrow("structured output");
    expect(calls).toBe(2);
  });
}
test("schemas cannot fetch remote references or use asynchronous validation", () => {
  expect(() =>
    validateSchema({ $ref: "https://example.test/schema" }),
  ).toThrow();
  expect(() => validateSchema({ $async: true, type: "object" })).toThrow();
  expect(validateSchema(schema)({ price: "20" })).toBe(false);
});
test("CSV preserves quotes and blocks spreadsheet formula cells", () => {
  expect(
    outputCSV([
      { title: "=SUM(1,2)", price: 20 },
      { title: 'A "book"', price: -2 },
    ]),
  ).toBe('"title","price"\r\n"\'=SUM(1,2)","20"\r\n"A ""book""","-2"');
  expect(outputCSV({ nested: { value: 1 } })).toBeNull();
});
test("Agent only publishes validated structured output after final review", async () => {
  const model = provider(async (request) => {
    const body = await request.json();
    if (body.response_format.json_schema.name === "structured_result")
      return chatResponse(valid);
    if (body.response_format.json_schema.name === "completion_review")
      return completionResponse(body);
    return chatResponse({
      steps: [
        {
          instruction: "Read Price: 20",
          checks: [{ kind: "text", includes: "Price: 20" }],
        },
      ],
    });
  });
  cleanup.push(() => model.server.stop(true));
  const state = { ...page(), ...source };
  const agent = new Agent(
    {
      observe: async () => state,
      fresh: async () => true,
      act: async () => {},
      close: async () => {},
    },
    state,
    "Read Price: 20",
    { settings: async () => model.settings, outputSchema: schema },
  );
  await agent.command("tick");
  expect(agent.state.status).toBe("done");
  expect(agent.state.output?.data).toEqual({ price: 20 });
  expect(
    agent.state.model_calls.some((call) => call.role === "extraction"),
  ).toBe(true);
});

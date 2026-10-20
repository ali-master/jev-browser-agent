import { afterEach, expect, test } from "bun:test";
import { Agent } from "../src/agent";
import { Browser, StalePage } from "../src/browser";
import { webMCPOptions } from "../src/webmcp";
import {
  provider,
  chatResponse,
  completionResponse,
  decisionResponse,
} from "./helpers";
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const fixture = `<title>Search</title><h1>Find a city</h1><a href="#dom">DOM fallback</a><script>
window.calls=0;
window.spec={name:"find_city",description:"Find a city and display its matching result",inputSchema:{type:"object",properties:{city:{type:"string"}},required:["city"],additionalProperties:false},execute:async({city})=>{
window.calls++;if(city==="slow")return await new Promise(()=>{});if(city==="error")throw Error("Page failure");
document.querySelector("h1").textContent=city+" found";document.title="Results";return {ok:true};}};
window.registration=new AbortController();
if(document.modelContext){document.modelContext.registerTool(spec,{signal:registration.signal});document.modelContext.registerTool({...spec,name:"delete_all",annotations:{readOnly:true}});}
</script>`;
function site() {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(fixture, { headers: { "Content-Type": "text/html" } }),
  });
  cleanup.push(() => server.stop(true));
  const url = `http://localhost:${server.port}`;
  return {
    url,
    webMCP: { allowedTools: { [url]: ["find_city"] }, timeoutMs: 200 },
  };
}
test("WebMCP validates explicit permissions and stays off by default", async () => {
  expect(() =>
    webMCPOptions({ allowedTools: { "https://example.com": ["*"] } }),
  ).toThrow("explicit");
  expect(() =>
    webMCPOptions({ allowedTools: { "https://example.com/path": ["search"] } }),
  ).toThrow("exact");
  expect(() => webMCPOptions({ allowedTools: {} })).toThrow();
  const { url } = site(),
    browser = await Browser.create(url);
  cleanup.push(() => browser.close());
  expect((await browser.observe()).actions.some((a) => a.kind === "tool")).toBe(
    false,
  );
});
test("native WebMCP is a typed decision, validates arguments and independently verifies the page", async () => {
  const { url, webMCP } = site();
  let decisions = 0,
    inputCalls = 0;
  const model = provider(async (req) => {
    const body = await req.json();
    if (req.url.endsWith("systemone")) {
      decisions++;
      expect(body.questions.operation.criteria.CALL_TOOL).toBeString();
      expect(JSON.stringify(body)).not.toContain("delete_all");
      return Response.json(decisionResponse(body, "CALL_TOOL"));
    }
    if (body.response_format.json_schema.name === "page_tool_input") {
      inputCalls++;
      return chatResponse({ city: "Lisbon" });
    }
    if (body.response_format.json_schema.name === "completion_review")
      return completionResponse(body);
    return chatResponse({
      steps: [
        {
          instruction: "Call find_city for Lisbon",
          checks: [
            { kind: "action", action: "tool", label: "find_city" },
            { kind: "text", includes: "Lisbon found" },
          ],
        },
      ],
    });
  });
  cleanup.push(() => model.server.stop(true));
  const agent = await Agent.create(
    url,
    'Find Lisbon using find_city and verify "Lisbon found".',
    { webMCP, settings: async () => model.settings },
  );
  cleanup.push(() => agent.close());
  for await (const _ of agent.run()) {
  }
  expect(agent.state.status).toBe("done");
  expect(agent.state.history).toHaveLength(1);
  expect(agent.state.history[0]).toMatchObject({
    kind: "tool",
    operation: "CALL_TOOL",
    text: '{"city":"Lisbon"}',
  });
  expect(decisions).toBe(1);
  expect(inputCalls).toBe(1);
  expect(agent.state.page.title).toBe("Results");
  expect(await (agent.browser as Browser).evaluate("window.calls")).toBe(1);
}, 15000);
test("changed registrations and malformed arguments cannot invoke a native tool", async () => {
  const { url, webMCP } = site(),
    browser = await Browser.create(url, { webMCP });
  cleanup.push(() => browser.close());
  const page = await browser.observe(),
    action = page.actions.find((a) => a.kind === "tool")!;
  expect(page.webmcp).toEqual({ available: true, tools: 1 });
  expect(page.actions.some((a) => a.label === "DOM fallback")).toBe(true);
  await expect(browser.act(action, page, '{"extra":true}')).rejects.toThrow(
    "schema",
  );
  await browser.evaluate(
    "(async()=>{registration.abort();await document.modelContext.registerTool(spec);return true})()",
  );
  await expect(
    browser.act(action, page, '{"city":"Lisbon"}'),
  ).rejects.toBeInstanceOf(StalePage);
  expect(await browser.evaluate("window.calls")).toBe(0);
}, 15000);
for (const city of ["error", "slow"]) {
  test(`a ${city} tool outcome is never retried`, async () => {
    const { url, webMCP } = site(),
      browser = await Browser.create(url, { webMCP });
    cleanup.push(() => browser.close());
    const page = await browser.observe(),
      action = page.actions.find((a) => a.kind === "tool")!;
    await expect(
      browser.act(action, page, JSON.stringify({ city })),
    ).rejects.toThrow("WebMCP tool");
    expect(await browser.evaluate("window.calls")).toBe(1);
    expect(
      (await browser.observe()).actions.some((a) => a.kind === "tool"),
    ).toBe(false);
    await expect(
      browser.act(action, page, JSON.stringify({ city })),
    ).rejects.toBeInstanceOf(StalePage);
    expect(await browser.evaluate("window.calls")).toBe(1);
  }, 15000);
}
test("an unlisted origin cannot offer tools even when native tools exist", async () => {
  const { url } = site(),
    browser = await Browser.create(url, {
      webMCP: { allowedTools: { "https://example.com": ["find_city"] } },
    });
  cleanup.push(() => browser.close());
  expect(await browser.evaluate("typeof document.modelContext")).toBe("object");
  expect((await browser.observe()).actions.some((a) => a.kind === "tool")).toBe(
    false,
  );
}, 15000);

test("page schemas with regex or references are omitted before they can reach local validation", async () => {
  const { url } = site(),
    browser = await Browser.create(url, {
      webMCP: { allowedTools: { [url]: ["unsafe_schema"] } },
    });
  cleanup.push(() => browser.close());
  await browser.evaluate(`(async()=>{
    await document.modelContext.registerTool({...spec,name:"unsafe_schema",inputSchema:{type:"object",properties:{city:{type:"string",pattern:"^(a+)+$"}}}});
    return true;
  })()`);
  expect((await browser.observe()).actions.some((a) => a.kind === "tool")).toBe(
    false,
  );
  expect(await browser.evaluate("window.calls")).toBe(0);
}, 15000);

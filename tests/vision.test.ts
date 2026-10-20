import { afterEach, expect, test } from "bun:test";
import { Browser, StalePage } from "../src/browser";
import { Agent } from "../src/agent";
import { locateVisual } from "../src/vision";
import {
  chatResponse,
  completionResponse,
  decisionResponse,
  provider,
} from "./helpers";
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const canvas = `<style>body{margin:0}</style><canvas width="200" height="100"></canvas><script>
const canvas=document.querySelector('canvas'),ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,200,100);ctx.fillStyle='#000';ctx.fillText('Open result',20,30);
window.clicks=0;canvas.addEventListener('click',e=>{window.clicks+=e.isTrusted?1:100;});
</script>`;
const html = (body: string) =>
  new Response(body, { headers: { "Content-Type": "text/html" } });

test("vision proposes a canvas target but a typed decision and final goal review still control the run", async () => {
  const site = Bun.serve({
    port: 0,
    fetch: (req) =>
      html(
        new URL(req.url).pathname === "/result"
          ? "<title>Result</title><h1>Result reached</h1>"
          : canvas +
              "<script>canvas.addEventListener('click',()=>location.href='/result');</script>",
      ),
  });
  cleanup.push(() => site.stop(true));
  const url = `http://localhost:${site.port}`;
  let vision = 0,
    decisions = 0,
    reviews = 0;
  const model = provider(async (req) => {
    const body = await req.json();
    if (req.url.endsWith("systemone")) {
      decisions++;
      return Response.json(decisionResponse(body, "CLICK"));
    }
    if (body.response_format.json_schema.name === "visual_target") {
      vision++;
      expect(body.messages[1].content[1].image_url.url).toStartWith(
        "data:image/png;base64,",
      );
      return chatResponse({ target: { x: 50, y: 30, label: "Open result" } });
    }
    if (body.response_format.json_schema.name === "completion_review") {
      reviews++;
      return completionResponse(body);
    }
    return chatResponse({
      steps: [
        {
          instruction: `Click Open result to open ${url}/result`,
          checks: [
            { kind: "action", action: "click", label: "Open result" },
            { kind: "url", includes: `${url}/result` },
          ],
        },
      ],
    });
  });
  cleanup.push(() => model.server.stop(true));
  const agent = await Agent.create(
    url,
    `Open ${url}/result using the canvas button.`,
    { vision: true, settings: async () => model.settings },
  );
  cleanup.push(() => agent.close());
  for await (const _ of agent.run()) {
  }
  expect(agent.state.status).toBe("done");
  expect(agent.state.page.url).toBe(`${url}/result`);
  expect(vision).toBe(1);
  expect(decisions).toBe(1);
  expect(reviews).toBe(1);
  expect(agent.state.model_calls.some((c) => c.role === "vision")).toBe(true);
  expect(JSON.stringify(agent.state.decisions)).not.toContain("data:image");
}, 15000);

for (const change of [
  "ctx.fillStyle='red';ctx.fillRect(0,0,200,100);true",
  "const overlay=document.createElement('div');overlay.style.cssText='position:fixed;inset:0;z-index:10';document.body.append(overlay);true",
]) {
  test("a changed or covered visual target never receives stale input", async () => {
    const site = Bun.serve({ port: 0, fetch: () => html(canvas) });
    cleanup.push(() => site.stop(true));
    const browser = await Browser.create(`http://localhost:${site.port}`);
    cleanup.push(() => browser.close());
    let page = await browser.observe();
    const screen = await browser.screen(page);
    page = await browser.bindVisual(
      page,
      { x: 50, y: 30, label: "Open result" },
      screen.hash,
    );
    await browser.evaluate(change);
    await expect(
      browser.act(
        page.actions.find((a) => "visual" in a)!,
        page,
      ),
    ).rejects.toBeInstanceOf(StalePage);
    expect(await browser.evaluate("window.clicks")).toBe(0);
  }, 15000);
}

test("out-of-bounds proposals and non-canvas targets are rejected", async () => {
  const model = provider(() =>
    chatResponse({ target: { x: 1200, y: 0, label: "Bad target" } }),
  );
  cleanup.push(() => model.server.stop(true));
  await expect(
    locateVisual(
      { image: "test", hash: "test", w: 1120, h: 780 },
      "Open",
      model.endpoint,
    ),
  ).rejects.toThrow("outside");
  const site = Bun.serve({
    port: 0,
    fetch: () => html("<button>Normal control</button>"),
  });
  cleanup.push(() => site.stop(true));
  const browser = await Browser.create(`http://localhost:${site.port}`);
  cleanup.push(() => browser.close());
  const page = await browser.observe(),
    screen = await browser.screen(page);
  await expect(
    browser.bindVisual(page, { x: 25, y: 20, label: "Control" }, screen.hash),
  ).rejects.toThrow("canvas");
}, 15000);

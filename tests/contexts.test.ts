import { afterEach, expect, test } from "bun:test";
import { Browser, StalePage } from "../src/browser";
import { actionSpace } from "../src/model";
import { choose } from "../src/model";
import { decisionResponse, page as samplePage, provider } from "./helpers";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const html = (body: string) =>
  new Response(body, { headers: { "Content-Type": "text/html" } });

test("cross-origin frames bind fresh controls, reject overlays, and return to the parent", async () => {
  const child = Bun.serve({
    port: 0,
    fetch: () => html('<label>City <input aria-label="City"></label>'),
  });
  const parent = Bun.serve({
    port: 0,
    fetch: () =>
      html(
        `<h1>Parent</h1><iframe name="Search frame" width="500" height="250" src="http://localhost:${child.port}/"></iframe>`,
      ),
  });
  cleanup.push(
    () => parent.stop(true),
    () => child.stop(true),
  );
  const browser = await Browser.create(`http://127.0.0.1:${parent.port}`);
  cleanup.push(() => browser.close());
  let page = await browser.observe();
  const enter = page.actions.find((a) => a.label.startsWith("Enter frame"))!;
  expect(enter).toBeDefined();
  await browser.act(enter, page);
  page = await browser.observe();
  expect(page.url).toContain(String(child.port));
  const fill = page.actions.find(
    (a) => a.kind === "fill" && a.label === "City",
  )!;
  await browser.act(fill, page, "Berlin");
  expect(await browser.evaluate("document.querySelector('input').value")).toBe(
    "Berlin",
  );
  page = await browser.observe();
  await browser.act(
    page.actions.find((a) => a.label === "Return to parent frame")!,
    page,
  );
  expect((await browser.observe()).text).toContain("Parent");
  page = await browser.observe();
  await browser.act(
    page.actions.find((a) => a.label.startsWith("Enter frame"))!,
    page,
  );
  page = await browser.observe();
  // Cover the target in its parent from a separate owned connection to the frame element.
  await (browser as any).tab.evaluate(() => {
    const e = document.createElement("div");
    e.style.cssText = "position:fixed;inset:0;z-index:100;background:white";
    document.body.append(e);
  });
  await expect(
    browser.act(
      page.actions.find((a) => a.kind === "fill")!,
      page,
      "Paris",
    ),
  ).rejects.toBeInstanceOf(StalePage);
  expect(await browser.evaluate("document.querySelector('input').value")).toBe(
    "Berlin",
  );
}, 15000);

test("open shadow roots support text, fill, native selection and trusted clicks", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      html(`<div id="host"></div><script>
  const root=document.querySelector('#host').attachShadow({mode:'open'});
  root.innerHTML='<h2>Shadow search</h2><label>City<input aria-label="City"></label><select aria-label="Class"><option>Economy</option><option>Business</option></select><button>Search</button>';
  window.clicked=0;root.querySelector('button').onclick=e=>window.clicked+=e.isTrusted?1:100;
  </script>`),
  });
  cleanup.push(() => server.stop(true));
  const browser = await Browser.create(`http://localhost:${server.port}`);
  cleanup.push(() => browser.close());
  let page = await browser.observe();
  expect(page.text).toContain("Shadow search");
  await browser.act(
    page.actions.find((a) => a.kind === "fill")!,
    page,
    "Lisbon",
  );
  page = await browser.observe();
  await browser.act(
    page.actions.find((a) => a.kind === "select")!,
    page,
  );
  page = await browser.observe();
  await browser.act(
    page.actions.find((a) => a.label === "Search")!,
    page,
  );
  expect(await browser.evaluate("window.clicked")).toBe(1);
  expect(
    await browser.evaluate(
      "document.querySelector('#host').shadowRoot.querySelector('input').value",
    ),
  ).toBe("Lisbon");
  expect(
    await browser.evaluate(
      "document.querySelector('#host').shadowRoot.querySelector('select').value",
    ),
  ).toBe("Business");
}, 15000);

test("owned popup tabs can be selected and returned from without using a signed-in context", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (req) =>
      html(
        new URL(req.url).pathname === "/child"
          ? "<title>Result tab</title><h1>Result</h1>"
          : '<title>Parent tab</title><a target="_blank" href="/child">Open result</a>',
      ),
  });
  cleanup.push(() => server.stop(true));
  const browser = await Browser.create(`http://localhost:${server.port}`);
  cleanup.push(() => browser.close());
  let page = await browser.observe();
  await browser.act(
    page.actions.find((a) => a.label === "Open result")!,
    page,
  );
  for (let i = 0; i < 20; i++) {
    page = await browser.observe();
    if (page.actions.some((a) => a.label === "Switch tab: Result tab")) break;
    await Bun.sleep(50);
  }
  await browser.act(
    page.actions.find((a) => a.label === "Switch tab: Result tab")!,
    page,
  );
  page = await browser.observe();
  expect(page.title).toBe("Result tab");
  await browser.act(
    page.actions.find((a) => a.label === "Switch tab: Parent tab")!,
    page,
  );
  expect((await browser.observe()).title).toBe("Parent tab");
}, 15000);

test("nested scroll controls reveal panel content without scrolling the document", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      html(
        '<div aria-label="Results" style="overflow:auto;height:140px;width:400px"><p>First result</p><div style="height:500px"></div><button>Last result</button></div>',
      ),
  });
  cleanup.push(() => server.stop(true));
  const browser = await Browser.create(`http://localhost:${server.port}`);
  cleanup.push(() => browser.close());
  let page = await browser.observe();
  expect(page.actions.some((a) => a.label === "Last result")).toBe(false);
  await browser.act(
    page.actions.find((a) => "scroll_delta" in a && a.scroll_delta! > 0)!,
    page,
  );
  page = await browser.observe();
  expect(page.actions.some((a) => a.label === "Last result")).toBe(true);
  expect(page.scroll.y).toBe(0);
  expect(
    actionSpace(page.actions).elements.some(
      (e) => e.label === "Scroll up in Results",
    ),
  ).toBe(true);
}, 15000);

test("missing field checks still offer observed frame navigation to the decision model", async () => {
  const model = provider(async (request) => {
    const body = await request.json();
    expect(
      body.state.elements.some((e: any) => e.label === "Enter frame: search"),
    ).toBe(true);
    return Response.json(decisionResponse(body, "CLICK", "3"));
  });
  cleanup.push(() => model.server.stop(true));
  const page = samplePage();
  page.actions.push({
    id: "frame",
    node: -1,
    kind: "click",
    role: "button",
    label: "Enter frame: search",
    context_id: "owned",
  });
  const result = await choose(
    page,
    "Enter Berlin in City",
    [],
    model.endpoint,
    false,
    undefined,
    [{ kind: "value", label: "City", equals: "Berlin" }],
  );
  expect(result.choice).toBe("frame");
});

test("popup initialization blocks a forbidden redirect before it reaches the site", async () => {
  let forbidden = 0;
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      if (path === "/forbidden") {
        forbidden++;
        return html("Blocked destination");
      }
      if (path === "/redirect")
        return Response.redirect(new URL("/forbidden", request.url), 302);
      return html(`<button onclick="window.open('/redirect')">Open</button>`);
    },
  });
  cleanup.push(() => server.stop(true));
  const browser = await Browser.create(`http://localhost:${server.port}`, {
    filters: { blockedUrls: [`http://localhost:${server.port}/forbidden`] },
  });
  cleanup.push(() => browser.close());
  const page = await browser.observe();
  await browser.act(
    page.actions.find((a) => a.label === "Open")!,
    page,
  );
  await Bun.sleep(300);
  expect(forbidden).toBe(0);
}, 15000);

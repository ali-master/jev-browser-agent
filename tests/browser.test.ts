import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  spyOn,
  test,
} from "bun:test";
import { chromium, errors } from "playwright";
import type { Browser as PlaywrightBrowser, CDPSession } from "playwright";
import { Browser, StalePage, fingerprint } from "../src/browser";
import type { AgentPointer } from "../src/browser";
import { fixture, page } from "./helpers";
import { fieldContext } from "../src/model";

let server: Bun.Server<undefined>;
let browser: Browser;
beforeAll(() => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () =>
      new Response(fixture, { headers: { "Content-Type": "text/html" } }),
  });
});
afterAll(async () => {
  await server.stop(true);
});
beforeEach(async () => {
  browser = await Browser.create(`http://127.0.0.1:${server.port}`);
});
afterEach(async () => {
  await browser?.close();
});

test("animates real mouse movement before one click even if the pointer viewer throws", async () => {
  await browser.close();
  const pointers: AgentPointer[] = [];
  browser = await Browser.create(`http://127.0.0.1:${server.port}`, {
    showPointer: true,
    onPointer(pointer) {
      pointers.push(pointer);
      throw new Error("Viewer gone");
    },
  });
  await browser.evaluate(
    `window.mouseLog=[];for(const type of ['mousemove','mousedown','mouseup','click']) document.addEventListener(type,e=>window.mouseLog.push({type,x:e.clientX,y:e.clientY,trusted:e.isTrusted}));true`,
  );
  const state = await browser.observe();
  const action = state.actions.find((a) => a.label === "Search hotels")!;
  await browser.act(action, state);
  const log =
    await browser.evaluate<
      { type: string; x: number; y: number; trusted: boolean }[]
    >("window.mouseLog");
  expect(log.filter((e) => e.type === "mousemove").length).toBeGreaterThan(3);
  expect(
    new Set(log.filter((e) => e.type === "mousemove").map((e) => e.x)).size,
  ).toBeGreaterThan(3);
  expect(log.filter((e) => e.type === "click")).toHaveLength(1);
  expect(log.every((e) => e.trusted)).toBe(true);
  expect(await browser.evaluate("window.submits")).toBe(1);
  expect(pointers.at(-1)?.phase).toBe("release");
  expect(pointers.some((p) => p.phase === "press")).toBe(true);
  expect(log.findIndex((e) => e.type === "mousedown")).toBeGreaterThan(3);
});

test("a target moved by hover is reobserved instead of clicking its old coordinates", async () => {
  await browser.close();
  browser = await Browser.create(`http://127.0.0.1:${server.port}`, {
    showPointer: true,
    onPointer() {},
  });
  await browser.evaluate(
    `document.querySelector('#search').addEventListener('mouseenter',e=>{e.target.style.transform='translateY(100px)'},{once:true});true`,
  );
  const state = await browser.observe();
  await expect(
    browser.act(
      state.actions.find((a) => a.label === "Search hotels")!,
      state,
    ),
  ).rejects.toBeInstanceOf(StalePage);
  expect(await browser.evaluate("window.submits")).toBe(0);
}, 15000);

test("covered controls are not offered until their overlay is dismissed", async () => {
  await browser.evaluate(
    `document.body.innerHTML='<button id="under" style="position:fixed;left:20px;top:20px">Search</button><div id="overlay" style="position:fixed;inset:0;background:white;z-index:10"><button id="dismiss">Close menu</button></div>';true`,
  );
  const covered = await browser.observe();
  expect(covered.actions.some((action) => action.label === "Search")).toBe(
    false,
  );
  await browser.act(
    covered.actions.find((action) => action.label === "Close menu")!,
    covered,
  );
  await browser.evaluate("document.querySelector('#overlay').remove();true");
  expect(
    (await browser.observe()).actions.some(
      (action) => action.label === "Search",
    ),
  ).toBe(true);
});

test("observation tolerates a transient missing document body during navigation", async () => {
  await browser.evaluate(
    `document.body.remove();setTimeout(()=>{const body=document.createElement('body');body.innerHTML='<button>Arrived</button>';document.documentElement.appendChild(body)},650);true`,
  );
  const state = await browser.observe();
  expect(state.actions.some((action) => action.label === "Arrived")).toBe(true);
  expect(state.readiness).toBe("ready");
});

test("visible wheel gestures scroll in both directions and report their actual origin", async () => {
  await browser.close();
  const pointers: AgentPointer[] = [];
  browser = await Browser.create(`http://127.0.0.1:${server.port}`, {
    showPointer: true,
    onPointer(p) {
      pointers.push(p);
    },
  });
  await browser.evaluate(
    `document.body.style.minHeight='2500px';window.wheels=[];document.addEventListener('wheel',e=>window.wheels.push({delta:e.deltaY,x:e.clientX,y:e.clientY,trusted:e.isTrusted}));true`,
  );
  let state = await browser.observe();
  await browser.act(
    state.actions.find((a) => a.id === "scroll_down")!,
    state,
  );
  state = await browser.observe();
  expect(state.scroll.y).toBeGreaterThan(400);
  await browser.act(
    state.actions.find((a) => a.id === "scroll_up")!,
    state,
  );
  state = await browser.observe();
  expect(state.scroll.y).toBeLessThan(10);
  const wheels =
    await browser.evaluate<
      { delta: number; x: number; y: number; trusted: boolean }[]
    >("window.wheels");
  expect(wheels.filter((w) => w.delta > 0).length).toBeGreaterThan(1);
  expect(wheels.filter((w) => w.delta < 0).length).toBeGreaterThan(1);
  expect(wheels.every((w) => w.trusted)).toBe(true);
  const gestures = pointers.filter((p) => p.phase === "scroll");
  expect(gestures.map((p) => p.deltaY)).toEqual([560, -560]);
  expect(gestures[0]!.x).toBe(wheels[0]!.x);
  expect(gestures[0]!.y).toBe(wheels[0]!.y);
});

test("document scrolling avoids an embedded canvas that consumes wheel events", async () => {
  await browser.evaluate(
    `document.body.innerHTML='<main style="height:2500px"><h1>Article</h1><canvas style="position:absolute;left:0;top:550px;width:100%;height:400px"></canvas></main>';document.querySelector('canvas').addEventListener('wheel',e=>e.preventDefault(),{passive:false});true`,
  );
  const state = await browser.observe();
  await browser.act(
    state.actions.find((action) => action.id === "scroll_down")!,
    state,
  );
  expect((await browser.observe()).scroll.y).toBeGreaterThan(400);
});

test.each([undefined, false])(
  "pointer visualization is opt-in: showPointer=%j",
  async (showPointer) => {
    await browser.close();
    const pointers: AgentPointer[] = [];
    browser = await Browser.create(`http://127.0.0.1:${server.port}`, {
      showPointer,
      onPointer: (pointer) => pointers.push(pointer),
    });
    await browser.evaluate("document.body.style.minHeight='2500px';true");
    const session = (browser as unknown as { session: CDPSession }).session;
    const send = spyOn(session, "send");
    try {
      let state = await browser.observe();
      await browser.act(
        state.actions.find((a) => a.label === "Search hotels")!,
        state,
      );
      expect(await browser.evaluate("window.submits")).toBe(1);
      state = await browser.observe();
      await browser.act(
        state.actions.find((a) => a.id === "scroll_down")!,
        state,
      );
      expect((await browser.observe()).scroll.y).toBeGreaterThan(400);
      const inputs = send.mock.calls.filter(
        ([method]) => method === "Input.dispatchMouseEvent",
      );
      expect(
        inputs.filter(
          ([, params]) =>
            params && "type" in params && params.type === "mouseMoved",
        ),
      ).toHaveLength(2);
      expect(
        inputs.filter(
          ([, params]) =>
            params && "type" in params && params.type === "mouseWheel",
        ),
      ).toHaveLength(1);
      expect(pointers).toEqual([]);
    } finally {
      send.mockRestore();
    }
  },
);

test("streams actual browser paints and navigation, then detaches without input", async () => {
  const frames: { image: string; url: string }[] = [];
  const stop = await browser.watchFrames((frame) => frames.push(frame));
  const waitForFrame = async (ready: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!ready() && Date.now() < deadline) await Bun.sleep(20);
    expect(ready()).toBe(true);
  };
  await waitForFrame(() => frames.length > 0);
  const first = frames[0]!;
  expect([...Buffer.from(first.image, "base64").subarray(0, 2)]).toEqual([
    255, 216,
  ]);
  await browser.evaluate(
    "location.hash='stream-probe';document.body.style.background='red';true",
  );
  await waitForFrame(() =>
    frames.some(
      (frame) =>
        frame.url.endsWith("#stream-probe") && frame.image !== first.image,
    ),
  );
  await stop();
  const count = frames.length;
  await browser.evaluate("document.body.style.background='blue';true");
  await Bun.sleep(100);
  expect(frames).toHaveLength(count);
  expect(await browser.evaluate("window.submits")).toBe(0);
});

test("observes native controls, types text, selects an observed option and submits once", async () => {
  let state = await browser.observe(true);
  expect(
    state.actions.find((action) => action.label === "Search hotels"),
  ).toMatchObject({ submits_form: true });
  expect(state.screenshot?.length).toBeGreaterThan(100);
  expect(
    state.actions
      .filter((action) => action.kind === "select")
      .map((action) => action.value),
  ).toEqual(["Design"]);
  const city = state.actions.find((action) => action.kind === "fill")!;
  await browser.act(city, state, "Lisbon");
  state = await browser.observe();
  expect(await browser.evaluate("document.querySelector('#city').value")).toBe(
    "Lisbon",
  );
  await browser.act(
    state.actions.find((action) => action.kind === "select")!,
    state,
  );
  state = await browser.observe();
  await browser.act(
    state.actions.find((action) => action.label === "Search hotels")!,
    state,
  );
  await browser.observe();
  expect(
    await browser.evaluate("document.querySelector('#result').textContent"),
  ).toBe("Results: Lisbon / Design");
  expect(await browser.evaluate("window.submits")).toBe(1);
});

test("moving controls use current geometry without requiring another prediction", async () => {
  const state = await browser.observe();
  const action = state.actions.find(
    (action) => action.label === "Search hotels",
  )!;
  await browser.evaluate(
    "document.querySelector('#search').style.transform='translateX(120px)'",
  );
  expect(await browser.fresh(state, action)).toBe(true);
  await browser.act(action, state);
  expect(await browser.evaluate("window.submits")).toBe(1);
});

test.each([
  ["field value", "document.querySelector('#city').value='changed'"],
  ["checkbox", "document.querySelector('#refund').checked=true"],
  ["disabled target", "document.querySelector('#search').disabled=true"],
  [
    "accessible label",
    "document.querySelector('#search').setAttribute('aria-label','Delete all hotels');true",
  ],
  [
    "replaced node",
    "document.querySelector('#search').outerHTML=document.querySelector('#search').outerHTML",
  ],
  [
    "dropdown choice",
    "document.querySelector('#category').options[1].text='Coastal'",
  ],
])("rejects stale %s before input", async (_name, mutation) => {
  const state = await browser.observe();
  const action = state.actions.find(
    (action) => action.label === "Search hotels",
  )!;
  await browser.evaluate(mutation!);
  expect(await browser.fresh(state, action)).toBe(false);
  await expect(browser.act(action, state)).rejects.toBeInstanceOf(StalePage);
  expect(await browser.evaluate("window.submits")).toBe(0);
});

test("a textless overlay invalidates the observation and blocks an old click", async () => {
  const state = await browser.observe();
  const action = state.actions.find(
    (action) => action.label === "Search hotels",
  )!;
  await browser.evaluate(
    "const cover=document.createElement('div');cover.style.cssText='position:fixed;inset:0;z-index:9999;background:white';document.body.append(cover);true",
  );
  expect(await browser.fresh(state)).toBe(false);
  await expect(browser.act(action, state)).rejects.toBeInstanceOf(StalePage);
  expect(await browser.evaluate("window.submits")).toBe(0);
});

test("passwords, hidden fields, disabled controls and offscreen text are excluded", async () => {
  await browser.evaluate(
    `document.body.insertAdjacentHTML('beforeend', '<input type="password" value="never-expose"><input type="hidden" value="hidden-secret"><button disabled>Disabled control</button><p style="position:absolute;top:3000px">Offscreen secret</p>');true`,
  );
  const state = await browser.observe();
  expect(JSON.stringify(state)).not.toContain("never-expose");
  expect(JSON.stringify(state)).not.toContain("hidden-secret");
  expect(state.text).not.toContain("Offscreen secret");
  expect(
    state.actions.some((action) => action.label === "Disabled control"),
  ).toBe(false);
});

test("fill waits for async autocomplete suggestions and navigation invalidates old observations", async () => {
  await browser.evaluate(`document.querySelector('#city').setAttribute('role','combobox');
    document.querySelector('#city').addEventListener('input',()=>setTimeout(()=>{
      document.querySelector('#result').innerHTML='<div role="option">Lisbon suggestion</div>';
    },60));true`);
  const state = await browser.observe();
  await browser.act(
    state.actions.find((action) => action.kind === "fill")!,
    state,
    "Lisbon",
  );
  const after = await browser.observe();
  expect(
    after.actions.some(
      (action) => "role" in action && action.role === "option",
    ),
  ).toBe(true);
  await browser.evaluate("location.href='about:blank';true");
  await Bun.sleep(80);
  expect(await browser.fresh(after)).toBe(false);
});

test("forged actions and invalid text never reach browser input", async () => {
  const state = await browser.observe();
  const action = state.actions.find((item) => item.kind === "fill")!;
  await expect(
    browser.act({ ...action, id: "invented" }, state, "hello"),
  ).rejects.toThrow("observed page");
  await expect(
    browser.act(
      Object.assign({}, action, { extra: undefined }),
      state,
      "hello",
    ),
  ).rejects.toThrow("observed page");
  await expect(
    browser.act(Object.assign(Object.create(null), action), state, "hello"),
  ).rejects.toThrow("observed page");
  await expect(browser.act(action, state, "")).rejects.toThrow("nothing typed");
  expect(await browser.evaluate("document.querySelector('#city').value")).toBe(
    "",
  );
});

test("fingerprints ignore screenshots and geometry, but include node identity and field values", () => {
  const state = page();
  expect(fingerprint(state)).toBe(
    "e20cbb144fa60d6e5190e71656ef9eeaf0adb8864dd8f136067097a5210c02b5",
  );
  const other = structuredClone(state);
  other.screenshot = "new frame";
  if ("node" in other.actions[0]!)
    other.actions[0].rect = { x: 90, y: 20, w: 200, h: 30 };
  expect(fingerprint(other)).toBe(fingerprint(state));
  if ("node" in other.actions[0]!) other.actions[0].value = "new value";
  expect(fingerprint(other)).not.toBe(fingerprint(state));
});

test("an interrupted mutating evaluation is never classified as a safe stale retry", async () => {
  await expect(
    browser.evaluate("throw new Error('interrupted')", true),
  ).rejects.not.toBeInstanceOf(StalePage);
});

test.each([
  [
    '<option selected value="start">Choose</option><option value="1">Single</option><option value="1">Double</option>',
    "Double",
    2,
  ],
  [
    '<option disabled value="1">Unavailable</option><option selected value="start">Choose</option><option value="1">Available</option>',
    "Available",
    2,
  ],
  [
    '<optgroup disabled><option value="1">Unavailable</option></optgroup><option selected value="start">Choose</option><option value="1">Available</option>',
    "Available",
    2,
  ],
])(
  "selects the exact observed option despite duplicate values: %s",
  async (options, label, index) => {
    await browser.evaluate(
      `document.body.innerHTML=${JSON.stringify(`<label>Room<select>${options}</select></label>`)};window.changes=0;document.querySelector('select').onchange=()=>window.changes++;true`,
    );
    const state = await browser.observe();
    const action = state.actions.find(
      (a) => a.kind === "select" && a.label.endsWith(String(label)),
    )!;
    await browser.act(action, state);
    expect(
      await browser.evaluate("document.querySelector('select').selectedIndex"),
    ).toBe(index);
    expect(await browser.evaluate("window.changes")).toBe(1);
  },
);

test.each([
  "s.options[1].disabled=true",
  "s.options[1].value='other'",
  "s.prepend(s.options[1])",
  "s.options[1].outerHTML=s.options[1].outerHTML",
])("rejects changed option identity or eligibility: %s", async (mutation) => {
  const state = await browser.observe();
  const action = state.actions.find((a) => a.kind === "select")!;
  await browser.evaluate(
    `(()=>{const s=document.querySelector('select');${mutation};return true})()`,
  );
  await expect(browser.act(action, state)).rejects.toBeInstanceOf(StalePage);
});

test("same-labeled fields expose distinct document identities and bounded form context", async () => {
  await browser.evaluate(
    `document.body.innerHTML='<fieldset><legend>Sender</legend><label>Name<input id="sender" name="sender"></label></fieldset><fieldset><legend>Recipient</legend><label>Name<input id="recipient" name="recipient"></label></fieldset>';true`,
  );
  const state = await browser.observe();
  const fields = state.actions.filter((a) => a.kind === "fill");
  expect(fields).toHaveLength(2);
  const contexts = fields.map((a) =>
    fieldContext("Sender Alice, recipient Bob", a, state, []),
  );
  expect(contexts[0]!.field.ref).not.toBe(contexts[1]!.field.ref);
  expect(contexts.map((c) => c.field.scope)).toEqual(["Sender", "Recipient"]);
  expect(contexts[1]!.field.html_id).toBe("recipient");
  expect(contexts[1]!.field.context).toContain("Recipient");
  expect(contexts[1]!.field.context.length).toBeLessThanOrEqual(600);
});

test("reading retains seen text across scrolling but drops changed, hidden and navigated content", async () => {
  await browser.evaluate(
    `document.body.innerHTML='<h1 id="title">Observed book</h1><p id="price">Price £14.39</p><p>Historical line</p><div style="height:1100px"></div><p>UPC 123456</p>';true`,
  );
  const initial = await browser.observe();
  expect(initial.read_text).toContain("Observed book");
  expect(initial.read_text).not.toContain("UPC 123456");
  await browser.evaluate("scrollTo(0,document.body.scrollHeight);true");
  const scrolled = await browser.observe();
  expect(scrolled.text).not.toContain("Observed book");
  expect(scrolled.read_text).toContain("Observed book");
  expect(scrolled.read_text).toContain("UPC 123456");
  await browser.evaluate(
    "document.querySelector('#price').textContent='Price £99.99';document.querySelector('#title').hidden=true;true",
  );
  expect(await browser.fresh(scrolled)).toBe(false);
  const changed = await browser.observe();
  expect(changed.read_text).not.toContain("£14.39");
  expect(changed.read_text).not.toContain("£99.99");
  expect(changed.read_text).not.toContain("Observed book");
  expect(changed.read_text).toContain("Historical line");
  await browser.evaluate("history.pushState({},'', '/new-document');true");
  expect((await browser.observe()).read_text).not.toContain("Historical line");
});

test("repeated links include nearby author context without semantic containers", async () => {
  await browser.evaluate(
    `document.body.innerHTML='<div><span>by Jane Austen <a href="/austen">(about)</a></span></div><div><span>by Albert Einstein <a href="/einstein">(about)</a></span></div>';true`,
  );
  const links = (await browser.observe()).actions.filter(
    (a) => a.kind === "click",
  );
  expect(links).toHaveLength(2);
  expect("scope" in links[0]! && links[0].scope).toContain("Jane Austen");
  expect("scope" in links[1]! && links[1].scope).toContain("Albert Einstein");
  expect("href" in links[0]! && links[0].href).toBe(
    `http://127.0.0.1:${server.port}/austen`,
  );
});

test("a section link does not count as reading its offscreen heading or body", async () => {
  await browser.evaluate(
    `document.body.innerHTML='<h1>Observed API</h1><a href="#examples">Examples</a><div style="height:1200px"></div><h2 id="examples"><a href="#examples">Examples</a></h2><p>Map each number to its square.</p>';scrollTo(0,0);true`,
  );
  const before = await browser.observe();
  expect(before.text).toContain("Examples");
  expect(before.read_text).not.toContain("Examples");
  const link = before.actions.find((action) => action.kind === "click");
  expect(link).toBeDefined();
  await browser.act(link!, before);
  const after = await browser.observe();
  expect(after.read_text).toContain("Observed API");
  expect(after.read_text).toContain("Examples");
  expect(after.read_text).toContain("Map each number to its square.");
});

test("section navigation waits for smooth scrolling before verifying the page", async () => {
  await browser.evaluate(
    `document.documentElement.style.scrollBehavior='smooth';document.body.innerHTML='<a href="#facts">Orbit and Rotation</a><div style="height:3500px"></div><h2 id="facts">Orbit and Rotation</h2><p>A day lasts 243 Earth days.</p><div style="height:900px"></div>';true`,
  );
  const before = await browser.observe();
  await browser.act(
    before.actions.find((action) => action.kind === "click")!,
    before,
  );
  const after = await browser.observe();
  expect(after.scroll.y).toBeGreaterThan(3000);
  expect(after.text).toContain("A day lasts 243 Earth days.");
  expect(await browser.fresh(after)).toBe(true);
});

test("clicks custom controls and visible labels of hidden radios without duplicate native targets", async () => {
  await browser.evaluate(
    `document.body.innerHTML='<style>.suggestion{cursor:pointer;width:200px;height:30px}</style><div class="suggestion"><span>Suggestion</span></div><label>Radio label<input type="radio" style="opacity:0;width:0;height:0" id="hidden-radio"></label><button><span>Native button</span></button>';window.picks=0;document.querySelector('.suggestion').addEventListener('click',()=>window.picks++);true`,
  );
  let state = await browser.observe();
  const choices = state.actions.filter((a) => a.kind === "click");
  expect(choices.map((a) => a.label).sort()).toEqual([
    "Native button",
    "Radio label",
    "Suggestion",
  ]);
  await browser.act(
    choices.find((a) => a.label === "Suggestion")!,
    state,
  );
  expect(await browser.evaluate("window.picks")).toBe(1);
  state = await browser.observe();
  await browser.act(
    state.actions.find((a) => a.label === "Radio label")!,
    state,
  );
  state = await browser.observe();
  expect(
    await browser.evaluate("document.querySelector('input').checked"),
  ).toBe(true);
  expect(state.actions.find((a) => a.label === "Radio label")).toMatchObject({
    checked: "true",
    role: "radio",
  });
});

test("hidden radio eligibility is guarded before clicking its label", async () => {
  await browser.evaluate(
    `document.body.innerHTML='<label>Radio<input type="radio" style="opacity:0;width:0;height:0"></label>';true`,
  );
  const state = await browser.observe();
  await browser.evaluate("document.querySelector('input').disabled=true");
  await expect(
    browser.act(
      state.actions.find((a) => a.label === "Radio")!,
      state,
    ),
  ).rejects.toBeInstanceOf(StalePage);
  expect(
    await browser.evaluate("document.querySelector('input').checked"),
  ).toBe(false);
});

test("fills all editable attribute forms and excludes false and nested editor targets", async () => {
  await browser.evaluate(
    `document.body.innerHTML='<div contenteditable aria-label="Bare" style="height:30px"><span contenteditable="true">Nested</span></div><div contenteditable="" aria-label="Empty" style="height:30px"></div><div contenteditable="plaintext-only" aria-label="Plain" style="height:30px"></div><div contenteditable="false" aria-label="False">False</div>';true`,
  );
  let state = await browser.observe();
  expect(
    state.actions.filter((a) => a.kind === "fill").map((a) => a.label),
  ).toEqual(["Bare", "Empty", "Plain"]);
  for (const label of ["Bare", "Empty", "Plain"]) {
    await browser.act(
      state.actions.find((a) => a.kind === "fill" && a.label === label)!,
      state,
      "Updated",
    );
    state = await browser.observe();
    expect(
      state.actions.find((a) => a.kind === "fill" && a.label === label),
    ).toMatchObject({
      value: "Updated",
    });
  }
});

test.each([
  ["date", "2026-11-20", "2026-02-31", "min=2026-11-01 max=2026-12-01"],
  ["time", "10:30", "25:00", "min=09:00 max=17:00"],
  ["datetime-local", "2026-11-20T10:30", "2026-11-20T25:00", ""],
  ["month", "2026-11", "2026-13", ""],
  ["week", "2026-W47", "2026-W99", ""],
  ["range", "6", "7", "min=0 max=10 step=2"],
  ["color", "#123456", "red", ""],
])(
  "sets native %s values and rejects invalid values before input",
  async (type, value, invalid, constraints) => {
    await browser.evaluate(
      `document.body.innerHTML=${JSON.stringify(`<label>Native<input type="${type}" ${constraints}></label>`)};window.events=0;document.querySelector('input').oninput=()=>window.events++;true`,
    );
    let state = await browser.observe();
    let action = state.actions.find((a) => a.kind === "fill")!;
    expect(action).toMatchObject({ input_type: type });
    await browser.act(action, state, value);
    expect(
      await browser.evaluate("document.querySelector('input').value"),
    ).toBe(value);
    expect(await browser.evaluate("window.events")).toBe(1);
    state = await browser.observe();
    action = state.actions.find((a) => a.kind === "fill")!;
    await expect(browser.act(action, state, invalid)).rejects.toThrow(
      "Invalid native input",
    );
    expect(
      await browser.evaluate("document.querySelector('input').value"),
    ).toBe(value);
    expect(await browser.evaluate("window.events")).toBe(1);
  },
);

test("native constraints and readonly changes invalidate the selected input", async () => {
  await browser.evaluate(
    `document.body.innerHTML='<label>Day<input type="date" min="2026-11-01"></label>';true`,
  );
  let state = await browser.observe();
  await browser.evaluate("document.querySelector('input').min='2026-12-01'");
  await expect(
    browser.act(
      state.actions.find((a) => a.kind === "fill")!,
      state,
      "2026-11-20",
    ),
  ).rejects.toBeInstanceOf(StalePage);
  state = await browser.observe();
  await expect(
    browser.act(
      state.actions.find((a) => a.kind === "fill")!,
      state,
      "2026-11-20",
    ),
  ).rejects.toThrow("constraint");
  await browser.evaluate("document.querySelector('input').readOnly=true");
  expect((await browser.observe()).actions.some((a) => a.kind === "fill")).toBe(
    false,
  );
});

test("first observation waits for delayed controls instead of returning an empty action space", async () => {
  await browser.evaluate(
    `document.body.innerHTML='<main>Loading</main>';setTimeout(()=>document.querySelector('main').innerHTML='<button>Ready</button>',250);true`,
  );
  const state = await browser.observe();
  expect(state.readiness).toBe("ready");
  expect(state.actions.some((a) => a.label === "Ready")).toBe(true);
});

test("settling gives delayed menus a bounded chance to appear", async () => {
  await browser.evaluate(
    `document.body.innerHTML='<button id="open">Open</button><main></main>';document.querySelector('button').onclick=()=>setTimeout(()=>document.querySelector('main').innerHTML='<button>Menu choice</button>',350);true`,
  );
  const state = await browser.observe();
  await browser.act(
    state.actions.find((a) => a.label === "Open")!,
    state,
  );
  const immediate = await browser.observe();
  const settled = await browser.settle(immediate);
  expect(settled.actions.some((a) => a.label === "Menu choice")).toBe(true);
});

test("permanently empty and busy pages return bounded readiness metadata", async () => {
  await browser.evaluate(
    `document.body.innerHTML='<main aria-busy="true">Loading</main>';true`,
  );
  const began = performance.now();
  const busy = await browser.observe();
  expect(busy.readiness).toBe("loading");
  expect(performance.now() - began).toBeLessThan(2500);
  await browser.evaluate(
    "document.querySelector('main').removeAttribute('aria-busy');true",
  );
  expect((await browser.observe()).readiness).toBe("empty");
});

test.each(["reject", "hang"])(
  "a screenshot %s preserves DOM and never queues repeated capture",
  async (mode) => {
    const session = (browser as unknown as { session: CDPSession }).session;
    const original = session.send.bind(session);
    let captures = 0;
    const send = spyOn(session, "send").mockImplementation(
      (method: any, params: any) => {
        if (method === "Page.captureScreenshot") {
          captures++;
          return mode === "reject"
            ? Promise.reject(new Error("Screenshot failed"))
            : new Promise(() => {});
        }
        return original(method, params);
      },
    );
    try {
      const state = await browser.observe(true);
      expect(state.actions.some((a) => a.label === "Search hotels")).toBe(true);
      expect(state.screenshot_status).toBe("unavailable");
      expect(state.screenshot).toBeUndefined();
      await browser.observe(true);
      expect(captures).toBe(mode === "hang" ? 1 : 2);
      await browser.act(
        state.actions.find((a) => a.kind === "fill")!,
        state,
        "Lisbon",
      );
      expect(
        await browser.evaluate("document.querySelector('#city').value"),
      ).toBe("Lisbon");
    } finally {
      send.mockRestore();
    }
  },
);

test("tracks custom popup ownership and clears it after confirming the selection", async () => {
  await browser.evaluate(`document.body.innerHTML='<button id="origin" role="combobox" aria-label="Origin" aria-haspopup="dialog" aria-expanded="false">Choose city</button><dialog id="popup" aria-label="Choose origin"><input aria-label="City"><button id="berlin" role="option">Berlin</button></dialog>';
  const origin=document.querySelector('#origin'), popup=document.querySelector('#popup');
  origin.onclick=()=>{origin.setAttribute('aria-expanded','true');popup.showModal()};
  document.querySelector('#berlin').onclick=()=>{origin.textContent='Berlin';origin.setAttribute('aria-label','Origin. Berlin');origin.setAttribute('aria-expanded','false');popup.close()};true`);
  const before = await browser.observe();
  const opener = before.actions.find((a) => a.label === "Origin")!;
  await browser.act(opener, before);
  const opened = await browser.observe();
  const option = opened.actions.find((a) => a.label === "Berlin")!;
  expect("popup_owner" in option && option.popup_owner).toBe(
    "ref" in opener && opener.ref,
  );
  await browser.act(option, opened);
  const after = await browser.observe();
  expect(after.actions.some((a) => "popup_owner" in a && a.popup_owner)).toBe(
    false,
  );
  expect(after.text).toContain("Origin. Berlin");
  expect(after.text).not.toContain("Open Origin");
  expect(after.actions.find((a) => a.label === "Origin. Berlin")).toMatchObject(
    { value: "Berlin", expanded: "false" },
  );
});

test("mouse presses carry the left-button mask required by custom widgets", async () => {
  await browser.evaluate(
    `window.buttonsSeen=[];for(const type of ['mousedown','mouseup']) document.addEventListener(type,e=>window.buttonsSeen.push([type,e.buttons]));true`,
  );
  const state = await browser.observe();
  await browser.act(
    state.actions.find((a) => a.label === "Search hotels")!,
    state,
  );
  expect(await browser.evaluate("window.buttonsSeen")).toEqual([
    ["mousedown", 1],
    ["mouseup", 0],
  ]);
});

test("calendar evidence retains the selected year only after its popup commits a changed value", async () => {
  await browser.evaluate(`document.body.innerHTML='<input aria-label="Departure" id="depart"><dialog id="calendar"><div role="gridcell" aria-selected="false" id="day"><div role="button"><span aria-label="Saturday, October 24, 2026">24</span></div></div><button id="apply">Done</button><button id="cancel">Cancel</button></dialog>';
  const field=document.querySelector('#depart'), dialog=document.querySelector('#calendar'), day=document.querySelector('#day');
  field.onclick=()=>dialog.showModal(); day.onclick=()=>day.setAttribute('aria-selected','true');
  document.querySelector('#apply').onclick=()=>{field.value='Sat, Oct 24';dialog.close()};
  document.querySelector('#cancel').onclick=()=>dialog.close();true`);
  let state = await browser.observe();
  expect(state.actions.find((a) => a.label === "Departure")).not.toHaveProperty(
    "value_date",
  );
  await browser.act(
    state.actions.find((a) => a.label === "Open Departure")!,
    state,
  );
  state = await browser.observe();
  await browser.act(
    state.actions.find((a) => a.label === "Saturday, October 24, 2026")!,
    state,
  );
  state = await browser.observe();
  expect(
    state.actions.find((a) => a.label === "Saturday, October 24, 2026"),
  ).toMatchObject({ role: "gridcell", selected: "true" });
  expect(state.actions.find((a) => a.label === "Departure")).not.toHaveProperty(
    "value_date",
  );
  await browser.act(
    state.actions.find((a) => a.label === "Done")!,
    state,
  );
  state = await browser.observe();
  expect(state.actions.find((a) => a.label === "Departure")).toMatchObject({
    value: "Sat, Oct 24",
    value_date: "2026-10-24",
  });
  await browser.act(
    state.actions.find((a) => a.label === "Open Departure")!,
    state,
  );
  state = await browser.observe();
  await browser.act(
    state.actions.find((a) => a.label === "Cancel")!,
    state,
  );
  state = await browser.observe();
  expect(state.actions.find((a) => a.label === "Departure")).not.toHaveProperty(
    "value_date",
  );
});

test("opening a picker during fill records a click and never types into the new unseen field", async () => {
  await browser.evaluate(`document.body.innerHTML='<input id="date" aria-label="Date"><dialog id="picker"><input aria-label="Date editor" autofocus></dialog>';
  document.querySelector('#date').onclick=()=>document.querySelector('#picker').showModal();true`);
  const before = await browser.observe();
  const field = before.actions.find(
    (a) => a.kind === "fill" && a.label === "Date",
  )!;
  expect(await browser.act(field, before, "2026-10-24")).toBe("popup_opened");
  const after = await browser.observe();
  expect(after.actions.find((a) => a.label === "Date editor")).toMatchObject({
    value: "",
    popup_owner: "ref" in field ? field.ref : undefined,
  });
});

test.each(['async fetchpriority="high"', "defer", ""])(
  "keeps a committed page open while its %s script loads",
  async (attributes) => {
    const script = Promise.withResolvers<Response>();
    const site = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        return new URL(request.url).pathname === "/app.js"
          ? script.promise
          : new Response(
              `<button>Search</button><script ${attributes} src="/app.js"></script>`,
              { headers: { "Content-Type": "text/html" } },
            );
      },
    });
    await browser.close();
    try {
      browser = await Browser.create(`http://127.0.0.1:${site.port}`);
      expect((await browser.observe()).readiness).toBe("loading");
      script.resolve(
        new Response('document.querySelector("button").textContent="Ready"', {
          headers: { "Content-Type": "text/javascript" },
        }),
      );
      expect((await browser.settle(await browser.observe())).readiness).toBe(
        "ready",
      );
      expect((await browser.observe()).text).toContain("Ready");
    } finally {
      script.resolve(new Response(""));
      await browser.close();
      await site.stop(true);
    }
  },
  15000,
);

test("reports the original network failure without closing an unrelated browser", async () => {
  const unavailable = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: () => new Response(""),
  });
  const url = `${unavailable.url}?token=private-test-token`;
  await unavailable.stop(true);
  const launch = chromium.launch.bind(chromium);
  let owned: PlaywrightBrowser | undefined;
  const opening = spyOn(chromium, "launch").mockImplementation(
    async (options) => (owned = await launch(options)),
  );
  try {
    const error = await Browser.create(url).then(
      () => null,
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("net::ERR_CONNECTION_REFUSED");
    expect((error as Error).message).not.toContain("private-test-token");
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(owned?.isConnected()).toBe(false);
    expect((await browser.observe()).readiness).toBe("ready");
  } finally {
    opening.mockRestore();
    await owned?.close();
  }
});

test("preserves navigation timeouts even when cleanup also fails", async () => {
  const owned = await chromium.launch();
  const context = await owned.newContext();
  const page = await context.newPage();
  const cause = new errors.TimeoutError("page.goto: Timeout 30000ms exceeded.");
  const opening = spyOn(chromium, "launch").mockResolvedValue(owned);
  const creating = spyOn(owned, "newContext").mockResolvedValue(context);
  const tab = spyOn(context, "newPage").mockResolvedValue(page);
  const navigation = spyOn(page, "goto").mockRejectedValue(cause);
  const close = context.close.bind(context);
  const closing = spyOn(context, "close").mockImplementation(async () => {
    await close();
    throw new Error("Cleanup failed");
  });
  try {
    const error = await Browser.create(`http://127.0.0.1:${server.port}`).then(
      () => null,
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "did not respond within 30 seconds",
    );
    expect((error as Error).cause).toBe(cause);
    expect(owned.isConnected()).toBe(false);
  } finally {
    for (const spy of [opening, creating, tab, navigation, closing])
      spy.mockRestore();
    await owned.close();
  }
});

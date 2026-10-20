<p align="center">
  <img src="assets/logo.svg" alt="Jev Browser Agent logo" width="128" height="128" />
</p>

# Jev Browser Agent

**A browser agent with a dynamic, indexed action space. Built for Bun.**

Give it a URL and one goal. A typed decision model picks an operation and an observed element. A chat helper turns the goal into a checklist and writes field text when needed. The agent remembers visited pages, adapts to ineffective actions within the run, checks each outcome, and returns a result grounded in observed sources.

A TypeScript rewrite of [Jev Ultrafast](https://github.com/browser-use/jev-ultrafast), with a live browser inspector, observable progress, and switchable local or cloud model connections.

[Try it](#try-it) · [Use the library](#use-the-library) · [Read the loop](src/agent.ts) · [Original project](https://github.com/browser-use/jev-ultrafast)

## The action space

Every observation produces a fresh table of visible controls:

```text
[4] searchbox  Destination        · empty
[5] button     Find stays
[6] combobox   Stay category      · All stays
[7] checkbox   Free cancellation  · unchecked
[8] link       View stay          · Casa Flora
```

The decision model chooses from `CLICK`, `TYPE_TEXT`, `SELECT`, `SCROLL_UP`, `SCROLL_DOWN`, `WAIT`, and `BLOCKED`. Each target question contains only elements compatible with its operation. Dropdown choices include an observed element and option index.

```text
goal → chat helper → completion checklist
                              ↓
                     current unfinished step
                              ↓
                      one /systemone request
                     ┌───────────────────────────┐
page → element table → operation                 │
                     │ click_target              │
                     │ type_text_target          │
                     │ select_target, if present │
                     └─────────────┬─────────────┘
                         use the matching target
                                  │
                   CLICK [7] ─────┤──→ browser
               TYPE_TEXT [4] ─────┘
                         ↓
                  chat helper → text → browser
                                          ↓
                             fresh page → verify checkpoints
                                          ↓
                             all verified → review original goal
                                             ↓
                            missing steps ← review → sourced answer + DONE
```

Operation and target questions share **one logical request**. When an operation has several compatible targets, only its matching target answer can execute. With exactly one compatible target, the runtime binds that observed index in `state.bound_targets` and omits the redundant target question. The model still chooses the operation. Such decisions report `target_source: "single_candidate"` and no model target confidence. The chat helper creates the checklist, generates `TYPE_TEXT` values, revises remaining steps when necessary, and reviews the final result. Transient transport failures can retry a model request.

**Completion requires checkpoints and a goal review.** `DONE` is excluded from the decision model's choices during an Agent run. Field values, checked states, expanded menus, navigation and other page evidence must satisfy the checklist. The final review checks the original goal for omitted requirements and supplies an answer with quotes and URLs from observed pages. Unobserved citations are rejected. A selected action or a high model score does not establish completion.

For reading tasks, each requested section named in a step must have its own check when its section link is observed. Reading one section or the page introduction does not verify another section.

There are no site-specific action scripts or prepared field strings in the policy. Normal model output never becomes a selector, coordinate, shell command, or executable JavaScript. Optional vision coordinates are constrained to a freshly observed canvas/application widget and revalidated before input.

## Try it

Requires **Bun 1.4.3+**. The active project uses Bun for installation, execution, testing and builds.

```sh
git clone https://github.com/ali-master/jev-browser-agent.git
cd jev-browser-agent
bun install --frozen-lockfile
bun run browser:install
cp .env.example .env
bun start
```

Open **[127.0.0.1:8766](http://127.0.0.1:8766)**, expand **Agent settings**, save both connections and use **Check saved connections**. This sends small real requests to test typed choices and structured chat output, including `null`. It checks protocol readiness, not task-solving ability. Choose **Travel planner**, then **Start task**:

> Find a Design stay in Lisbon with Free cancellation and open Casa Flora.

The inspector streams the actual Chromium browser and highlights each selected target before execution. Follow the task checklist, the last observed result, and the **Activity** filmstrip. **Pages visited** lets you review the journey; **Model details** exposes the decision scores.

The agent pointer follows browser mouse movements, pulses on actions, and shows the direction of smooth scrolling. It stays separate from the page DOM and hides while reviewing an old frame. **Preview each action** is off by default; enable it to pause for 1.2 seconds before each action. Pointer animation remains enabled in the demo.

Choose a scenario, review its editable goal, then press **Start task**:

| Scenario                               | What it exercises                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| Travel planner / crowded               | Text input, category and cancellation filters, search, scrolling, result navigation |
| Flights · open search                  | Cookie consent and the Google Flights search page                                   |
| Flights · one-way route                | LHR → LIS, airport suggestions, departure date, one-way results                     |
| Flights · round trip for two           | AMS ↔ FCO, two adults, departure and return dates                                   |
| Flights · nonstop comparison           | JFK → LAX, nonstop filter, compare two visible fares                                |
| Wikipedia · linked research            | Search, read a section, follow a related article, cite both pages                   |
| Hacker News · compare discussions      | Open two discussions, collect visible facts, compare with citations                 |
| GitHub · release research              | Open the latest stable Bun release, read fixes, inspect its source tag              |
| Books to Scrape · compare products     | Open a category, inspect two products, compare prices and stock                     |
| Books to Scrape · catalog pagination   | Scroll to pagination, open page two, inspect a book and its UPC                     |
| Quotes to Scrape · tags and authors    | Filter by a tag, find a named author, read their biography                          |
| Quotes to Scrape · paginated discovery | Open the next page, identify the first author, follow their biography               |
| Open Library · advanced book search    | Fill title and author fields, search, inspect a specific edition                    |
| Gutenberg · find and read a classic    | Search for a book, inspect formats, open the text at Chapter I                      |
| MDN · compare array methods            | Navigate between `map()` and `filter()`, read examples, compare with citations      |
| NASA · compare planet facts            | Visit Mars and Venus facts, find rotation and orbital periods, compare with units   |

**Practice websites** groups the Books to Scrape and Quotes to Scrape tasks. Their controlled catalogs are useful for trying category navigation, pagination, and links before moving to larger sites. Books to Scrape prices are fictional. Every preset fills in an editable goal and opens its own starting URL when you press **Start task**.

Flight dates are generated 45 days after the inspector page loads, with a return seven days later. These are editable task presets, not site-specific automation scripts. Flights stop at results; research tasks do not sign in or post. Live completion depends on the models and the site's current controls. **Your website** accepts a custom URL and goal.

The default mode runs automatically. **Pause** lets the current request finish and prevents the next action. Choose **Step by step** to inspect a decision with **Choose next**, then apply it with **Execute choice**. Saved frames can be reviewed while paused without navigating the controlled browser. Starting another task or restarting the server clears this in-memory history.

Stop the server with **Ctrl+C** in the terminal that started it, including `bun run dev`. On macOS, **⌘C** normally copies text. Shutdown closes the listener and live streams, gives the current step up to three seconds to finish, then closes the browser. A second interrupt forces immediate exit; the CLI also has a five-second shutdown deadline.

Chromium runs in its own isolated context. No Python, `uv`, or Browser Harness is needed. The original Python implementation is available in the [upstream repository](https://github.com/browser-use/jev-ultrafast).

### Connect your models

| Connection     | Endpoint                          | What it does                                                                                                                              |
| -------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Decision model | `POST {baseUrl}/systemone`        | Chooses typed operations and targets; requires a Jev / System One compatible decision model                                               |
| Chat helper    | `POST {baseUrl}/chat/completions` | Creates/revises the checklist, field text and final review; requires an OpenAI-compatible chat model with `json_schema` structured output |

Both models are needed for every task, including tasks that do not type. A regular chat model cannot replace a System One decision model. The two connections can share an LM Studio server or use separate local and cloud providers.

Configure them in **Agent settings** or edit `.env`:

```dotenv
TYPESAFE_BASE_URL=http://127.0.0.1:1234/v1
TYPESAFE_API_KEY=
TYPESAFE_MODEL=your-loaded-decision-model

TEXT_MODEL_BASE_URL=http://127.0.0.1:1234/v1
TEXT_MODEL_API_KEY=
TEXT_MODEL=your-loaded-chat-model
```

Use the **base URL**, including `/v1` when required, without `/systemone` or `/chat/completions`. Local servers may accept empty keys. For cloud connections, set the provider's HTTPS base URL, API key and model identifier independently for each role. The application sends explicit JSON schemas for chat requests and validates the returned values. Nullable strings use `anyOf` for compatibility with local schema parsers.

Settings are read **before every model step and schema-repair request**, in this order. Transport retries keep that request's connection and payload:

```text
.jev/settings.json → .env → process environment
     highest priority
```

Saving in the inspector writes `.jev/settings.json` with owner-only permissions. Edit those settings to switch providers without restarting; remove the file to return to environment configuration. An empty key field preserves a saved credential. **Clear saved API key** removes it. Changing a Base URL clears its previous key unless a replacement is supplied. Saved keys are never returned to the frontend, and model request redirects are refused.

<details>
<summary>LM Studio: model selection and physical batch size</summary>

Load a decision model for `/systemone` and a chat model for `/chat/completions`. Enter each loaded model's exact identifier in the corresponding settings. Changing the selection in LM Studio does not update the model identifier sent by this client.

For Clef and D1 Omni, the entire decision prompt must fit in the physical batch. Under **Load → Advanced**, set **Evaluation Batch Size** and **Physical Batch Size** to **4096**, then reload the model. This fits the bundled travel fixture's initial request. Larger pages and longer histories can require a larger batch; increasing context length alone does not solve that limit.

API compatibility is separate from planning quality. A chat model can return valid JSON while choosing the wrong field or omitting part of the goal. Review its generated checklist and use the bundled demo to evaluate a model before giving it a larger task.

If the inspector reports **“Chat helper could not produce a verifiable checklist”**, it rejected the plan and its bounded repair attempts. A repeated validation failure stops after two calls; fixing one error and exposing another allows a third call. The message includes the last validation failure, such as an empty field value, a mismatched control reference, invalid JSON or an output token limit. No action is executed for that rejected plan. Check the **Chat helper** model in **Agent settings**: **Test connection** checks API compatibility, not the model's ability to plan a task. A model that repeatedly returns incorrect checks needs to be replaced with a more capable chat model; increasing the decision model's physical batch size does not correct those checks.

</details>

## Use the library

Install `@usex/jev-browser-agent` in your Bun project, then install Chromium:

```sh
bun add @usex/jev-browser-agent
bunx --bun --no-install playwright install chromium
```

Add both model connections to a `.env` file in your application's working directory as shown in [Connect your models](#connect-your-models). Save the following as `agent.ts`:

```ts
import { Agent } from "@usex/jev-browser-agent";

await using agent = await Agent.create(
  "https://en.wikipedia.org/wiki/Main_Page",
  "Find and open the article about Gödel’s incompleteness theorems.",
);

for await (const state of agent.run()) {
  console.log(state.elapsed_ms, state.status, state.page.url);
}

console.log(agent.state.checkpoints);
console.log(agent.state.answer);
console.log(agent.snapshot().memory);
console.log(agent.snapshot().usage);
```

Run it from your application directory:

```sh
bun run agent.ts
```

`Agent.create` reads the same model settings as the inspector. `await using` closes the owned browser context when execution leaves the scope. Library callers can provide a `settings` callback, `cdpUrl`, `maxSteps`, or `recordDir` through the third argument.

`showPointer` defaults to `false` in both `AgentOptions` and `BrowserOptions`. Set `showPointer: true` together with an `onPointer` callback to animate the pointer in your own viewer. When disabled, pointer events and animation delays are skipped; clicks and scrolling still work. The demo inspector explicitly enables this option.

Install the `jev` CLI globally with Bun:

```sh
bun add --global @usex/jev-browser-agent
```

Run a browser task:

```sh
jev run \
  --url https://en.wikipedia.org/wiki/Main_Page \
  --goal 'Find and open the article about Gödel’s incompleteness theorems.' \
  --headed --max-steps 20 --record artifacts/research
```

Omit `--headed` to run headlessly. `--record` saves state and screenshots for inspection. `BROWSER_CDP_URL` connects the CLI and inspector to an existing Chromium CDP endpoint, while still creating a separate context; it does not use your signed-in profile.

To open the inspector:

```sh
jev serve --port 8766
```

Use `--port` or the `PORT` environment variable to change its port.

CLI logs go to stderr; the final answer goes to stdout, so they can be saved separately:

```sh
jev run --url https://en.wikipedia.org/wiki/Main_Page \
  --goal 'Find and open the article about Gödel’s incompleteness theorems.' \
  --log-level debug --log-detail high --color never \
  > answer.txt 2> agent.log
```

The same flags work with `jev serve`; tasks started in the inspector emit their stages and timing summaries to the server's terminal.

`--log-level` accepts `error`, `warn`, `info` (default), `debug`, or `trace`. `--log-detail` accepts `low` for start/result summaries, `normal` (default) for stages and actions, or `high` for individual stage timings and token counts. Detail does not override the level filter; use `trace` with `high` for all diagnostics. Warnings and errors remain visible at low detail.

`--color auto|always|never` defaults to `auto`. Auto detects a terminal and respects `NO_COLOR`, `FORCE_COLOR`, and `TERM=dumb`; an explicit flag wins. Logs include page changes, model latency, decisions, executed actions, checkpoint progress, stop reasons, and total model versus remaining elapsed time. Raw prompts, field values, API keys and URL queries are not included by the reporter. Debug adds usage and timing summaries; trace adds token counts. Page labels and error messages can still contain site content, so treat saved logs as private.

## Reusable workflows

Give a successful task a local name and parameterize repeated values in its goal:

```ts
await using agent = await Agent.create("https://example.com/search", "Search for {{city}}.", {
  workflow: { name: "city-search", parameters: { city: "Lisbon" } },
});
for await (const state of agent.run()) console.log(state.workflow);
```

The CLI accepts `--workflow city-search --params '{"city":"Lisbon"}'`; the inspector exposes the same fields under **Run options**. Use `{{city}}` in the goal and change its supplied value for the next run.

Only a run that passes the final goal review saves a recipe, in `.jev/workflows/` with private file permissions. Planning and final verification still run. Intermediate decisions can reuse an action only when its normalized page state, checklist step and unique semantic target match. Current node references and browser freshness guards are always used. A changed precondition or unexpected result disables replay for that run and returns to normal decisions. `state.workflow` reports hits, misses and whether the recipe was saved.

Recipes contain instructions and typed values, so keep them private. This is conservative reuse, not generalization to a changed website; dynamic content can cause a safe cache miss. Library callers can set `workflow.directory`.

## Model evaluation

The inspector's **Model lab** runs three local scenarios in fresh browser contexts, with 1–5 repetitions. Name the current model pair, run it, then change model settings and run again. The last eight reports remain available during the server session. Export them as JSON before restarting.

Passing requires both Agent completion and independent, caller-authored final-page assertions. A model saying “done” cannot pass a failed assertion. Reports include the failure stage, action count, wall/model time, reported tokens, estimated cost when configured, and p50/p95 across all runs. Unknown token usage and pricing remain explicitly unknown; these are measurements of your runs, not universal model rankings.

For custom cases, save a JSON array:

```json
[{
  "id": "article",
  "url": "https://en.wikipedia.org/wiki/Main_Page",
  "goal": "Find and open the article about Ada Lovelace.",
  "assertions": [{"kind": "title", "includes": "Ada Lovelace"}]
}]
```

```sh
jev eval --suite cases.json --label local-pair --repeat 3 --report results.json
```

Assertions support `title`, `url`, `text` with `includes`, or `value`, `checked`, `expanded` with a control `label` and `equals`. Supply expectations yourself; weak assertions make weak evaluations. Reports exclude raw pages and prompts. Do not place credentials in case IDs or labels.

For multiple configurations in one run, use `evaluateSuite(cases, [{ name: "small", settings: smallSettingsReader }, { name: "large", settings: largeSettingsReader }], { repeat: 3 })` from `@usex/jev-browser-agent`. Runs are sequential, isolated and use the normal Agent path, without saved login profiles or workflow replay. Stop closes the active browser immediately; an in-flight model request can still take its configured timeout to settle.

## Structured results

Pass `outputSchema` to `Agent.create` to extract typed data after the goal review:

```ts
const options = {
  outputSchema: {
    type: "object",
    properties: { title: { type: "string" }, price: { type: "number" } },
    required: ["title", "price"],
    additionalProperties: false,
  },
};
```

The result is `agent.state.output`: `{ data, evidence, extracted_at }`. Every leaf has a JSON Pointer, source URL, exact quote and source hash. Missing/duplicate citations, invented quotes, schema mismatches and truncated responses fail extraction after one repair attempt; the run cannot claim completion with invalid structured data. Quotes prove that a source was observed; whether a quote supports a derived value still depends on the model.

Use `jev run ... --schema output.schema.json` to print the structured result as JSON. In the inspector, paste the schema under **Run options**, then expand **Structured data & field evidence** and use **Copy JSON** or **Copy CSV**. CSV is available for a flat object or array of flat objects; `outputCSV(data)` is also exported by the library. String cells that could be spreadsheet formulas are escaped.

Schemas use JSON Schema draft-07, validated with [Ajv](https://ajv.js.org/guide/getting-started.html), without type coercion, remote references or async validators. Schemas are limited to 64 KB and 32 levels. Format annotations are not validated. Extraction uses the current chat helper, sends only retained observations, and reports its own token usage under `extraction`.

## Login profiles and secrets

Create an isolated login profile manually, including any MFA challenge:

```sh
jev login --url https://example.com --profile research
# Sign in in the opened Chromium window, then press Enter in the terminal.
jev run --url https://example.com --profile research --goal 'Read my saved items.'
```

`profile: { name: "research" }` is also an `AgentOptions` / `BrowserOptions` setting, and the inspector has a **Login profile** field. Cookies, localStorage and IndexedDB are restored into a new owned context and saved on close. They never import your normal Chrome profile. Ctrl+C during manual login cancels saving. SessionStorage is not persisted.

Files under `.jev/profiles/` are AES-GCM encrypted, written atomically with `0600` permissions. The key lives in the OS credential store through [Bun.secrets](https://bun.sh/docs/runtime/secrets). Headless environments may provide `JEV_PROFILE_KEY`, a 32-byte base64 key. Missing/wrong keys fail closed and leave the existing file intact. Keep the same profile path and key when restoring a backup.

Profiles default to the starting origin. For SSO, pass an explicit `profile.origins` array, or repeat `--allow-origin` during login and subsequent runs. Reopening a profile with a different scope is rejected. Unrelated storage is discarded; parent-domain cookies are narrowed to the approved exact host. Cookies follow browser host/scheme rules and cannot isolate ports.

For automated field entry, supply named secrets separately from the goal:

```ts
const options = {
  secrets: {
    password: {
      value: process.env.SITE_PASSWORD!,
      origin: "https://example.com",
      label: "Password",
    },
  },
};
// Goal: "Enter {{secret:password}} in Password, then sign in."
```

The CLI accepts `--secrets private-secrets.json`; the inspector accepts the same JSON in its masked **Secrets JSON** input and clears it after starting. Secret values stay out of saved settings. Only the configured exact origin and field label can receive the value, and the goal must explicitly name its placeholder. Password inputs remain excluded unless bound this way.

Prompts, history and traces use placeholders; changed password contents still invalidate an old decision. Screenshots, live images, pointer events and workflow recording/replay are disabled for runs containing secrets. Literal values are redacted from observed text too; arbitrary encodings or transformations performed by a site cannot be recognized as secrets. Give credentials only to sites you trust.

## Optional visual fallback

Set `vision: true`, pass `--vision`, or enable **Visual fallback for canvas** under inspector Run options. It defaults off. The current chat helper must support OpenAI-compatible image input; library callers can provide a separate `vision: { endpoint }`.

When no DOM targets are available, or the decision model returns `BLOCKED`, the helper may propose one canvas/application-widget target. The runtime validates its pixel bounds, binds it to the actual widget and offers it to the ordinary typed decision model. The proposal alone does not execute a click. Each action step has a bounded fallback attempt, and its physical model usage appears under `vision`.

Vision sends the current viewport image to the configured helper. Coordinates never become arbitrary page input: the widget identity, parent frames, exact hit point and PNG hash are checked again before clicking. Changed/covered targets are rejected. This conservative implementation supports stable canvas click targets; animations and hover redraws can cause safe rejection. It does not implement visual typing or certify canvas-only final answers. Normal page checkpoints and final review still govern completion. Vision and secret-enabled runs cannot be combined.

## WebMCP tools alongside DOM actions

Opt in to page-provided tools with exact origin and tool-name permissions:

```ts
import { Agent } from "@usex/jev-browser-agent";

const agent = await Agent.create("https://example.com/search", "Find Lisbon and show its results.", {
  webMCP: {
    allowedTools: { "https://example.com": ["search"] },
    timeoutMs: 10_000,
  },
});
for await (const state of agent.run()) console.log(state.history.at(-1));
await agent.close();
```

Use `--webmcp permissions.json` in the CLI, or paste the same options object in **Run options → WebMCP** in the inspector. Blank leaves it disabled. Only explicitly named tools are offered through typed `CALL_TOOL` decisions. The chat helper generates arguments against the observed input schema; local validation runs before the native invocation. Arguments and the operation appear in the activity trail. DOM actions remain available.

The browser checks page freshness and registration changes before invocation. A tool is invoked once; timeout, cancellation or error stops the run and disables further tool invocation in that context. Cancellation cannot guarantee that a site's side effect was undone. A successful response is not proof of completion: normal page checkpoints and final goal review still run. Raw tool responses are not used as instructions or completion evidence.

This is experimental [WebMCP](https://webmachinelearning.github.io/webmcp/), tested with Chromium 156's native CDP domain, not a polyfill. Jev launches Chromium with `--enable-features=WebMCP,WebMCPTesting,DevToolsWebMCPSupport` when enabled. An external CDP browser needs those flags itself. Only tools in the active top-level page are supported; child frames continue through DOM controls. A tool must expose an object input schema supported by the local validator and produce an observable page result. Unsupported schemas are omitted. Secret bindings and workflow replay cannot be combined with WebMCP.

Tool input schemas are limited to 8 KB and 16 nesting levels; references and regular expressions are rejected to keep page-owned validation bounded. Allow only trusted sites and tools: page descriptions and `readOnly` annotations are claims, not enforced guarantees. Names and schemas do not prove a tool's actual effects. Native registration/execution is not an atomic version-lock API, so a site can still replace its implementation during dispatch; do not grant consequential tools based on their descriptions alone.

## Page filters

Expand **Agent settings** in the inspector to enable **Block ad requests**, add **Blocked URLs**, or choose CSS selectors under **Remove elements**. All three are off or empty by default. Saved filters live in `.jev/settings.json` alongside the model connections and are used by the inspector, CLI and library. Changes apply to the **next task**; an active run keeps the filters it started with.

Library callers can supply `filters` in the third argument to `Agent.create` or the second argument to `Browser.create`:

```ts
import { Agent } from "@usex/jev-browser-agent";

await using agent = await Agent.create(
  "https://example.com/catalog",
  "Compare two products and report their prices.",
  {
    filters: {
      blockAds: true,
      blockedUrls: ["*://ads.example.com/*", "https://example.com/checkout*"],
      removeSelectors: [".advertisement", "aside.sponsored", "video"],
    },
  },
);

for await (const state of agent.run()) {
  console.log(state.status, state.page.url);
}
```

An explicit `filters: {}` disables saved filters for that run. A supplied `filters` object replaces the saved filter configuration rather than merging it.

- **Ad requests:** uses [Ghostery's filtering engine](https://github.com/ghostery/adblocker) with [EasyList](https://easylist.to/). The list downloads on first use and is reused in memory for that process. An unavailable list stops startup with an actionable error; it does not silently run without blocking. No browsing content is sent to the list provider. Only network rules are used; cosmetic rules and scriptlet injection are disabled.
- **Blocked URLs:** absolute HTTP(S) [URLPattern](https://developer.mozilla.org/en-US/docs/Web/API/URLPattern) strings such as `*://ads.example.com/*`. Matching is separated by URL component: a blocked host mentioned inside an unrelated URL's query does not block that unrelated URL. Every matching HTTP request and redirect in the controlled tab is stopped before delivery; matching links are also removed from the Agent's choices. A blocked starting URL is rejected before Chromium opens.
- **Remove elements:** tag names and CSS selectors, one per line. Matching elements are removed from the main document immediately before every observation, including after navigation and dynamic updates. The document's `html`, `head`, and `body` roots are retained. Removing scripts does not undo executed code or prevent their earlier downloads; use network rules to prevent requests.

Filtering applies to tabs in the Agent's owned context, not other browser windows. Popup requests wait for filters to initialize. It is not a network firewall. Service workers are disabled in the isolated context while network filtering is enabled. Cleanup traverses open shadow roots and runs in each frame when that frame is observed. Removing forms or required scripts can break a task; choose selectors that preserve the content and controls it needs.

## Frames, tabs and panels

Visible child frames appear as **Enter frame** controls. The agent can inspect same-origin or cross-origin frames, act on their controls, then choose **Return to parent frame**. New tabs opened by the page appear as **Switch tab** controls. Only tabs in the run's owned browser context are offered. These controls use the existing typed `CLICK` choice; they never accept a model-generated frame ID or URL.

Open Shadow DOM controls participate in ordinary observation, field input and native selection. Scrollable panels expose **Scroll up/down in …** controls, which dispatch a wheel gesture inside the selected panel. Main-document scrolling still uses `SCROLL_UP` / `SCROLL_DOWN`.

Frame input maps local geometry to the tab viewport and hit-tests the exact point through every ancestor. A detached, covered, clipped or transformed frame stops input until a fresh observation. Closed shadow roots and transformed frames are unsupported; the agent does not pierce them. Frame context switches and panel scrolling are visible in the normal activity trail and action budget.

## Why it moves

- **Ask only necessary questions.** One request chooses the operation and any ambiguous target. A single compatible target needs no separate model question; freshness and execution checks still apply.
- **DOM first.** Normal decisions receive visible controls and page text. Images reach a model only when the optional visual fallback is enabled and needed.
- **One browser call per snapshot.** Read controls, names, values and visible text together, retaining references to the observed DOM nodes.
- **Validate before input.** Recheck the document, field values and target context. Resolve current geometry and reject covered controls before acting.
- **Bind identities.** Decisions retain their original observation; fields carry document/node references and nearby form context. Dropdowns select the exact observed option even when values are duplicated.
- **Verify after input.** Log confirmed actions before observing their results. Completed visible fields are rechecked; a regression reopens the affected checkpoint.
- **Reuse text carefully.** An interrupted text result is reused only when the entire helper input and connection settings are unchanged.
- **Skip redundant generation.** A uniquely bound field can reuse an exact value already present in the user's goal and active checklist. Passwords, ambiguous bindings, and inferred values still use the helper. Browser freshness and input validation still run.
- **Send evidence once.** Final reviews deduplicate identical sources and avoid repeating their text inside checkpoint metadata; distinct observations and ordered checks remain available.
- **Keep replanning compact.** Completed steps retain their checks and verification metadata without resending full saved page text or model traces. Target criteria reference the control table instead of repeating its properties. Run memory is assembled locally, without summarization requests.
- **Continue partial plans before review.** When only a checklist prefix is valid, finish that prefix and return its validation error to the planner. The original goal still needs a complete plan and final verification; partial progress does not trigger an expensive final review.

To diagnose speed, run the CLI with `--log-level debug --log-detail high`: stage timings separate observation, planning, decisions, writing, input and final verification. `model_ms` sums physical model requests; `other_ms` is the remaining run time, including browser work and any pauses. These totals exclude initial browser startup. Recording adds screenshots and disk writes; use `--record` when you need that evidence.

Only observations and model requests are retried. Browser mutations are never replayed after an uncertain error. Default limits are 60 browser actions and 120 decision cycles. Three unchanged actions stop the loop; three consecutive unchanged waits trigger a bounded page recheck and, on a ready page, a repair of the remaining checklist. WAIT is then removed from an unchanged ready page's choices. Checklist revisions share a two-revision budget; waiting never counts as completion. Transport retries allow at most three attempts for known transient failures. Invalid chat output gets one schema repair; checklist planning allows a third attempt only when the repair changed the validation error. A missing field value (`text: null`) stops with a clear reason and never types an invented value.

Loading/empty observations and a proposed `BLOCKED` state receive a bounded wait of about one second. Snapshot failure can recover the observation of a consumed action, without executing it again. Screenshot capture has its own one-second deadline; a missing image does not discard the DOM observation. Incomplete coverage and loading are distinguished from an unsupported step in `stop_reason`.

Navigating documents get up to 30 observation attempts, spaced 100 ms apart. Section links wait for smooth scrolling to settle, with a two-second ceiling. The pointer rechecks the target after moving because hover can cover, move or replace a control. Previously verified controls retain their evidence when scrolling or SPA navigation hides them; a visible changed value still reopens the affected steps.

After reaching an unexpected page, the helper can revise the remaining steps while preserving completed evidence. At most two revisions and three final goal reviews are allowed between browser inputs that change the observed state. A final review that finds missing requirements adds those steps within the same budget. If its remaining checklist is still invalid after schema repair, the checklist planner gets one bounded recovery attempt; this cannot certify completion. Otherwise the run stops without claiming completion.

## Memory within a run

Memory is enabled for every `Agent`, including the CLI and inspector. Decisions, replanning and field-text requests receive a compact record of earlier pages, verified steps and confirmed actions that produced no visible change. This helps a multi-page task continue from what it already read instead of revisiting completed work.

- **Pages:** retain up to 12 visited URLs, with up to 16,000 characters of actually read text per page. Revisiting a URL refreshes its position and saved content. The working context includes the last four other pages, with excerpts limited to 1,200 characters each, and the last eight verified step summaries.
- **Feedback:** retain up to 12 ineffective-action records and send the last six. After two confirmed clicks, selections or scrolls with no visible change in the same document and observation, that action is removed from the offered choices. The restriction does not apply to a different observation or document. Text fields remain available for a corrected value; waiting and uncertain execution errors do not teach an action ban.
- **Verification:** excerpts describe earlier observations, never current control identities or proof that the goal is complete. Final review uses the retained source text and checkpoint evidence. Missing evidence must be revisited; the agent cannot fill it in from a summary.

Inspect `agent.snapshot().memory.pages`, `.completed` and `.lessons`, or the exported trace. Each lesson includes its action, attempt count, last action number and whether it currently excludes a choice. The decision request in **What the model sees** includes the same working memory.

This is feedback within one run, not model training. A new `Agent` starts with empty memory; lessons are not shared between users or automatically loaded from previous recordings. `--record` saves the memory with the trace for inspection, not automatic reuse.

Checklist feedback is retained in `plan_revisions`: the next planning request receives the rejected remainder's validation error and the verified prefix. The same revision budget prevents a helper from endlessly proposing already completed work.

## Run usage and cost

The inspector's **Model usage** panel, CLI summary, `agent.snapshot().usage`, and exported trace include every physical model request. Planning, decisions, field text, final verification, retries and response repairs are grouped by role, model and provider. Connection checks are separate probes and are excluded from run totals. Failed-request counts describe transport/provider failures; a successful HTTP response can still fail schema or goal validation.

Usage accepts `prompt_tokens` / `completion_tokens` and `input_tokens` / `output_tokens`. Totals show the reported token subtotal and the number of requests with missing or invalid usage. A provider that returns only `total_tokens` cannot supply a reliable input/output breakdown.

Enter optional input and output prices in **Agent settings**, in **USD per million tokens**. Library connections accept the same optional field:

```ts
pricing: { inputUsdPerMillion: 0.5, outputUsdPerMillion: 1.5 }
```

These numbers are an example, not provider prices. Each request captures its configured rates. A request with 1,000 reported input tokens and 100 output tokens at those example rates estimates `(1000 × 0.5 + 100 × 1.5) / 1_000_000 = $0.00065`. Changing the model or Base URL clears inherited rates unless replacement rates are supplied. Leave both prices blank for **unknown**; enter explicit zeroes only when that is the intended rate.

`estimated_cost_usd` is the **priced subtotal**. Any nonzero `unknown_cost_requests` means the full run cost is unknown. Missing usage is never treated as free, including failed attempts. This is an estimate at your supplied rates, not an invoice: provider caching discounts, additional charges, taxes and local hardware costs are excluded.

## Evidence and limits

Tests exercise local browser fixtures and mock model endpoints. They independently check field values, exact dropdown selections, submission counts and multi-page waypoint order, along with model protocols, stale-page handling and premature-completion guards. A browser regression test takes an ineffective route twice, switches to a valid route, and answers from two earlier pages. Tests also cover memory limits, isolation, restriction expiry, single-target binding, compact replanning and invented answer citations. These checks validate the application; they do not measure a real model's reasoning quality.

**Goal coverage and answer interpretation still depend on the chat model.** Deterministic checks validate control identities, check types and observed citations. The separate final review reduces missed requirements but cannot prove semantic completeness for an arbitrary goal or an unseen server-side effect. Reading retains up to 16,000 characters from reached viewports, removes changed or hidden text, and preserves the last 12 visited pages for sourced comparisons. Checkpoints retain their own observed evidence. Unseen content is never read from below the viewport. A valid model action can still be the wrong action.

The DOM reader handles common HTML/ARIA controls, native date/time/range/color fields, editable variants, labels for hidden checkbox/radio controls, and bounded discovery of custom click targets. Discovery scans at most 5,000 extra DOM nodes and reports truncation; at most 100 open shadow roots are traversed. Native values are checked against type, min/max and step constraints before input. Canvas, uploads and arbitrary keyboard widgets remain outside the DOM reader; the optional visual fallback handles stable canvas clicks. Password inputs require an explicitly scoped secret binding; file inputs remain excluded. Duplicate labels need matching references or scope to verify. Workflows that deliberately replace earlier requested values need a narrower goal.

The inspector binds to `127.0.0.1` and checks Host, Origin and a per-process request token. Exported traces and screenshots can contain page content and generated field values. Keep them private; `.env`, `.jev/` and `artifacts/` are ignored by Git.

The timings and demo videos in the original Jev Ultrafast README describe its Python implementation. They are **not benchmarks for this Bun port**.

## Development

```sh
bun run check          # TypeScript, tests and build
bun run typecheck      # Bun's built-in checker (bun --check)
bun run format:check   # Source formatting
bun run test:browser   # Browser and HTTP integration tests
bun run dev            # Inspector with Bun's watcher

bun dist/cli.js --help # Built CLI
```

Install Chromium with `bun run browser:install` before running browser tests. Tests use local fixtures and mock model servers; they do not need API keys or call paid providers. Dependencies are pinned in [`package.json`](package.json) and [`bun.lock`](bun.lock).

[Bun 1.4.3](https://bun.sh/blog/bun-v1.4.3) checks types before tests and bundling. The `typecheck` script uses `bun --check` to avoid the project's `check` script taking precedence over `bun check`. TypeScript remains installed to emit `.d.ts` files; Bun's checker does not emit declarations. Internal module imports omit file extensions.

Page fingerprints use `Bun.CryptoHasher`, file reads use `Bun.file`, and build assets use `Bun.Glob` and `Bun.write`. Static inspector files stream through `Bun.serve`, including conditional range requests. Loopback model requests bypass proxy environment variables; cloud requests honor them.

Node-compatible imports remain where they preserve required behavior: argument and `.env` parsing, path/directory operations, atomic private settings writes, and prototype-sensitive action validation. Bun's strict deep comparison accepts null-prototype copies, and `Bun.write` did not preserve `0600` for string input on the tested macOS Bun 1.4.3 runtime. These boundaries retain their existing implementations and regression tests.

## Credits

Based on [Browser Use's Jev Ultrafast](https://github.com/browser-use/jev-ultrafast). The original MIT notice is preserved in [NOTICE](NOTICE). This project is released under the [MIT License](LICENSE).

[Logo · SVG](assets/logo.svg) · [Logo · PNG](assets/logo.png) · [Social preview · SVG](assets/social-preview.svg) · [Social preview · PNG](assets/social-preview.png)

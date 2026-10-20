<p align="center">
  <img src="assets/logo.svg" alt="Jev Browser Agent logo" width="128" height="128" />
</p>

# Jev Browser Agent

**A browser agent with a dynamic, indexed action space. Built for Bun.**

Give it a URL and one goal. A typed decision model picks an operation and an observed element. A chat helper turns the goal into a checklist and writes field text when needed. The agent checks the page after each action, reviews the complete goal against observed evidence, and returns a sourced result.

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

Operation and target questions share **one logical request**. If the operation is `CLICK`, only `click_target` can execute. The chat helper creates the checklist, generates `TYPE_TEXT` values, revises remaining steps when necessary, and reviews the final result. Transient transport failures can retry a model request.

**Completion requires checkpoints and a goal review.** `DONE` is excluded from the decision model's choices during an Agent run. Field values, checked states, expanded menus, navigation and other page evidence must satisfy the checklist. The final review checks the original goal for omitted requirements and supplies an answer with quotes and URLs from observed pages. Unobserved citations are rejected. A selected action or a high model score does not establish completion.

For reading tasks, each requested section named in a step must have its own check when its section link is observed. Reading one section or the page introduction does not verify another section.

There are no site-specific action scripts or prepared field strings in the policy. Model output never becomes a selector, coordinate, shell command, or executable JavaScript.

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

Open **[127.0.0.1:8766](http://127.0.0.1:8766)**, expand **Model settings**, save both connections and use **Check saved connections**. This sends small real requests to test typed choices and structured chat output, including `null`. It checks protocol readiness, not task-solving ability. Choose **Travel planner**, then **Start task**:

> Find a Design stay in Lisbon with Free cancellation and open Casa Flora.

The inspector streams the actual Chromium browser and highlights each selected target before execution. Follow the task checklist, the last observed result, and the **Activity** filmstrip. **Pages visited** lets you review the journey; **Model details** exposes the decision scores.

The agent pointer follows browser mouse movements, pulses on actions, and shows the direction of smooth scrolling. It stays separate from the page DOM and hides while reviewing an old frame. **Preview each action** is off by default; enable it to pause for 1.2 seconds before each action. Pointer animation remains enabled in the demo.

Choose a scenario, review its editable goal, then press **Start task**:

| Scenario                          | What it exercises                                                                   |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| Travel planner / crowded          | Text input, category and cancellation filters, search, scrolling, result navigation |
| Flights · open search             | Cookie consent and the Google Flights search page                                   |
| Flights · one-way route           | LHR → LIS, airport suggestions, departure date, one-way results                     |
| Flights · round trip for two      | AMS ↔ FCO, two adults, departure and return dates                                   |
| Flights · nonstop comparison      | JFK → LAX, nonstop filter, compare two visible fares                                |
| Wikipedia · linked research       | Search, read a section, follow a related article, cite both pages                   |
| Hacker News · compare discussions | Open two discussions, collect visible facts, compare with citations                 |
| GitHub · release research         | Open the latest stable Bun release, read fixes, inspect its source tag              |

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

Configure them in **Model settings** or edit `.env`:

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

If the inspector reports **“Chat helper could not produce a verifiable checklist”**, it rejected the plan and its bounded repair attempts. A repeated validation failure stops after two calls; fixing one error and exposing another allows a third call. The message includes the last validation failure, such as an empty field value, a mismatched control reference, invalid JSON or an output token limit. No action is executed for that rejected plan. Check the **Chat helper** model in **Model settings**: **Test connection** checks API compatibility, not the model's ability to plan a task. A model that repeatedly returns incorrect checks needs to be replaced with a more capable chat model; increasing the decision model's physical batch size does not correct those checks.

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

## Why it moves

- **One request for operation and target.** Speculative target questions share the same structured observation.
- **No screenshots in the decision loop.** The model receives visible controls and page text. Browser frames serve the inspector and recordings.
- **One browser call per snapshot.** Read controls, names, values and visible text together, retaining references to the observed DOM nodes.
- **Validate before input.** Recheck the document, field values and target context. Resolve current geometry and reject covered controls before acting.
- **Bind identities.** Decisions retain their original observation; fields carry document/node references and nearby form context. Dropdowns select the exact observed option even when values are duplicated.
- **Verify after input.** Log confirmed actions before observing their results. Completed visible fields are rechecked; a regression reopens the affected checkpoint.
- **Reuse text carefully.** An interrupted text result is reused only when the entire helper input and connection settings are unchanged.
- **Skip redundant generation.** A uniquely bound field can reuse an exact value already present in the user's goal and active checklist. Passwords, ambiguous bindings, and inferred values still use the helper. Browser freshness and input validation still run.
- **Send evidence once.** Final reviews deduplicate identical sources and avoid repeating their text inside checkpoint metadata; distinct observations and ordered checks remain available.

To diagnose speed, run the CLI with `--log-level debug --log-detail high`: stage timings separate observation, planning, decisions, writing, input and final verification. `model_ms` sums physical model requests; `other_ms` is the remaining run time, including browser work and any pauses. These totals exclude initial browser startup. Recording adds screenshots and disk writes; use `--record` when you need that evidence.

Only observations and model requests are retried. Browser mutations are never replayed after an uncertain error. Default limits are 60 browser actions and 120 decision cycles. Three unchanged actions stop the loop; three consecutive unchanged waits trigger a bounded page recheck and, on a ready page, a repair of the remaining checklist. WAIT is then removed from an unchanged ready page's choices. Checklist revisions share a two-revision budget; waiting never counts as completion. Transport retries allow at most three attempts for known transient failures. Invalid chat output gets one schema repair; checklist planning allows a third attempt only when the repair changed the validation error. A missing field value (`text: null`) stops with a clear reason and never types an invented value.

Loading/empty observations and a proposed `BLOCKED` state receive a bounded wait of about one second. Snapshot failure can recover the observation of a consumed action, without executing it again. Screenshot capture has its own one-second deadline; a missing image does not discard the DOM observation. Incomplete coverage and loading are distinguished from an unsupported step in `stop_reason`.

Navigating documents get up to 30 observation attempts, spaced 100 ms apart. Section links wait for smooth scrolling to settle, with a two-second ceiling. The pointer rechecks the target after moving because hover can cover, move or replace a control. Previously verified controls retain their evidence when scrolling or SPA navigation hides them; a visible changed value still reopens the affected steps.

After reaching an unexpected page, the helper can revise the remaining steps while preserving completed evidence. At most two revisions and three final goal reviews are allowed between browser inputs that change the observed state. A final review that finds missing requirements adds those steps within the same budget. If its remaining checklist is still invalid after schema repair, the checklist planner gets one bounded recovery attempt; this cannot certify completion. Otherwise the run stops without claiming completion.

## Run usage and cost

The inspector's **Model usage** panel, CLI summary, `agent.snapshot().usage`, and exported trace include every physical model request. Planning, decisions, field text, final verification, retries and response repairs are grouped by role, model and provider. Connection checks are separate probes and are excluded from run totals. Failed-request counts describe transport/provider failures; a successful HTTP response can still fail schema or goal validation.

Usage accepts `prompt_tokens` / `completion_tokens` and `input_tokens` / `output_tokens`. Totals show the reported token subtotal and the number of requests with missing or invalid usage. A provider that returns only `total_tokens` cannot supply a reliable input/output breakdown.

Enter optional input and output prices in **Model settings**, in **USD per million tokens**. Library connections accept the same optional field:

```ts
pricing: { inputUsdPerMillion: 0.5, outputUsdPerMillion: 1.5 }
```

These numbers are an example, not provider prices. Each request captures its configured rates. A request with 1,000 reported input tokens and 100 output tokens at those example rates estimates `(1000 × 0.5 + 100 × 1.5) / 1_000_000 = $0.00065`. Changing the model or Base URL clears inherited rates unless replacement rates are supplied. Leave both prices blank for **unknown**; enter explicit zeroes only when that is the intended rate.

`estimated_cost_usd` is the **priced subtotal**. Any nonzero `unknown_cost_requests` means the full run cost is unknown. Missing usage is never treated as free, including failed attempts. This is an estimate at your supplied rates, not an invoice: provider caching discounts, additional charges, taxes and local hardware costs are excluded.

## Small enough to read

| File                                                | Job                                                           |
| --------------------------------------------------- | ------------------------------------------------------------- |
| [agent.ts](src/agent.ts)                            | Async decision loop, checkpoints, budgets and history         |
| [model.ts](src/model.ts)                            | Typed action space, compatible targets and field text         |
| [plan.ts](src/plan.ts)                              | Checklist schema, completion evidence and regression checks   |
| [snapshot.js](src/snapshot.js)                      | Atomic DOM observation, indexed controls and freshness guards |
| [browser.ts](src/browser.ts)                        | Playwright/CDP connection, input and browser frames           |
| [config.ts](src/config.ts)                          | Reloadable connections and private settings storage           |
| [usage.ts](src/usage.ts)                            | Reported tokens, physical requests and configured-rate costs  |
| [server.ts](src/server.ts) / [static/](src/static/) | Local inspector, live progress and activity review            |
| [cli.ts](src/cli.ts)                                | Inspector and headless/headed commands                        |

## Evidence and limits

Tests exercise local browser fixtures and mock model endpoints. They independently check field values, exact dropdown selections, submission counts and multi-page waypoint order, along with model protocols, stale-page handling and premature-completion guards. The task suite includes omitted requirements, unexpected destinations and invented answer citations. These checks validate the application; they do not measure a real model's reasoning quality.

**Goal coverage and answer interpretation still depend on the chat model.** Deterministic checks validate control identities, check types and observed citations. The separate final review reduces missed requirements but cannot prove semantic completeness for an arbitrary goal or an unseen server-side effect. Reading retains up to 16,000 characters from reached viewports, removes changed or hidden text, and preserves the last 12 visited pages for sourced comparisons. Checkpoints retain their own observed evidence. Unseen content is never read from below the viewport. A valid model action can still be the wrong action.

The DOM reader handles common HTML/ARIA controls, native date/time/range/color fields, editable variants, labels for hidden checkbox/radio controls, and bounded discovery of custom click targets. Discovery scans at most 5,000 extra DOM nodes and reports truncation. Native values are checked against type, min/max and step constraints before input. Frames, shadow roots, canvas, uploads, popup tabs, nested scrolling and arbitrary keyboard widgets remain outside this MVP. Password and file inputs are excluded. Duplicate labels need matching references or scope to verify. Workflows that deliberately replace earlier requested values need a narrower goal.

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

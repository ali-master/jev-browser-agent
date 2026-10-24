<p align="center">
  <img src="assets/logo.svg" alt="Jev Browser Agent logo" width="128" height="128" />
</p>

# Jev Browser Agent

**Give it a website and a goal. It operates the browser and returns what it finds.**

Jev clicks, types, selects, scrolls and reads pages to complete tasks such as searching a catalog, filling a form or comparing information across websites. You can watch its actions, review its progress and copy the result with sources.

For example: **“Find a Design stay in Lisbon with free cancellation and open Casa Flora.”** Jev turns this into steps, performs them and checks the page before reporting completion.

It runs Chromium through a Bun/TypeScript library, a CLI or a visual inspector. You provide the local or cloud models. Its decision model chooses from the controls observed on the page.

[Quick start](#try-it) · [Features](#features) · [Library](#use-the-library) · [CLI](#use-the-cli)

## Features

| Capability                                                | What it helps you do                                                          |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Live inspector](#try-it)                                 | Watch actions, pause a run and inspect earlier page snapshots.                |
| [Reusable workflows](#reusable-workflows)                 | Reuse verified actions for repeated tasks when the page and step still match. |
| [Structured results](#structured-results)                 | Get JSON in your required shape, with source evidence for each field.         |
| [Login profiles and secrets](#login-profiles-and-secrets) | Reuse a login and enter private values only into specified sites and fields.  |
| [Cookies and storage](#cookies-and-storage)               | Set, replace or delete site data before a task starts.                        |
| [Page filters](#page-filters)                             | Block ads or URLs and remove unwanted page elements before analysis.          |
| [Frames and tabs](#frames-tabs-and-panels)                | Continue tasks inside frames, new tabs and scrollable panels.                 |
| [Run memory](#memory-within-a-run)                        | Keep earlier page context and avoid repeating ineffective actions.            |
| [Model lab](#model-evaluation)                            | Compare model pairs by completed tasks, speed and token usage.                |
| [Visual fallback](#optional-visual-fallback)              | Click stable canvas targets when ordinary page controls are unavailable.      |
| [WebMCP](#webmcp-tools-alongside-dom-actions)             | Use explicitly allowed tools exposed by a website.                            |
| [Logs and usage](#run-usage-and-cost)                     | Find slow stages and inspect token use and estimated costs.                   |

## Try it

Requires **Bun 1.4.3+**, Chromium and the two model connections described below.

```sh
bun add --global @usex/jev-browser-agent
bunx --bun playwright@1.64.1 install chromium
jev serve --port 8766
```

1. Open [localhost:8766](http://127.0.0.1:8766).
2. In **Agent settings**, save both model connections and click **Check saved connections**.
3. Choose **Travel planner** and press **Start task**.
4. Follow the checklist and **Activity**. Use **Step by step** to review actions before executing them.

Other presets cover Google Flights, Wikipedia, MDN, book catalogs and more. **Your website** accepts your own URL and goal. The inspector shows the agent's pointer; **Preview each action** adds a pause before execution. Stop the server with **Ctrl+C**.

### Connect your models

Both roles are required, even for tasks without typing:

| Role           | Required API                                                    | Responsibility                                   |
| -------------- | --------------------------------------------------------------- | ------------------------------------------------ |
| Decision model | Jev / System One: `/systemone`                                  | Choose an action and its target.                 |
| Chat helper    | OpenAI-compatible `/chat/completions` with `json_schema` output | Plan steps, write field text and review results. |

A regular chat model cannot fill the decision-model role. Both connections can use LM Studio, different servers, or local and cloud providers together.

Configure them in **Agent settings**, or create `.env` in the directory where you run Jev:

```dotenv
TYPESAFE_BASE_URL=http://127.0.0.1:1234/v1
TYPESAFE_API_KEY=
TYPESAFE_MODEL=your-decision-model

TEXT_MODEL_BASE_URL=http://127.0.0.1:1234/v1
TEXT_MODEL_API_KEY=
TEXT_MODEL=your-chat-model
```

Use the provider's base URL, API key and exact loaded model identifier. Leave keys empty only when the provider allows it. Do not append `/systemone` or `/chat/completions` to the base URL.

Settings reload before model steps. Inspector settings in `.jev/settings.json` override `.env`, which overrides environment variables. To switch providers, edit the saved settings; changing models in LM Studio alone does not change Jev's configured identifiers.

## Use the library

```sh
bun add @usex/jev-browser-agent
bunx --bun --no-install playwright install chromium
```

Configure the models above, save this as `agent.ts`, then run `bun run agent.ts`:

```ts
import { Agent } from "@usex/jev-browser-agent";

await using agent = await Agent.create(
  "https://en.wikipedia.org/wiki/Main_Page",
  "Find and open the article about Ada Lovelace.",
  { maxSteps: 20 },
);

for await (const state of agent.run()) {
  console.log(state.status, state.page.url);
}
console.log(agent.state.answer);
console.log(agent.state.stop_reason);
```

`await using` closes the browser when the scope ends. Feature examples below define `options` for the third argument: `Agent.create(url, goal, options)`.

## Use the CLI

After the global installation:

```sh
jev run --url https://en.wikipedia.org/wiki/Main_Page \
  --goal 'Find and open the article about Ada Lovelace.' \
  --headed --max-steps 20 --record artifacts/research
```

Omit `--headed` for a headless browser. `--record` saves the trace and screenshots. Run `jev --help` for all flags.

## Use a feature

### Reusable workflows

Use `{{city}}` in your goal, for example **“Find and open the article about {{city}}.”**

```ts
const options = {
  workflow: { name: "city-research", parameters: { city: "Lisbon" } },
};
```

In the inspector, set **Run options → Reusable workflow** and **Goal parameters**. CLI: `--workflow city-research --params '{"city":"Lisbon"}'`.

A successful goal review saves the recipe locally. Later runs reuse actions only when their page, step and target match. Otherwise, normal decisions resume. Planning and final verification still run.

### Structured results

Ask for the data in your goal, then specify its JSON shape:

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

Read `agent.state.output` for `{ data, evidence, extracted_at }`. Each field includes a source URL and an observed quote. Invalid output cannot complete the run.

In **Run options → Structured output**, paste the schema, then use **Copy JSON** or **Copy CSV** on the result. CSV supports flat objects or arrays of flat objects. CLI: `--schema output.schema.json`.

### Login profiles and secrets

**Reuse a login:** replace the example URL with your site, then sign in manually, including MFA:

```sh
jev login --url https://example.com --profile research
# After signing in, press Enter in the terminal to save.
jev run --url https://example.com --profile research --goal 'Read my saved items.'
```

Profiles are encrypted locally using the OS credential store. In the inspector, enter `research` under **Run options → Login profile**. Library: `profile: { name: "research" }`. The agent uses an isolated browser context.

**Enter a private value:** open **Run options → Run secrets → Add secret**. Set its name, value, exact allowed origin and destination field label. Reference it in the goal as `{{secret:password}}`. The equivalent library options are:

```ts
const options = {
  secrets: {
    password: {
      value: Bun.env.SITE_PASSWORD!,
      origin: "https://example.com",
      label: "Password",
    },
  },
};
```

Set `SITE_PASSWORD` locally first. Secret runs disable screenshots, pointer events and workflow recording/replay. They cannot use vision or WebMCP. Use trusted sites; transformed secret values may not be recognized by redaction.

### Cookies and storage

Open **Run options → Site data**, choose **Cookie**, **localStorage** or **sessionStorage**, then enter the site origin, name and value. Edit entries directly; **Remove** discards a draft, while **Delete this stored entry** removes that key when the task starts. Cookie options include path, expiry, Secure, HttpOnly and SameSite.

Library options:

```ts
const options = {
  siteData: {
    cookies: [{ origin: "https://example.com", name: "language", value: "en" }],
    localStorage: { "https://example.com": { theme: "dark", obsolete: null } },
    sessionStorage: { "https://example.com": { step: "1" } },
  },
};
```

CLI: `--site-data .jev/site-data.json`, with the inner `siteData` object in that file. Values are strings; `null` deletes a key, while `""` stores an empty value. Cookie expiry is Unix seconds, subject to browser limits; omit it for a session cookie.

Entries override matching profile data before the first page loads. Later changes made by the site are preserved. Storage uses exact origins; cookies use a host and path, excluding subdomains but shared across ports. Session storage is initialized in the first task tab; new tabs follow normal browser behavior. Profiles persist permitted cookies and localStorage, but not sessionStorage.

Up to 100 entries, 20 origins and 64 KiB per run. Inspector drafts clear after a successful start and are not saved in settings. Keep JSON files private; values displayed by a site can appear in model prompts and recordings.

### Page filters

Use **Agent settings → Block ad requests / Blocked URLs / Remove elements**, or pass:

```ts
const options = {
  filters: {
    blockAds: true,
    blockedUrls: ["https://example.com/checkout*"],
    removeSelectors: ["aside.sponsored", "video"],
  },
};
```

Filters are off by default. Saved changes apply to new tasks. Explicit `filters` replace saved filters; `{}` disables them. Ad blocking downloads EasyList on first use. Element removal affects the main document and can break controls if selectors are too broad.

### Frames, tabs and panels

Enabled automatically. Give the agent a goal that involves the frame, tab or panel. It can enter child frames, switch between its own tabs, use open Shadow DOM controls and scroll inside panels. Closed shadow roots and transformed frames are unsupported.

### Memory within a run

Enabled automatically. Visited-page context, verified steps and feedback from ineffective actions carry across pages. Inspect `agent.snapshot().memory` or the exported trace. Memory resets for each new Agent; use a workflow to reuse successful actions across runs.

### Model evaluation

Open **Model lab**, label your current model pair and run the three local scenarios with 1–5 repetitions. Change models and run again to compare results.

Reports show independent final-page checks, failures, timings and reported tokens. Export the JSON before restarting the server. Passing a connection check alone does not establish task-solving quality.

### Optional visual fallback

Enable **Run options → Visual fallback for canvas**, use `vision: true`, or add `--vision` to the CLI command. Requires an image-capable chat helper and sends it the viewport image. Supports stable canvas clicks; visual typing is unsupported. Off by default.

### WebMCP tools alongside DOM actions

Experimental. For a site that exposes a native tool named `search`, pass:

```ts
const options = {
  webMCP: { allowedTools: { "https://example.com": ["search"] } },
};
```

In **Run options → WebMCP**, paste the inner `webMCP` object. CLI: `--webmcp permissions.json` with the same object. Requires Chromium WebMCP support. Only allow trusted sites and tools; names do not guarantee their effects. Tools still need observable results and final verification. Cannot be combined with secrets or workflows.

### Run usage and cost

Open **Model usage**, or read `agent.snapshot().usage`. Set input/output prices in **Agent settings** in USD per million tokens to estimate costs. Missing usage or prices stay unknown.

For detailed terminal logs:

```sh
jev serve --log-level debug --log-detail high --color never
```

Levels: `error`, `warn`, `info`, `debug`, `trace`. Detail: `low`, `normal`, `high`. Color: `auto`, `always`, `never`. The same flags work with `jev run`; logs go to stderr and the result to stdout.

## Before you rely on a result

- Completion requires page checks and a final goal review. Accuracy still depends on the models and the website.
- An invalid checklist points to the chat helper: check its model identifier, JSON support and planning quality. Model lab helps test the pair.
- File uploads and arbitrary keyboard widgets are unsupported. Inspect stopped runs before retrying.
- Recordings, profiles and workflow recipes can contain private data. Keep `.env`, `.jev/` and `artifacts/` private.

## Development

```sh
git clone https://github.com/ali-master/jev-browser-agent.git
cd jev-browser-agent
bun install --frozen-lockfile
bun run browser:install
bun run dev       # Start the inspector
bun run check     # Typecheck, tests and build
```

Tests use local fixtures and mock model servers; they do not need model API keys.

## Credits

Based on [Browser Use's Jev Ultrafast](https://github.com/browser-use/jev-ultrafast). Built by [Ali Torki](https://github.com/ali-master). [MIT License](LICENSE) · [Upstream notice](NOTICE).

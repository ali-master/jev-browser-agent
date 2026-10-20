const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="demo-token"]').content;
let state = null,
  busy = false,
  automatic = false,
  paused = false,
  connected = false;
let reviewStep = null,
  liveFrame = null,
  livePointer = null,
  historyKey = "";
let resultKey = "";
const stopped = () =>
  ["done", "blocked", "error", "closed"].includes(state?.status);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const percent = (value) => `${(value * 100).toFixed(value < 0.01 ? 1 : 0)}%`;
const seconds = (value) => `${(value / 1000).toFixed(1)} s`;
function applyState(next) {
  if (next.run_id === state?.run_id && next.revision < state.revision) return;
  if (next.run_id !== state?.run_id) {
    reviewStep = null;
    liveFrame = null;
    livePointer = null;
    historyKey = "";
  }
  if (
    next.history.length !== state?.history.length ||
    ["done", "blocked", "error", "closed"].includes(next.status)
  )
    liveFrame = null;
  const changed =
    next.revision !== state?.revision || next.text_model !== state?.text_model;
  state = next;
  livePointer = next.pointer ?? null;
  if (changed) render();
  else renderPointer();
}
async function call(name, body = {}) {
  const response = await fetch(`/api/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Demo-Token": token },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(Error(data.error || "Request failed"), {
      code: data.code,
    });
  applyState(data);
  if (!data.error) $("error").hidden = true;
  return data;
}
function controls() {
  const working = busy || state?.server_busy;
  const live = state?.page && !stopped();
  for (const id of [
    "start",
    "scenario",
    "run-mode",
    "goal",
    "start-url",
    "save-settings",
    "check-models",
  ])
    $(id).disabled = working;
  $("choose").disabled = working || !live;
  $("execute").disabled = working || !state?.decision || !live;
  $("auto").disabled = working || !live;
  $("choose").hidden = $("execute").hidden = automatic;
  $("auto").hidden = automatic;
  $("stop").hidden = !automatic;
  $("download").disabled = !state?.history?.length;
  document
    .querySelectorAll("[data-step]")
    .forEach((button) => (button.disabled = working));
}
async function perform(fn, label) {
  if (busy) return;
  busy = true;
  reviewStep = null;
  $("error").hidden = true;
  controls();
  $("status").textContent = label;
  try {
    await fn();
  } catch (error) {
    automatic = false;
    try {
      applyState(await fetch("/api/state").then((r) => r.json()));
    } catch {
      /* Keep the original failure when the server disconnected. */
    }
    $("error").textContent = error.message;
    $("error").hidden = false;
  } finally {
    busy = false;
    render();
  }
}
function actionTitle(action, text) {
  if (!action) return "No action selected";
  if (action.kind === "tool")
    return `Call tool ${action.label || action.action}${text ? ` · ${text}` : ""}`;
  if (action.kind === "fill")
    return `Type${text ? ` “${text}”` : ""} in ${action.label || action.action}`;
  if (action.kind === "select")
    return `Select ${action.label || action.action}`;
  if (action.kind === "click") return `Click ${action.label || action.action}`;
  return action.label || action.action;
}
function stepTitle(step) {
  const check = step.checks.find((c) => c.kind === "action") || step.checks[0];
  if (check?.kind === "value") return `Set ${check.label} to “${check.equals}”`;
  if (check?.kind === "checked")
    return `${check.equals ? "Enable" : "Disable"} ${check.label}`;
  if (check?.kind === "expanded")
    return `${check.equals ? "Open" : "Close"} ${check.label}`;
  if (check?.kind === "action") return `Click ${check.label}`;
  return step.instruction;
}
function presentation() {
  const activity = state?.activity;
  const action =
    activity?.action ||
    state?.page?.actions.find((a) => a.id === state.decision?.choice);
  const step = state?.checkpoints?.[state.plan_index];
  const detail = step
    ? `Step ${state.plan_index + 1} · ${stepTitle(step)}`
    : "Each step is checked against the page.";
  const stages = {
    verifying: [
      "VERIFYING GOAL",
      "Checking the complete result",
      "Comparing the observed evidence with every requirement in your original task.",
      "◎",
    ],
    opening: [
      "OPENING BROWSER",
      "Opening the starting page",
      "A fresh browser is being prepared.",
      "↗",
    ],
    planning: [
      "PLANNING",
      "Making the task checklist",
      "Turning your goal into steps that can be checked on the page.",
      "≡",
    ],
    deciding: ["CHOOSING", "Choosing the next action", detail, "◉"],
    writing: [
      "PREPARING TEXT",
      actionTitle(action),
      "The chat helper is preparing the value for this field.",
      "T",
    ],
    acting: [
      "EXECUTING",
      actionTitle(action, activity?.text),
      "The browser is performing this action now.",
      "↗",
    ],
    observing: [
      "CHECKING THE PAGE",
      activity?.action
        ? "Checking the action’s result"
        : "Reading the current page",
      "Looking for evidence that this step is complete.",
      "◎",
    ],
  };
  if (activity) return stages[activity.kind];
  if (state?.status === "done")
    return [
      "COMPLETE",
      "All steps verified",
      "The requested steps have been checked. The final page is shown here.",
      "✓",
    ];
  if (state?.status === "blocked")
    return [
      "NEEDS ATTENTION",
      "The agent stopped here",
      state.stop_reason?.message ||
        "It could not find a supported action. Review the last result and adjust the task.",
      "!",
    ];
  if (state?.status === "error" || state?.error)
    return [
      "NEEDS ATTENTION",
      "The run needs attention",
      state.error ||
        "An action failed. Review the last observed page before starting again.",
      "!",
    ];
  if (state?.decision)
    return [
      paused ? "PAUSED · NEXT ACTION" : "NEXT ACTION",
      actionTitle(action),
      paused
        ? "Paused before execution. Resume when you are ready."
        : automatic
          ? "Previewing the target before execution."
          : "Ready to execute. This choice has not been performed yet.",
      "↗",
    ];
  if (state?.page)
    return [
      paused ? "PAUSED" : "READY",
      paused ? "Paused at this step" : "Ready for the next step",
      detail,
      "Ⅱ",
    ];
  return [
    "READY",
    "Start with a task",
    "The agent will make a checklist, then work through it one step at a time.",
    "↗",
  ];
}
function renderBrowser() {
  if (!state) return;
  const frame = state.frames?.find((f) => f.step === reviewStep);
  const page = state.page;
  const url = frame?.url || liveFrame?.url || page?.url;
  const image =
    frame?.image_url ||
    (liveFrame?.image
      ? `data:image/jpeg;base64,${liveFrame.image}`
      : page?.screenshot
        ? `data:image/jpeg;base64,${page.screenshot}`
        : null);
  const [phase, title, detail, icon] = presentation();
  const entry = frame && state.history.find((h) => h.step === frame.step);
  $("url").textContent = url || "No page open";
  $("url").title = url || "";
  $("page-title").textContent =
    frame?.title ||
    (url === page?.url ? page?.title : "Navigating…") ||
    "Isolated browser";
  $("feed-status").textContent = frame
    ? "REVIEW"
    : !image && page?.screenshot_status === "unavailable"
      ? "IMAGE UNAVAILABLE"
      : !connected
        ? "RECONNECTING"
        : stopped()
          ? "FINAL PAGE"
          : state.live_available
            ? "LIVE"
            : "SNAPSHOT";
  $("feed-status").dataset.mode = frame
    ? "review"
    : stopped()
      ? "complete"
      : connected
        ? "live"
        : "offline";
  $("action-icon").textContent = frame ? "◷" : icon;
  $("action-summary").textContent = frame
    ? entry
      ? `After action ${entry.step} · ${actionTitle(entry, entry.text)}`
      : "Starting page · before any actions"
    : title;
  $("action-detail").textContent = frame
    ? "Reviewing a saved frame. The browser has not moved."
    : `${phase.charAt(0) + phase.slice(1).toLowerCase()} · ${detail}`;
  $("return-live").hidden = !frame;
  $("return-live").textContent = stopped()
    ? "Return to final page"
    : "Return to live view";
  $("action-banner").dataset.review = Boolean(frame);
  $("frame-note").textContent = frame
    ? `Saved after ${frame.step} action${frame.step === 1 ? "" : "s"}`
    : !image && page?.screenshot_status === "unavailable"
      ? "Page image unavailable; the agent can still read the page."
      : state.activity
        ? "Watching the actual browser"
        : `${state.history.length} actions performed`;
  $("empty").hidden = Boolean(image);
  $("screenshot").hidden = !image;
  if (image && $("screenshot").getAttribute("src") !== image)
    $("screenshot").src = image;
  $("screenshot").alt = frame
    ? `Browser after action ${frame.step}`
    : "Current page in the agent’s browser";
  const selected =
    state.activity?.action ||
    page?.actions.find((a) => a.id === state.decision?.choice);
  const showSelected =
    !state.activity || ["writing", "acting"].includes(state.activity.kind);
  const targets = new Map();
  for (const action of page?.actions || [])
    if (action.rect && !targets.has(action.node))
      targets.set(action.node, action);
  $("targets").innerHTML =
    frame || !image || url !== page?.url
      ? ""
      : [...targets.values()]
          .map((a, i) => {
            const chosen = showSelected && a.node === selected?.node;
            if (!chosen && !$("overlays").checked) return "";
            return `<div class="target ${chosen ? "selected" : ""}" data-action="${i + 1}" style="left:${(100 * a.rect.x) / page.w}%;top:${(100 * a.rect.y) / page.h}%;width:${(100 * a.rect.w) / page.w}%;height:${(100 * a.rect.h) / page.h}%"><span>${chosen ? "Next target" : i + 1}</span></div>`;
          })
          .join("");
  renderPointer();
}

function renderPointer() {
  const pointer = livePointer;
  const node = $("agent-pointer");
  const url = liveFrame?.url || state?.page?.url;
  node.hidden =
    !pointer ||
    reviewStep !== null ||
    !connected ||
    pointer.run_id !== state?.run_id ||
    pointer.url !== url ||
    $("screenshot").hidden;
  if (node.hidden) return;
  node.style.left = `${(100 * pointer.x) / pointer.w}%`;
  node.style.top = `${(100 * pointer.y) / pointer.h}%`;
  node.dataset.phase = pointer.phase;
  node.dataset.edge = pointer.x > pointer.w * 0.7 ? "right" : "left";
  node.dataset.bottom = pointer.y > pointer.h * 0.85;
  const verb =
    pointer.phase === "scroll"
      ? pointer.deltaY < 0
        ? "Scroll ↑"
        : "Scroll ↓"
      : pointer.phase === "press" || pointer.phase === "release"
        ? "Act"
        : "Agent";
  $("pointer-label").textContent = `${verb} · ${pointer.label}`;
}
function resultFor(step) {
  const entry = state.history.find((h) => h.step === step);
  if (!entry) return "Before any actions";
  const checks = state.checkpoints.filter(
    (c) => c.verified?.action_count === step,
  );
  if (checks.length)
    return `${checks.length} checklist step${checks.length === 1 ? "" : "s"} verified`;
  return entry.page_changed === null
    ? "Result not observed yet"
    : entry.page_changed
      ? "Page changed · step still pending"
      : "No visible change";
}
function renderHistory() {
  const key = JSON.stringify([
    state.run_id,
    state.frames,
    reviewStep,
    state.plan_index,
  ]);
  if (key === historyKey) return;
  const newFrame = state.frames?.length > $("history").children.length;
  historyKey = key;
  $("history").innerHTML = state.frames?.length
    ? state.frames
        .map((frame) => {
          const entry = state.history.find((h) => h.step === frame.step);
          return `<button type="button" class="frame-card" data-step="${frame.step}" aria-pressed="${reviewStep === frame.step}"><img src="${escape(frame.image_url)}" alt="" loading="lazy" /><span class="frame-meta">${entry ? `ACTION ${entry.step} · ${seconds(entry.elapsed_ms)}` : "STARTING PAGE"}</span><strong>${escape(entry ? actionTitle(entry, entry.text) : frame.title)}</strong><span class="frame-result">${escape(resultFor(frame.step))}</span></button>`;
        })
        .join("")
    : '<p class="muted">The starting page and each action will appear here.</p>';
  const places = (state.frames || []).filter(
    (frame, i, frames) => !i || frame.url !== frames[i - 1].url,
  );
  $("journey").innerHTML = places.length
    ? `<span>Pages visited</span>${places.map((frame, i) => `${i ? '<span aria-hidden="true">→</span>' : ""}<button type="button" data-step="${frame.step}" title="${escape(frame.url)}">${escape(frame.title || frame.url)}</button>`).join("")}`
    : "";
  if (automatic && newFrame) $("history").scrollLeft = $("history").scrollWidth;
}
function renderDetails() {
  const d = state.decision || state.decisions?.at(-1);
  $("action-count").textContent = `${state.elements.length} targets`;
  $("latency").textContent = d ? seconds(d.latency_ms) : "—";
  $("confidence").textContent =
    d?.target_confidence != null ? percent(d.target_confidence) : "—";
  $("completion").textContent = d?.operation || "—";
  const current = state.decision;
  $("ranking-note").textContent = current
    ? "Current choice scores"
    : "Current page · unranked";
  $("operation-choices").innerHTML = Object.entries(
    d?.operation_probabilities || {},
  )
    .sort((a, b) => b[1] - a[1])
    .map(
      ([name, p]) =>
        `<span class="operation-choice ${name === d.operation ? "best" : ""}">${escape(name)} <b>${percent(p)}</b></span>`,
    )
    .join("");
  const probability = (e) =>
    current?.target_probabilities[e.index] ??
    Math.max(
      -1,
      ...(e.options || []).map(
        (o) => current?.target_probabilities[o.index] ?? -1,
      ),
    );
  $("choices").innerHTML = [...state.elements]
    .sort((a, b) => probability(b) - probability(a))
    .map((e) => {
      const p = probability(e);
      return `<div class="choice"><span class="choice-id">[${escape(e.index)}]</span><div class="choice-label">${escape(e.label)}<small>${escape(e.role)} · ${escape(e.operations.join(" / "))}</small></div><span class="probability">${p >= 0 ? percent(p) : "—"}</span></div>`;
    })
    .join("");
  $("model-state").textContent = JSON.stringify(
    current?.request || {
      goal: state.goal,
      checkpoints: state.checkpoints,
      url: state.page?.url,
      text: state.page?.text,
    },
    null,
    2,
  );
}
function renderResult() {
  $("task-result").hidden = !state.answer;
  if (!state.answer) {
    resultKey = "";
    return;
  }
  const review = state.completion_reviews?.at(-1);
  const key = JSON.stringify([
    state.run_id,
    state.answer,
    state.answer_html,
    state.output,
    review,
    state.history.length,
    state.elapsed_ms,
  ]);
  // Preserve selection, expanded evidence and copy feedback during live updates.
  if (key === resultKey) return;
  resultKey = key;
  const verified = state.status === "done" && review?.complete;
  $("result-status").textContent = verified ? "TASK COMPLETE" : "TASK RESULT";
  $("result-title").textContent = verified ? "Verified result" : "Result";
  $("result-meta").textContent =
    `${state.history.length} actions · ${seconds(state.elapsed_ms || 0)}`;
  if (state.answer_html) $("answer").innerHTML = state.answer_html;
  else $("answer").textContent = state.answer;
  $("structured-result").hidden = !state.output;
  $("output-data").textContent = state.output
    ? JSON.stringify(state.output.data, null, 2)
    : "";
  $("copy-csv").hidden = state.output_csv == null;
  $("output-evidence").replaceChildren();
  for (const item of state.output?.evidence || []) {
    const term = document.createElement("dt"),
      description = document.createElement("dd");
    term.textContent = item.path || "(root)";
    description.textContent = `${item.quote}\n${item.url}`;
    $("output-evidence").append(term, description);
  }
  $("copy-answer").querySelector("span").textContent = "Copy answer";
  $("copy-answer").dataset.copied = "false";
  $("result-copy-status").textContent =
    "Select any text to copy, or copy the full answer as Markdown.";

  const sources = new Map();
  for (const source of review?.evidence || []) {
    try {
      const url = new URL(source.url);
      if (!["http:", "https:"].includes(url.protocol)) continue;
      if (!sources.has(url.href))
        sources.set(url.href, { url, quotes: new Set() });
      if (source.quote)
        sources
          .get(url.href)
          .quotes.add(source.quote.trim().replace(/\s+/g, " "));
    } catch {
      /* Invalid citations remain outside the navigable source list. */
    }
  }
  const pages = [
    state.page,
    ...(state.read_sources || []),
    ...(state.frames || []),
  ].filter(Boolean);
  $("result-references").hidden = sources.size === 0;
  $("task-result").classList.toggle("without-sources", sources.size === 0);
  $("source-count").textContent = sources.size;
  const copyIcon =
    '<svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/></svg>';
  $("answer-sources").innerHTML = [...sources.values()]
    .map(({ url, quotes }, i) => {
      const page = pages.find(
        (page) => page.url?.split("#")[0] === url.href.split("#")[0],
      );
      const title = page?.title || url.hostname;
      return `<li class="result-source">
      <div class="source-topline">
        <span class="source-number" aria-hidden="true">${String(i + 1).padStart(2, "0")}</span>
        <a class="source-link" href="${escape(url.href)}" target="_blank" rel="noopener noreferrer" title="${escape(url.href)}">
          <span class="source-title">${escape(title)} <span aria-hidden="true">↗</span></span>
          <span class="source-host" dir="ltr">${escape(url.hostname)}</span>
        </a>
        <button type="button" class="copy-source" data-copy-source="${escape(url.href)}" aria-label="Copy source link: ${escape(title)}" title="Copy source link">${copyIcon}</button>
      </div>
      <details class="source-evidence">
        <summary>View evidence <span>${quotes.size} ${quotes.size === 1 ? "excerpt" : "excerpts"}</span></summary>
        ${[...quotes].map((quote) => `<figure><blockquote dir="auto">${escape(quote)}</blockquote><figcaption><button type="button" data-copy-quote>Copy quote</button></figcaption></figure>`).join("")}
        <a class="source-address" href="${escape(url.href)}" target="_blank" rel="noopener noreferrer" dir="ltr">${escape(url.href)}</a>
      </details>
    </li>`;
    })
    .join("");
}

/** Copy the original content; denied clipboard access must never report success. */
async function copyResult(text, button, label) {
  const key = resultKey;
  button.disabled = true;
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    const input = document.createElement("textarea");
    input.value = text;
    input.setAttribute("aria-label", "Content to copy");
    input.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.append(input);
    input.select();
    try {
      copied = document.execCommand("copy");
    } catch {
      /* Show the manual-copy hint below. */
    }
    input.remove();
    button.focus({ preventScroll: true });
  } finally {
    button.disabled = false;
  }
  if (key !== resultKey) return;
  button.dataset.copied = String(copied);
  if (button.id === "copy-answer")
    button.querySelector("span").textContent = copied
      ? "Copied"
      : "Copy answer";
  $("result-copy-status").textContent = copied
    ? `${label} copied to clipboard.`
    : "Could not access the clipboard. Select the text and copy it manually.";
}

$("task-result").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.id === "copy-answer")
    void copyResult(state.answer, button, "Answer");
  else if (button.id === "copy-output")
    void copyResult(
      JSON.stringify(state.output, null, 2),
      button,
      "Structured output",
    );
  else if (button.id === "copy-csv")
    void copyResult(state.output_csv, button, "CSV");
  else if (button.hasAttribute("data-copy-source"))
    void copyResult(button.dataset.copySource, button, "Source link");
  else if (button.hasAttribute("data-copy-code"))
    void copyResult(
      button.closest(".result-code").querySelector("code").textContent,
      button,
      "Code",
    );
  else if (button.hasAttribute("data-copy-quote"))
    void copyResult(
      button.closest("figure").querySelector("blockquote").textContent,
      button,
      "Quote",
    );
});

function render() {
  if (!state) return;
  renderEvaluation();
  $("webmcp-status").textContent = state.page?.webmcp
    ? state.page.webmcp.available
      ? `WebMCP · ${state.page.webmcp.tools} permitted tools in this page`
      : "WebMCP unavailable in this Chromium; DOM actions remain available."
    : "";
  $("vision-status").textContent = state.vision
    ? `Visual fallback · ${state.vision.attempts} attempts${state.vision.error ? ` · ${state.vision.error}` : ""}`
    : "";
  $("privacy-status").textContent = state.privacy?.images_disabled
    ? "Private run · screenshots and live images are disabled. Activity and values use secret placeholders."
    : "";
  $("workflow-status").textContent = state.workflow
    ? `Workflow ${state.workflow.name} · ${state.workflow.hits} reused actions · ${state.workflow.misses} mismatches${state.workflow.saved ? " · saved" : ""}${state.workflow.error ? ` · ${state.workflow.error}` : ""}`
    : "";
  const [phase, title, detail] = presentation();
  $("helper").textContent = `Chat helper · ${state.text_model}`;
  $("phase-label").textContent = phase;
  $("choice-title").textContent = title;
  $("choice-detail").textContent = detail;
  const checkpoints = state.checkpoints || [];
  const verified = checkpoints.filter((step) => step.verified).length;
  $("progress-count").textContent = checkpoints.length
    ? `${verified} of ${checkpoints.length} verified`
    : "Not started";
  $("progress-bar").style.width = checkpoints.length
    ? `${(100 * verified) / checkpoints.length}%`
    : "0%";
  $("plan").innerHTML = checkpoints.length
    ? checkpoints
        .map(
          (step, i) =>
            `<li class="plan-step ${step.verified ? "verified" : i === state.plan_index ? "current" : ""}"><span class="step-number">${step.verified ? "✓" : i + 1}</span><div>${escape(stepTitle(step))}<small>${step.verified ? "Verified on the page" : i === state.plan_index ? "Current step" : "Waiting"}</small></div></li>`,
        )
        .join("")
    : '<li class="plan-empty">Your steps will appear when the agent starts.</li>';
  const activePhase =
    state.activity?.kind === "writing"
      ? "acting"
      : state.activity?.kind === "verifying"
        ? "observing"
        : state.activity?.kind;
  document
    .querySelectorAll("[data-phase]")
    .forEach((el) =>
      el.classList.toggle("active", el.dataset.phase === activePhase),
    );
  $("result-summary").textContent = state.history.length
    ? `${actionTitle(state.history.at(-1), state.history.at(-1).text)}. ${resultFor(state.history.length)}.`
    : "No actions yet. Choosing an action does not execute it.";
  renderResult();
  $("step-count").textContent =
    `${state.history.length} actions · ${seconds(state.elapsed_ms || 0)}`;
  const usage = state.usage;
  const cost = (row) =>
    row.unknown_cost_requests
      ? `Unknown for ${row.unknown_cost_requests} requests · $${row.estimated_cost_usd.toFixed(6)} priced subtotal`
      : `$${row.estimated_cost_usd.toFixed(6)}`;
  $("usage-summary").textContent = usage?.total.requests
    ? `${usage.total.requests} requests · ${cost(usage.total)}`
    : "No requests yet";
  $("usage-rows").replaceChildren(
    ...(usage?.by_model || []).map((row) => {
      const tr = document.createElement("tr");
      for (const value of [
        `${row.role} · ${row.model} · ${row.endpoint || ""}`,
        `${row.requests} / ${row.failed_requests}`,
        `${row.input_tokens} / ${row.output_tokens}${row.unknown_usage_requests ? ` · usage unknown for ${row.unknown_usage_requests} requests` : ""}`,
        cost(row),
      ]) {
        const td = document.createElement("td");
        td.textContent = value;
        tr.append(td);
      }
      return tr;
    }),
  );
  $("status").textContent = !connected
    ? "Connection interrupted · showing the last page"
    : paused && busy
      ? "Pausing · finishing the current request…"
      : state.status === "done"
        ? "All steps verified · task complete"
        : title;
  $("status-dot").classList.toggle("running", Boolean(state.activity));
  if (state.error) {
    $("error").textContent = state.error;
    $("error").hidden = false;
  }
  renderBrowser();
  renderHistory();
  renderDetails();
  controls();
  renderTime();
}
function renderEvaluation() {
  const lab = state.evaluation;
  if (!lab) return;
  $("evaluation-start").disabled = busy || state.server_busy;
  $("evaluation-stop").disabled = !lab.running || lab.stopping;
  $("evaluation-download").disabled = !lab.reports.length;
  $("evaluation-status").textContent =
    lab.error ||
    (lab.stopping
      ? "Stopping · browser closed; waiting for the current model request."
      : lab.running
        ? lab.current
        : lab.results.length
          ? "Evaluation finished."
          : "No evaluation yet.");
  const rows = (id, values) => {
    $(id).replaceChildren(
      ...values.map((row) => {
        const tr = document.createElement("tr");
        for (const value of row) {
          const td = document.createElement("td");
          td.textContent = value;
          tr.append(td);
        }
        return tr;
      }),
    );
  };
  rows(
    "evaluation-summary",
    lab.reports.flatMap((report) =>
      report.summary.map((row) => [
        row.variant,
        `${row.passed} / ${row.runs} · ${percent(row.success_rate)}`,
        `${seconds(row.p50_ms)} / ${seconds(row.p95_ms)}${report.cancelled ? " · cancelled" : ""}`,
      ]),
    ),
  );
  rows(
    "evaluation-results",
    lab.results.map((row) => [
      `${row.case} · ${row.repeat}`,
      row.passed ? "Passed" : `Failed · ${row.failure_stage}`,
      `${seconds(row.wall_ms)} / ${seconds(row.model_ms)}`,
      `${row.usage.total.input_tokens} / ${row.usage.total.output_tokens}${row.usage.total.unknown_usage_requests ? " · partial" : ""}`,
      row.reason || `${row.actions} actions · independent assertions passed`,
    ]),
  );
}
$("evaluation-form").addEventListener("submit", (event) => {
  event.preventDefault();
  perform(
    () =>
      call("evaluate", {
        label: $("evaluation-label").value,
        repeat: Number($("evaluation-repeat").value),
      }),
    "Starting model evaluation…",
  );
});
$("evaluation-stop").addEventListener("click", () => {
  perform(() => call("evaluate/stop"), "Stopping evaluation…");
});
$("evaluation-download").addEventListener("click", () => {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(state.evaluation.reports, null, 2)], {
      type: "application/json",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "jev-evaluations.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
function renderTime() {
  $("phase-time").textContent = state?.activity
    ? `${seconds(Date.now() - state.activity.started_at)} in this stage`
    : state?.status === "done"
      ? `Finished in ${seconds(state.elapsed_ms)}`
      : "";
}
setInterval(renderTime, 250);
async function runAutomatically() {
  automatic = true;
  paused = false;
  let staleRetries = 0;
  render();
  try {
    for (let i = 0; i < state.max_steps * 2 && automatic && !stopped(); i++) {
      if (!state.decision) await call("predict");
      if (!automatic || stopped()) break;
      if (!state.decision) continue;
      if ($("pace").checked)
        await new Promise((resolve) => setTimeout(resolve, 1200));
      if (!automatic) break;
      try {
        await call("act", { fingerprint: state.page.fingerprint });
        staleRetries = 0;
      } catch (error) {
        if (error.code !== "stale_page" || ++staleRetries > 2) throw error;
        state.decision = null;
      }
    }
  } finally {
    automatic = false;
  }
}
$("task-form").addEventListener("submit", (event) => {
  event.preventDefault();
  paused = false;
  perform(async () => {
    await call("reset", {
      scenario: $("scenario").value,
      goal: $("goal").value,
      url: $("start-url").value,
      vision: $("vision-enabled").checked,
      ...($("webmcp-permissions").value.trim()
        ? { webMCP: JSON.parse($("webmcp-permissions").value) }
        : {}),
      ...($("profile-name").value.trim()
        ? { profile: $("profile-name").value.trim() }
        : {}),
      ...($("secret-bindings").value.trim()
        ? {
            secrets: (() => {
              try {
                return JSON.parse($("secret-bindings").value);
              } catch {
                throw new Error("Secrets must be a valid JSON object.");
              }
            })(),
          }
        : {}),
      ...($("output-schema").value.trim()
        ? { outputSchema: JSON.parse($("output-schema").value) }
        : {}),
      ...($("workflow-name").value.trim()
        ? {
            workflow: {
              name: $("workflow-name").value.trim(),
              parameters: JSON.parse($("workflow-params").value || "{}"),
            },
          }
        : {}),
    });
    $("secret-bindings").value = "";
    document.querySelector(".toolbar").scrollIntoView({ block: "start" });
    if ($("run-mode").value === "auto") await runAutomatically();
  }, "Opening a fresh browser…");
});
$("scenario").addEventListener("change", () => {
  const selected = $("scenario").selectedOptions[0];
  $("goal").value = selected.dataset.goal;
  $("scenario-description").textContent = selected.dataset.description;
  $("start-url-row").hidden = $("scenario").value !== "custom";
  $("start-url").required = $("scenario").value === "custom";
});
$("choose").addEventListener("click", () =>
  perform(() => call("predict"), "Choosing the next action…"),
);
$("execute").addEventListener("click", () =>
  perform(
    () => call("act", { fingerprint: state.page.fingerprint }),
    "Executing the choice…",
  ),
);
$("auto").addEventListener("click", () =>
  perform(runAutomatically, "Running the browser…"),
);
$("stop").addEventListener("click", () => {
  automatic = false;
  paused = true;
  render();
});
$("overlays").addEventListener("change", renderBrowser);
for (const id of ["history", "journey"])
  $(id).addEventListener("click", (event) => {
    const button = event.target.closest("[data-step]");
    if (!button || busy || state.server_busy) return;
    reviewStep = Number(button.dataset.step);
    render();
  });
$("return-live").addEventListener("click", () => {
  reviewStep = null;
  render();
});
$("download").addEventListener("click", () => {
  const { page, ...rest } = state;
  const url = URL.createObjectURL(
    new Blob(
      [
        JSON.stringify(
          { ...rest, page: { ...page, screenshot: undefined } },
          null,
          2,
        ),
      ],
      {
        type: "application/json",
      },
    ),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "jev-browser-trace.json";
  a.click();
  URL.revokeObjectURL(url);
});
const events = new EventSource("/api/events");
events.addEventListener("open", () => {
  connected = true;
  render();
});
events.addEventListener("state", (event) => applyState(JSON.parse(event.data)));
events.addEventListener("frame", (event) => {
  const frame = JSON.parse(event.data);
  if (frame.run_id !== state?.run_id) return;
  liveFrame = frame;
  renderBrowser();
});
events.addEventListener("pointer", (event) => {
  const pointer = JSON.parse(event.data);
  if (pointer.run_id !== state?.run_id) return;
  livePointer = pointer;
  renderPointer();
});
events.addEventListener("error", () => {
  connected = false;
  automatic = false;
  render();
});
fetch("/api/state")
  .then((r) => r.json())
  .then(applyState)
  .catch(() => {
    $("status").textContent = "Cannot reach local demo server";
  });
function showSettings(settings) {
  for (const kind of ["decision", "text"]) {
    $(`${kind}-base`).value = settings[kind].baseUrl;
    $(`${kind}-model`).value = settings[kind].model;
    $(`${kind}-key`).value = "";
    $(`${kind}-key`).placeholder = settings[kind].hasApiKey
      ? "Saved · leave blank to keep"
      : "Optional for a local server";
    $(`${kind}-clear`).checked = false;
    $(`${kind}-input-price`).value =
      settings[kind].pricing?.inputUsdPerMillion ?? "";
    $(`${kind}-output-price`).value =
      settings[kind].pricing?.outputUsdPerMillion ?? "";
  }
  $("model-tag").textContent =
    settings.decision.model || "Configure your models";
  $("block-ads").checked = settings.filters?.blockAds ?? false;
  $("blocked-urls").value = (settings.filters?.blockedUrls ?? []).join("\n");
  $("remove-selectors").value = (settings.filters?.removeSelectors ?? []).join(
    "\n",
  );
}
$("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  perform(async () => {
    const body = {};
    for (const kind of ["decision", "text"]) {
      body[kind] = {
        baseUrl: $(`${kind}-base`).value,
        model: $(`${kind}-model`).value,
      };
      const input = $(`${kind}-input-price`).value,
        output = $(`${kind}-output-price`).value;
      if (Boolean(input) !== Boolean(output))
        throw Error(
          "Enter both token prices, or leave both blank for unknown.",
        );
      body[kind].pricing =
        input && output
          ? {
              inputUsdPerMillion: Number(input),
              outputUsdPerMillion: Number(output),
            }
          : null;
      if ($(`${kind}-clear`).checked) body[kind].apiKey = "";
      else if ($(`${kind}-key`).value)
        body[kind].apiKey = $(`${kind}-key`).value;
    }
    const lines = (id) =>
      $(id)
        .value.split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
    body.filters = {
      blockAds: $("block-ads").checked,
      blockedUrls: lines("blocked-urls"),
      removeSelectors: lines("remove-selectors"),
    };
    try {
      for (const selector of body.filters.removeSelectors)
        document.querySelector(selector);
    } catch {
      throw Error(
        "Invalid CSS selector in Remove elements. Correct it before saving.",
      );
    }
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Demo-Token": token },
      body: JSON.stringify(body),
    });
    const settings = await response.json();
    if (!response.ok) throw Error(settings.error || "Could not save settings");
    showSettings(settings);
    $("connection-checks").replaceChildren();
    $("settings-status").textContent =
      "Saved · models apply now; browser filters apply to new tasks";
    applyState(await fetch("/api/state").then((r) => r.json()));
  }, "Saving agent settings…");
});
$("check-models").addEventListener("click", () =>
  perform(async () => {
    $("settings-status").textContent = "Checking saved connections…";
    $("connection-checks").replaceChildren();
    const response = await fetch("/api/preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Demo-Token": token },
      body: "{}",
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || "Connection checks failed");
    $("connection-checks").replaceChildren(
      ...result.checks.map((check) => {
        const item = document.createElement("li");
        item.textContent = `${check.role === "decision" ? "Decision model" : "Chat helper"}: ${check.ok ? "Ready" : check.message} · ${check.model || "No model selected"} · ${check.endpoint} · ${seconds(check.latency_ms)}`;
        return item;
      }),
    );
    $("settings-status").textContent = result.checks.every((check) => check.ok)
      ? "Both saved connections are ready"
      : "Check the failed connection before starting a task";
  }, "Checking model connections…"),
);
fetch("/api/settings")
  .then(async (response) => {
    const settings = await response.json();
    if (!response.ok) throw Error(settings.error || "Could not read settings");
    showSettings(settings);
    $("model-settings").open = !(
      settings.decision.model && settings.text.model
    );
  })
  .catch((error) => {
    $("settings-status").textContent = error.message;
  });
for (const kind of ["decision", "text"]) {
  for (const field of ["base", "model"])
    $(`${kind}-${field}`).addEventListener("input", () => {
      $(`${kind}-input-price`).value = $(`${kind}-output-price`).value = "";
      $("connection-checks").replaceChildren();
      $("settings-status").textContent =
        "Connection changed · save and check again; token prices cleared";
    });
}

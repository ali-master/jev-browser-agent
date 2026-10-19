const $ = (id) => document.getElementById(id);
const token = document.querySelector('meta[name="demo-token"]').content;
let state = null,
  busy = false,
  automatic = false,
  paused = false,
  connected = false;
let reviewStep = null,
  liveFrame = null,
  historyKey = "";
const stopped = () => ["done", "blocked", "error", "closed"].includes(state?.status);
const goals = {
  custom: "",
  travel: "Find a Design stay in Lisbon with Free cancellation and open Casa Flora.",
  research: "Open the article about using finite choices to control browser agents.",
};
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const percent = (value) => `${(value * 100).toFixed(value < 0.01 ? 1 : 0)}%`;
const seconds = (value) => `${(value / 1000).toFixed(1)} s`;
function applyState(next) {
  if (next.run_id === state?.run_id && next.revision < state.revision) return;
  if (next.run_id !== state?.run_id) {
    reviewStep = null;
    liveFrame = null;
    historyKey = "";
  }
  if (
    next.history.length !== state?.history.length ||
    ["done", "blocked", "error", "closed"].includes(next.status)
  )
    liveFrame = null;
  const changed = next.revision !== state?.revision || next.text_model !== state?.text_model;
  state = next;
  if (changed) render();
}
async function call(name, body = {}) {
  const response = await fetch(`/api/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Demo-Token": token },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || "Request failed");
  applyState(data);
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
  document.querySelectorAll("[data-step]").forEach((button) => (button.disabled = working));
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
  if (action.kind === "fill")
    return `Type${text ? ` “${text}”` : ""} in ${action.label || action.action}`;
  if (action.kind === "select") return `Select ${action.label || action.action}`;
  if (action.kind === "click") return `Click ${action.label || action.action}`;
  return action.label || action.action;
}
function stepTitle(step) {
  const check = step.checks.find((c) => c.kind === "action") || step.checks[0];
  if (check?.kind === "value") return `Set ${check.label} to “${check.equals}”`;
  if (check?.kind === "checked") return `${check.equals ? "Enable" : "Disable"} ${check.label}`;
  if (check?.kind === "action") return `Click ${check.label}`;
  return step.instruction;
}
function presentation() {
  const activity = state?.activity;
  const action =
    activity?.action || state?.page?.actions.find((a) => a.id === state.decision?.choice);
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
      activity?.action ? "Checking the action’s result" : "Reading the current page",
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
      state.error || "An action failed. Review the last observed page before starting again.",
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
    frame?.title || (url === page?.url ? page?.title : "Navigating…") || "Isolated browser";
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
  $("return-live").textContent = stopped() ? "Return to final page" : "Return to live view";
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
  if (image && $("screenshot").getAttribute("src") !== image) $("screenshot").src = image;
  $("screenshot").alt = frame
    ? `Browser after action ${frame.step}`
    : "Current page in the agent’s browser";
  const selected =
    state.activity?.action || page?.actions.find((a) => a.id === state.decision?.choice);
  const showSelected = !state.activity || ["writing", "acting"].includes(state.activity.kind);
  const targets = new Map();
  for (const action of page?.actions || [])
    if (action.rect && !targets.has(action.node)) targets.set(action.node, action);
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
}
function resultFor(step) {
  const entry = state.history.find((h) => h.step === step);
  if (!entry) return "Before any actions";
  const checks = state.checkpoints.filter((c) => c.verified?.action_count === step);
  if (checks.length)
    return `${checks.length} checklist step${checks.length === 1 ? "" : "s"} verified`;
  return entry.page_changed === null
    ? "Result not observed yet"
    : entry.page_changed
      ? "Page changed · step still pending"
      : "No visible change";
}
function renderHistory() {
  const key = JSON.stringify([state.run_id, state.frames, reviewStep, state.plan_index]);
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
  $("confidence").textContent = d?.target_confidence != null ? percent(d.target_confidence) : "—";
  $("completion").textContent = d?.operation || "—";
  const current = state.decision;
  $("ranking-note").textContent = current ? "Current choice scores" : "Current page · unranked";
  $("operation-choices").innerHTML = Object.entries(d?.operation_probabilities || {})
    .sort((a, b) => b[1] - a[1])
    .map(
      ([name, p]) =>
        `<span class="operation-choice ${name === d.operation ? "best" : ""}">${escape(name)} <b>${percent(p)}</b></span>`,
    )
    .join("");
  const probability = (e) =>
    current?.target_probabilities[e.index] ??
    Math.max(-1, ...(e.options || []).map((o) => current?.target_probabilities[o.index] ?? -1));
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
function render() {
  if (!state) return;
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
    .forEach((el) => el.classList.toggle("active", el.dataset.phase === activePhase));
  $("result-summary").textContent = state.history.length
    ? `${actionTitle(state.history.at(-1), state.history.at(-1).text)}. ${resultFor(state.history.length)}.`
    : "No actions yet. Choosing an action does not execute it.";
  $("task-result").hidden = !state.answer;
  $("answer").textContent = state.answer || "";
  $("answer-sources").replaceChildren(
    ...(state.answer ? state.completion_reviews?.at(-1)?.evidence || [] : []).map((source) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.textContent = source.quote;
      if (/^https?:\/\//i.test(source.url)) {
        link.href = source.url;
        link.target = "_blank";
        link.rel = "noreferrer";
      }
      item.append(link);
      return item;
    }),
  );
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
  render();
  try {
    for (let i = 0; i < state.max_steps * 2 && automatic && !stopped(); i++) {
      if (!state.decision) await call("predict");
      if (!automatic || stopped()) break;
      if ($("pace").checked) await new Promise((resolve) => setTimeout(resolve, 1200));
      if (!automatic) break;
      await call("act", { fingerprint: state.page.fingerprint });
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
    });
    document.querySelector(".toolbar").scrollIntoView({ block: "start" });
    if ($("run-mode").value === "auto") await runAutomatically();
  }, "Opening a fresh browser…");
});
$("scenario").addEventListener("change", () => {
  $("goal").value = goals[$("scenario").value];
  $("start-url-row").hidden = $("scenario").value !== "custom";
  $("start-url").required = $("scenario").value === "custom";
});
$("choose").addEventListener("click", () =>
  perform(() => call("predict"), "Choosing the next action…"),
);
$("execute").addEventListener("click", () =>
  perform(() => call("act", { fingerprint: state.page.fingerprint }), "Executing the choice…"),
);
$("auto").addEventListener("click", () => perform(runAutomatically, "Running the browser…"));
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
    new Blob([JSON.stringify({ ...rest, page: { ...page, screenshot: undefined } }, null, 2)], {
      type: "application/json",
    }),
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
    $(`${kind}-input-price`).value = settings[kind].pricing?.inputUsdPerMillion ?? "";
    $(`${kind}-output-price`).value = settings[kind].pricing?.outputUsdPerMillion ?? "";
  }
  $("model-tag").textContent = settings.decision.model || "Configure your models";
}
$("settings-form").addEventListener("submit", (event) => {
  event.preventDefault();
  perform(async () => {
    const body = {};
    for (const kind of ["decision", "text"]) {
      body[kind] = { baseUrl: $(`${kind}-base`).value, model: $(`${kind}-model`).value };
      const input = $(`${kind}-input-price`).value,
        output = $(`${kind}-output-price`).value;
      if (Boolean(input) !== Boolean(output))
        throw Error("Enter both token prices, or leave both blank for unknown.");
      body[kind].pricing =
        input && output
          ? { inputUsdPerMillion: Number(input), outputUsdPerMillion: Number(output) }
          : null;
      if ($(`${kind}-clear`).checked) body[kind].apiKey = "";
      else if ($(`${kind}-key`).value) body[kind].apiKey = $(`${kind}-key`).value;
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
    $("settings-status").textContent = "Saved · applies to the next request";
    applyState(await fetch("/api/state").then((r) => r.json()));
  }, "Saving model settings…");
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
    $("model-settings").open = !(settings.decision.model && settings.text.model);
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

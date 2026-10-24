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
let pointerPose = null;
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

const jsonToken =
  /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b|[{}[\],:]/g;

/** Format whitespace without rounding numbers, reordering keys or decoding escapes. */
function prettyJSON(source) {
  JSON.parse(source);
  const tokens = [...source.matchAll(jsonToken)].map((match) => match[0]);
  let result = "",
    depth = 0;
  const newline = () => "\n" + "  ".repeat(depth);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "{" || token === "[") {
      result += token;
      depth++;
      if (tokens[i + 1] !== "}" && tokens[i + 1] !== "]") result += newline();
    } else if (token === "}" || token === "]") {
      depth--;
      if (tokens[i - 1] !== "{" && tokens[i - 1] !== "[") result += newline();
      result += token;
    } else if (token === ",") result += "," + newline();
    else result += token === ":" ? ": " : token;
  }
  return result;
}

/** Paint JSON as text nodes; pasted markup must never become active HTML. */
function highlightJSON(source) {
  const fragment = document.createDocumentFragment();
  let offset = 0;
  for (const match of source.matchAll(jsonToken)) {
    fragment.append(document.createTextNode(source.slice(offset, match.index)));
    const value = match[0],
      span = document.createElement("span");
    const kind =
      value[0] === '"'
        ? /^\s*:/.test(source.slice(match.index + value.length))
          ? "key"
          : "string"
        : /^-?\d/.test(value)
          ? "number"
          : /^(true|false|null)$/.test(value)
            ? "literal"
            : "punctuation";
    span.className = `json-${kind}`;
    span.textContent = value;
    fragment.append(span);
    offset = match.index + value.length;
  }
  fragment.append(document.createTextNode(source.slice(offset) + "\n"));
  return fragment;
}

/** Enhance optional JSON fields while retaining native textarea editing and form validation. */
function enhanceJSONField(input) {
  const editor = document.createElement("div"),
    toolbar = document.createElement("div");
  const badge = document.createElement("span"),
    format = document.createElement("button");
  const surface = document.createElement("div"),
    highlight = document.createElement("pre");
  const status = document.createElement("span");
  editor.className = "json-editor";
  toolbar.className = "json-editor-toolbar";
  badge.className = "json-editor-badge";
  badge.textContent = "JSON";
  format.type = "button";
  format.className = "json-format";
  format.textContent = "Format";
  format.setAttribute("aria-label", `Format ${input.dataset.jsonEditor} JSON`);
  format.title = "Format JSON · ⌘/Ctrl + Shift + F";
  surface.className = "json-editor-surface";
  highlight.className = "json-highlight";
  highlight.setAttribute("aria-hidden", "true");
  status.className = "json-editor-status";
  status.id = `${input.id}-status`;
  status.setAttribute("role", "status");
  input.setAttribute(
    "aria-describedby",
    [input.getAttribute("aria-describedby"), status.id]
      .filter(Boolean)
      .join(" "),
  );
  input.setAttribute("aria-keyshortcuts", "Control+Shift+F Meta+Shift+F");
  input.spellcheck = false;
  input.autocapitalize = "off";
  input.wrap = "off";
  input.dir = "ltr";
  try {
    input.placeholder = prettyJSON(input.placeholder);
  } catch {}
  input.rows = Math.min(
    14,
    Math.max(5, (input.value || input.placeholder).split("\n").length),
  );
  input.before(editor);
  toolbar.append(badge, format);
  surface.append(highlight, input);
  editor.append(toolbar, surface, status);
  const syncScroll = () => {
    highlight.scrollTop = input.scrollTop;
    highlight.scrollLeft = input.scrollLeft;
  };
  const update = () => {
    const source = input.value,
      blank = !source.trim(),
      large = source.length > 64000;
    let error = "";
    if (!blank) {
      try {
        JSON.parse(source);
      } catch (cause) {
        error = `Invalid JSON: ${cause.message.slice(0, 160)}`;
      }
    }
    input.setCustomValidity(error);
    input.setAttribute("aria-invalid", String(Boolean(error)));
    editor.dataset.state = error ? "invalid" : blank ? "empty" : "valid";
    editor.dataset.highlight = String(!large);
    editor.dataset.example = String(!source);
    highlight.replaceChildren(
      large
        ? document.createTextNode("")
        : highlightJSON(source || input.placeholder),
    );
    format.disabled = blank || Boolean(error) || large;
    status.textContent =
      error ||
      (large
        ? "Syntax preview paused above 64 KB."
        : blank
          ? source
            ? "Optional field"
            : "Example only · optional field"
          : "Valid JSON");
    syncScroll();
  };
  const prettify = () => {
    if (format.disabled) return;
    input.value = prettyJSON(input.value);
    input.rows = Math.min(18, Math.max(5, input.value.split("\n").length));
    input.focus();
    input.setSelectionRange(0, 0);
    input.scrollTop = input.scrollLeft = 0;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    status.textContent = "Formatted · 2-space indentation";
  };
  input.addEventListener("input", update);
  input.addEventListener("scroll", syncScroll);
  input.addEventListener("keydown", (event) => {
    if (
      (event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      event.key.toLowerCase() === "f"
    ) {
      event.preventDefault();
      prettify();
    }
  });
  input.addEventListener("invalid", () => {
    input.closest("details").open = true;
  });
  format.addEventListener("click", prettify);
  update();
}
document
  .querySelectorAll("textarea[data-json-editor]")
  .forEach(enhanceJSONField);

const secretCards = () => [...$("secret-list").children];
const secretInput = (card, field) =>
  card.querySelector(`[data-secret-field="${field}"] input`);
let nextSecretId = 0;

/** Match the vault's site boundary, accepting the equivalent trailing root slash. */
function secretOrigin(value) {
  try {
    const url = new URL(value.trim());
    if (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    )
      return url.origin;
  } catch {}
  return null;
}

/** Validate bindings without copying private values into markup, errors or storage. */
function validateSecretForm() {
  const names = new Map(),
    destinations = new Map();
  for (const [index, card] of secretCards().entries()) {
    const name = secretInput(card, "name"),
      value = secretInput(card, "value");
    const origin = secretInput(card, "origin"),
      label = secretInput(card, "label");
    for (const input of card.querySelectorAll("input"))
      input.setCustomValidity("");
    if (name.value && !/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(name.value))
      name.setCustomValidity(
        "Use 1–32 characters: a letter first, then letters, numbers, _ or -.",
      );
    if (value.value.includes("{{secret:") || value.value.length > 2000)
      value.setCustomValidity(
        "Enter the actual private value, up to 2,000 characters, without a secret reference.",
      );
    const site = secretOrigin(origin.value);
    if (origin.value && !site)
      origin.setCustomValidity(
        "Use an HTTP(S) site address without a path, query, fragment or login details.",
      );
    if (label.value && (!label.value.trim() || label.value.length > 200))
      label.setCustomValidity(
        "Enter the exact field label, up to 200 characters.",
      );
    const destination =
      site && label.value.trim()
        ? JSON.stringify([site, label.value.trim()])
        : "";
    for (const [key, input, seen, message] of [
      [
        name.value,
        name,
        names,
        "Choose a different reference name; this one is already used.",
      ],
      [
        destination,
        label,
        destinations,
        "Another secret already uses this site and destination field.",
      ],
    ]) {
      if (!key) continue;
      if (seen.has(key)) {
        input.setCustomValidity(message);
        seen.get(key).setCustomValidity(message);
      } else seen.set(key, input);
    }
    card.querySelector("h4").textContent =
      `Secret ${String(index + 1).padStart(2, "0")}`;
    card
      .querySelector("[data-secret-action=remove]")
      .setAttribute("aria-label", `Remove secret ${index + 1}`);
    card
      .querySelector("[data-secret-action=reveal]")
      .setAttribute(
        "aria-label",
        `${value.type === "password" ? "Show" : "Hide"} secret ${index + 1} value`,
      );
    card.querySelector(".secret-reference code").textContent =
      `{{secret:${/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(name.value) ? name.value : "name"}}}`;
  }
  for (const card of secretCards()) {
    for (const input of card.querySelectorAll("input")) {
      const error = input
        .closest(".secret-field")
        .querySelector(".secret-error");
      const invalid = input.dataset.touched === "true" && !input.validity.valid;
      input.setAttribute("aria-invalid", String(invalid));
      error.hidden = !invalid;
      error.textContent = invalid ? input.validationMessage : "";
    }
  }
  const count = secretCards().length;
  $("secret-empty").hidden = count > 0;
  const summary = count
    ? `${count} ${count === 1 ? "secret" : "secrets"} · ${20 - count} available`
    : "No secrets added";
  if ($("secret-count").textContent !== summary)
    $("secret-count").textContent = summary;
  $("add-secret").disabled = Boolean(busy || state?.server_busy || count >= 20);
}

/** Add an accessible binding card; private values exist only in the native input. */
function addSecret() {
  if (busy || state?.server_busy || secretCards().length >= 20) return;
  const card = $("secret-template").content.firstElementChild.cloneNode(true);
  const id = ++nextSecretId;
  card.querySelector("h4").id = `secret-${id}-title`;
  card.setAttribute("aria-labelledby", `secret-${id}-title`);
  for (const field of card.querySelectorAll(".secret-field")) {
    const input = field.querySelector("input"),
      hint = field.querySelector(".secret-hint");
    const error = field.querySelector(".secret-error");
    input.id = `secret-${id}-${field.dataset.secretField}`;
    hint.id = `${input.id}-hint`;
    error.id = `${input.id}-error`;
    field.querySelector("label").htmlFor = input.id;
    input.setAttribute("aria-describedby", `${hint.id} ${error.id}`);
  }
  card
    .querySelector("[data-secret-action=reveal]")
    .setAttribute("aria-controls", secretInput(card, "value").id);
  $("secret-list").append(card);
  validateSecretForm();
  secretInput(card, "name").focus();
}

/** Serialize at submission time only; keep references out of the request when empty. */
function readSecrets() {
  return Object.fromEntries(
    secretCards().map((card) => [
      secretInput(card, "name").value,
      {
        value: secretInput(card, "value").value,
        origin: secretOrigin(secretInput(card, "origin").value),
        label: secretInput(card, "label").value.trim(),
      },
    ]),
  );
}

/** Clear successful submissions so a later task cannot accidentally reuse a value. */
function clearSecrets() {
  for (const card of secretCards()) secretInput(card, "value").value = "";
  $("secret-list").replaceChildren();
  validateSecretForm();
}

$("add-secret").addEventListener("click", addSecret);
$("secret-bindings").addEventListener("input", (event) => {
  if (event.target.tagName !== "INPUT") return;
  event.target.dataset.touched = "true";
  validateSecretForm();
});
$("secret-bindings").addEventListener(
  "invalid",
  (event) => {
    $("secret-bindings").closest("details").open = true;
    event.target.dataset.touched = "true";
    validateSecretForm();
  },
  true,
);
$("secret-list").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-secret-action]");
  if (!button || button.disabled) return;
  const card = button.closest(".secret-card"),
    value = secretInput(card, "value");
  if (button.dataset.secretAction === "remove") {
    const next = card.nextElementSibling || card.previousElementSibling;
    value.value = "";
    card.remove();
    validateSecretForm();
    (next ? secretInput(next, "name") : $("add-secret")).focus();
  } else {
    const reveal = value.type === "password";
    value.type = reveal ? "text" : "password";
    button.textContent = reveal ? "Hide" : "Show";
    button.setAttribute("aria-pressed", String(reveal));
    validateSecretForm();
  }
});

const siteDataCards = () => [...$("site-data-list").children];
const siteField = (card, name) =>
  card.querySelector(`[data-site-field="${name}"]`);
let nextSiteDataId = 0;

/** Keep empty strings distinct from deletion, and preserve literal storage keys. */
function readSiteData() {
  if (!siteDataCards().length) return undefined;
  const data = {
    cookies: [],
    localStorage: Object.create(null),
    sessionStorage: Object.create(null),
  };
  for (const card of siteDataCards()) {
    const origin = secretOrigin(siteField(card, "origin").value);
    const name = siteField(card, "name").value;
    const value = siteField(card, "delete").checked
      ? null
      : siteField(card, "value").value;
    if (card.dataset.kind === "cookies") {
      const secure = siteField(card, "secure").value;
      const expires = siteField(card, "expires").value;
      data.cookies.push({
        origin,
        name,
        value,
        path: siteField(card, "path").value,
        httpOnly: siteField(card, "httpOnly").checked,
        sameSite: siteField(card, "sameSite").value,
        ...(secure ? { secure: secure === "true" } : {}),
        ...(expires ? { expires: Number(expires) } : {}),
      });
    } else
      (data[card.dataset.kind][origin] ??= Object.create(null))[name] = value;
  }
  return data;
}

/** Validate scope and duplicates locally before sending any browser setup request. */
function validateSiteDataForm() {
  const seen = new Map();
  const working = Boolean(busy || state?.server_busy);
  for (const [index, card] of siteDataCards().entries()) {
    const cookie = card.dataset.kind === "cookies";
    const removing = siteField(card, "delete").checked;
    const origin = siteField(card, "origin"),
      name = siteField(card, "name"),
      value = siteField(card, "value");
    for (const input of card.querySelectorAll("input, select")) {
      input.setCustomValidity("");
      input.disabled =
        working ||
        (!cookie && !!input.closest(".site-cookie-options")) ||
        (removing && input === value);
    }
    for (const button of card.querySelectorAll("button"))
      button.disabled = working;
    card.dataset.deleting = String(removing);
    const site = secretOrigin(origin.value);
    if (origin.value && !site)
      origin.setCustomValidity(
        "Enter an exact HTTP(S) origin without a path, query or login details.",
      );
    if (
      cookie &&
      name.value &&
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name.value)
    )
      name.setCustomValidity(
        "Use an HTTP token for the cookie name; no spaces or separators.",
      );
    if (
      cookie &&
      !removing &&
      (!/^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/.test(value.value) ||
        name.value.length + value.value.length > 4096)
    )
      value.setCustomValidity(
        "Use a URL-encoded cookie value. Name and value must fit in 4,096 bytes.",
      );
    const path = siteField(card, "path");
    if (
      cookie &&
      (!path.value.startsWith("/") || /[\x00-\x20\x7f;]/.test(path.value))
    )
      path.setCustomValidity(
        "Cookie paths must start with / and contain no spaces or semicolons.",
      );
    if (cookie && site && !removing) {
      const secure =
        siteField(card, "secure").value === "true" ||
        (!siteField(card, "secure").value && site.startsWith("https:"));
      if (
        (secure && !site.startsWith("https:")) ||
        (siteField(card, "sameSite").value === "None" && !secure) ||
        (/^__(Secure|Host|Http)-/.test(name.value) && !secure) ||
        (name.value.startsWith("__Host-") && path.value !== "/") ||
        (/^__(Http|Host-Http)-/.test(name.value) &&
          !siteField(card, "httpOnly").checked)
      )
        name.setCustomValidity(
          "Check cookie security: Secure needs HTTPS, SameSite=None needs Secure, and __Host-/__Http- prefixes need their required flags.",
        );
    }
    if (site && name.value) {
      const key = JSON.stringify([
        card.dataset.kind,
        cookie ? new URL(site).hostname : site,
        cookie ? path.value : "",
        name.value,
      ]);
      if (seen.has(key)) {
        name.setCustomValidity(
          "This site, type and name already have an entry.",
        );
        seen.get(key).setCustomValidity(name.validationMessage);
      } else seen.set(key, name);
    }
    const label = `${cookie ? "Cookie" : card.dataset.kind} ${String(index + 1).padStart(2, "0")}`;
    card.querySelector("h4").textContent = label;
    card
      .querySelector('[data-site-action="remove"]')
      .setAttribute("aria-label", `Remove ${label}`);
    card
      .querySelector('[data-site-action="reveal"]')
      .setAttribute(
        "aria-label",
        `${value.type === "password" ? "Show" : "Hide"} ${label} value`,
      );
  }
  for (const card of siteDataCards()) {
    const invalid = [...card.querySelectorAll("input, select")].find(
      (input) => !input.disabled && !input.validity.valid,
    );
    const error = card.querySelector(":scope > .secret-error");
    error.hidden = !invalid || !card.dataset.touched;
    error.textContent = error.hidden ? "" : invalid.validationMessage;
    for (const input of card.querySelectorAll("input, select"))
      input.setAttribute(
        "aria-invalid",
        String(
          !!card.dataset.touched && !input.disabled && !input.validity.valid,
        ),
      );
  }
  const count = siteDataCards().length;
  $("site-data-empty").hidden = count > 0;
  $("site-data-count").textContent = count
    ? `${count} / 100 entries`
    : "No entries added";
  for (const button of document.querySelectorAll("[data-site-add]"))
    button.disabled = working || count >= 100;
}

/** Add an editable entry using native controls; values never enter saved inspector settings. */
$("site-data").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  if (button.dataset.siteAdd) {
    const card =
      $("site-data-template").content.firstElementChild.cloneNode(true);
    card.dataset.kind = button.dataset.siteAdd;
    const id = `site-data-${++nextSiteDataId}`;
    card.querySelector("h4").id = `${id}-title`;
    card.setAttribute("aria-labelledby", `${id}-title`);
    card.querySelector(":scope > .secret-error").id = `${id}-error`;
    for (const input of card.querySelectorAll("input, select"))
      input.setAttribute("aria-describedby", `${id}-error`);
    siteField(card, "value").id = `${id}-value`;
    card.querySelector("[data-site-value-label]").htmlFor = `${id}-value`;
    card
      .querySelector('[data-site-action="reveal"]')
      .setAttribute("aria-controls", `${id}-value`);
    card.querySelector(".site-cookie-options").hidden =
      card.dataset.kind !== "cookies";
    $("site-data-list").append(card);
    validateSiteDataForm();
    siteField(card, "origin").focus();
  } else if (button.dataset.siteAction) {
    const card = button.closest(".site-data-card"),
      value = siteField(card, "value");
    if (button.dataset.siteAction === "remove") {
      value.value = "";
      const next = card.nextElementSibling || card.previousElementSibling;
      card.remove();
      (next
        ? siteField(next, "origin")
        : document.querySelector("[data-site-add]")
      ).focus();
    } else {
      const reveal = value.type === "password";
      value.type = reveal ? "text" : "password";
      button.textContent = reveal ? "Hide" : "Show";
      button.setAttribute("aria-pressed", String(reveal));
    }
    validateSiteDataForm();
  }
});
for (const event of ["input", "change", "invalid"])
  $("site-data").addEventListener(
    event,
    (event) => {
      const card = event.target.closest(".site-data-card");
      if (!card) return;
      card.dataset.touched = "true";
      if (event.type === "invalid") {
        $("site-data").closest("details").open = true;
        if (event.target.closest(".site-cookie-options"))
          event.target.closest(".site-cookie-options").open = true;
      }
      validateSiteDataForm();
    },
    true,
  );

/** Discard submitted drafts so a subsequent task cannot silently reuse session data. */
function clearSiteData() {
  for (const card of siteDataCards()) siteField(card, "value").value = "";
  $("site-data-list").replaceChildren();
  validateSiteDataForm();
}

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
  for (const input of $("secret-bindings").querySelectorAll("input, button"))
    input.disabled = working;
  $("add-secret").disabled = Boolean(working || secretCards().length >= 20);
  validateSiteDataForm();
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

/** Keep the visible hotspot aligned with the browser while animating only its decoration. */
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
  if (node.hidden) {
    pointerPose = null;
    return;
  }
  const viewport = $("viewport");
  const width = viewport.clientWidth,
    height = viewport.clientHeight;
  // Screenshots are contained, so account for letterboxing as well as responsive scaling.
  const scale = Math.min(width / pointer.w, height / pointer.h);
  const x = (width - pointer.w * scale) / 2 + pointer.x * scale;
  const y = (height - pointer.h * scale) / 2 + pointer.y * scale;
  const previous =
    pointerPose?.run_id === pointer.run_id && pointerPose.url === pointer.url
      ? pointerPose
      : null;
  const moving = pointer.phase === "move" && previous !== null;
  let angle = previous?.angle ?? 0,
    squeeze = 1;
  if (moving) {
    const dx = pointer.x - previous.x,
      dy = pointer.y - previous.y;
    const distance = Math.hypot(dx, dy);
    if (distance > 0.5) {
      const direction = (Math.atan2(dy, dx) * 180) / Math.PI + 135;
      angle += ((((direction - angle + 540) % 360) + 360) % 360) - 180;
      squeeze = 1 - Math.min(distance / 600, 0.14);
    }
  } else angle = 0;
  pointerPose = { ...pointer, angle };
  node.dataset.moving = moving;
  node.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  node.style.setProperty("--pointer-angle", `${angle}deg`);
  node.style.setProperty("--pointer-squeeze", squeeze);
  const right = x > width / 2;
  node.style.setProperty(
    "--pointer-label-width",
    `${Math.max(0, Math.min(190, (right ? x : width - x) - 28))}px`,
  );
  node.dataset.phase = pointer.phase;
  node.dataset.edge = right ? "right" : "left";
  node.dataset.bottom = y > height - 80;
  node.dataset.direction = pointer.deltaY < 0 ? "up" : "down";
  $("pointer-status").textContent =
    pointer.phase === "scroll"
      ? pointer.deltaY < 0
        ? "Scroll up"
        : "Scroll down"
      : {
          move: "Moving",
          press: "Clicking",
          release: "Clicked",
          idle: "Ready",
        }[pointer.phase];
  $("pointer-target").textContent = pointer.label;
}

new ResizeObserver(renderPointer).observe($("viewport"));
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
  validateSecretForm();
  validateSiteDataForm();
  if (!$("task-form").reportValidity()) return;
  for (const card of siteDataCards()) {
    siteField(card, "value").type = "password";
    const button = card.querySelector('[data-site-action="reveal"]');
    button.textContent = "Show";
    button.setAttribute("aria-pressed", "false");
  }
  for (const card of secretCards()) {
    secretInput(card, "value").type = "password";
    const button = card.querySelector("[data-secret-action=reveal]");
    button.textContent = "Show";
    button.setAttribute("aria-pressed", "false");
  }
  validateSecretForm();
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
      ...(secretCards().length ? { secrets: readSecrets() } : {}),
      ...(siteDataCards().length ? { siteData: readSiteData() } : {}),
      ...($("output-schema").value.trim()
        ? { outputSchema: JSON.parse($("output-schema").value) }
        : {}),
      ...($("workflow-name").value.trim()
        ? {
            workflow: {
              name: $("workflow-name").value.trim(),
              parameters: JSON.parse($("workflow-params").value.trim() || "{}"),
            },
          }
        : {}),
    });
    clearSecrets();
    clearSiteData();
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

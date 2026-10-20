import { object } from "./config";
import { CURRENT_STEP, NEXT_ACTION, TARGET, TEXT_VALUE } from "./questions";
import type {
  Action,
  AgentMemory,
  ChoiceAnswer,
  CompletionCheck,
  Decision,
  DecisionRequest,
  ElementView,
  Endpoint,
  HistoryEntry,
  ModelCall,
  ModelObserver,
  Operation,
  PageState,
  SettingsReader,
  TargetOperation,
} from "./types";

class ProviderFailure extends Error {
  constructor(
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}
const transientStatus = (status: number) =>
  [408, 425, 429, 500, 502, 503, 504, 529].includes(status);

export async function postJson(
  endpoint: Endpoint,
  path: string,
  body: unknown,
  observe?: ModelObserver,
): Promise<Record<string, unknown>> {
  if (!endpoint.model)
    throw new Error(
      "Set the model identifier in Settings or .env before running.",
    );
  const hostname = URL.parse(endpoint.baseUrl)?.hostname ?? "";
  const loopback =
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname);
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = performance.now();
    const pricing = endpoint.pricing ? { ...endpoint.pricing } : undefined;
    let response: Response | undefined;
    let result: unknown;
    let outcome: ModelCall["outcome"] = "network_error";
    try {
      try {
        response = await fetch(`${endpoint.baseUrl}/${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(endpoint.apiKey
              ? { Authorization: `Bearer ${endpoint.apiKey}` }
              : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
          redirect: "manual",
          proxy: loopback ? false : undefined,
        });
      } catch {
        throw new ProviderFailure(
          "Model connection failed or timed out; no browser action executed.",
          true,
        );
      }
      outcome = "http_error";
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new ProviderFailure(
          "Model connection failed: redirects are not allowed; no browser action executed.",
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProviderFailure(
          `Model provider returned HTTP ${response.status}; no browser action executed.`,
          transientStatus(response.status),
        );
      }
      outcome = "invalid_response";
      try {
        result = await response.json();
      } catch {
        throw new ProviderFailure(
          "Model provider returned invalid JSON.",
          true,
        );
      }
      if (!object(result))
        throw new ProviderFailure(
          "Model provider returned an invalid response.",
          true,
        );
      if (result.error !== undefined && result.error !== null) {
        outcome = "provider_error";
        const error = object(result.error) ? result.error : {};
        const retryable =
          transientStatus(Number(error.status ?? error.code)) ||
          [
            "rate_limit_exceeded",
            "rate_limit_error",
            "overloaded",
            "overloaded_error",
            "server_error",
            "internal_server_error",
            "temporarily_unavailable",
            "service_unavailable",
          ].includes(String(error.code ?? error.type));
        throw new ProviderFailure(
          "Model provider returned an error response; no browser action executed.",
          retryable,
        );
      }
      outcome = "response";
      return result;
    } catch (error) {
      if (
        !(error instanceof ProviderFailure) ||
        !error.retryable ||
        attempt === 2
      )
        throw error;
    } finally {
      try {
        observe?.({
          model:
            object(result) && typeof result.model === "string"
              ? result.model
              : endpoint.model,
          endpoint: new URL(endpoint.baseUrl).origin,
          latency_ms: Math.round(performance.now() - started),
          usage: object(result) && object(result.usage) ? result.usage : {},
          outcome,
          http_status: response?.status,
          ...(pricing ? { pricing } : {}),
        });
      } catch {
        /* Telemetry cannot change request execution. */
      }
    }
    await Bun.sleep(250 * 2 ** attempt);
  }
  throw new Error("Model unavailable.");
}

export function validateChoice(
  answer: unknown,
  ids: Record<string, unknown>,
): ChoiceAnswer {
  const invalid = () =>
    new Error("Invalid typed decision response; no action executed.");
  if (
    !object(answer) ||
    typeof answer.choice !== "string" ||
    !Object.hasOwn(ids, answer.choice) ||
    !object(answer.probabilities)
  )
    throw invalid();
  const probabilities = answer.probabilities;
  const numbers = [...Object.values(probabilities), answer.confidence];
  if (
    Object.keys(probabilities).length !== Object.keys(ids).length ||
    Object.keys(ids).some((id) => !Object.hasOwn(probabilities, id)) ||
    numbers.some(
      (n) => typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1,
    )
  )
    throw invalid();
  const values = Object.values(probabilities) as number[];
  if (
    Math.abs(values.reduce((a, b) => a + b, 0) - 1) >= 0.02 ||
    (probabilities[answer.choice] as number) < Math.max(...values) - 1e-6
  )
    throw invalid();
  return answer as unknown as ChoiceAnswer;
}

export async function checkModels(readSettings: SettingsReader) {
  return Promise.all(
    (["decision", "text"] as const).map(async (role) => {
      const started = performance.now();
      const endpoint = (await readSettings())[role];
      let message = "Ready",
        ok = true;
      try {
        if (role === "decision") {
          const criteria = { ready: null, not_ready: null };
          const result = await postJson(endpoint, "systemone", {
            model: endpoint.model,
            state: "Connection check. The expected answer is ready.",
            questions: {
              readiness: {
                type: "choice",
                instructions: "Choose ready.",
                criteria,
              },
            },
          });
          if (
            !object(result.answers) ||
            validateChoice(result.answers.readiness, criteria).choice !==
              "ready"
          )
            throw new Error(
              "Expected a valid ready choice from /systemone. Check the decision model and server extension.",
            );
        } else {
          const result = await postJson(endpoint, "chat/completions", {
            model: endpoint.model,
            temperature: 0,
            max_tokens: 32,
            response_format: {
              type: "json_schema",
              json_schema: {
                name: "connection_check",
                strict: true,
                schema: {
                  type: "object",
                  additionalProperties: false,
                  required: ["ready", "text"],
                  properties: {
                    ready: { type: "boolean" },
                    text: { anyOf: [{ type: "string" }, { type: "null" }] },
                  },
                },
              },
            },
            messages: [
              {
                role: "user",
                content:
                  'Connection check. Return only {"ready":true,"text":null}.',
              },
            ],
          });
          const first = Array.isArray(result.choices)
            ? result.choices[0]
            : undefined;
          let value: unknown;
          try {
            value =
              object(first) &&
              object(first.message) &&
              typeof first.message.content === "string"
                ? JSON.parse(first.message.content)
                : null;
          } catch {
            value = null;
          }
          if (
            !object(value) ||
            value.ready !== true ||
            value.text !== null ||
            Object.keys(value).length !== 2
          )
            throw new Error(
              "The chat helper did not return the required JSON schema. Select a chat model with structured output support.",
            );
        }
      } catch (error) {
        ok = false;
        message =
          error instanceof Error ? error.message : "Connection check failed.";
      }
      return {
        role,
        model: endpoint.model,
        endpoint: endpoint.baseUrl,
        ok,
        message,
        latency_ms: Math.round(performance.now() - started),
      };
    }),
  );
}

export function actionSpace(actions: Action[]) {
  const elements: ElementView[] = [];
  const indices = new Map<string, ElementView>();
  const targets: Partial<Record<TargetOperation, Record<string, Action>>> = {};
  const controls: Partial<Record<Operation, Action>> = {};
  const operations = {
    click: "CLICK",
    fill: "TYPE_TEXT",
    select: "SELECT",
  } as const;
  for (const action of actions) {
    if (action.kind === "scroll" || action.kind === "wait") {
      controls[
        action.kind === "wait"
          ? "WAIT"
          : action.delta < 0
            ? "SCROLL_UP"
            : "SCROLL_DOWN"
      ] = action;
      continue;
    }
    const identity = `${action.node}:${action.scroll_delta ?? ""}`;
    let element = indices.get(identity);
    if (!element) {
      element = {
        index: String(elements.length + 1),
        label: action.label.split(" → ")[0]!,
        secret_key: action.secret_key,
        role: action.role,
        ref: action.ref,
        scope: action.scope || undefined,
        context: action.context,
        href: action.href,
        form_ref: action.form_ref,
        input_type: action.input_type,
        constraints: action.constraints,
        value: action.kind === "select" ? action.current_value : action.value,
        value_date: action.value_date,
        checked: action.checked,
        selected: action.selected,
        expanded: action.expanded,
        has_popup: action.has_popup,
        popup_owner: action.popup_owner,
        submits_form: action.submits_form,
        operations: [],
      };
      if (action.kind === "select") element.options = [];
      elements.push(element);
      indices.set(identity, element);
    }
    const operation = operations[action.kind];
    const group = (targets[operation] ??= {});
    if (!element.operations.includes(operation))
      element.operations.push(operation);
    let target = element.index;
    if (action.kind === "select") {
      const options = (element.options ??= []);
      target = `${target}:${options.length + 1}`;
      options.push({ index: target, label: action.label, value: action.value });
    }
    group[target] = action;
  }
  return { elements, targets, controls };
}

export async function choose(
  page: PageState,
  goal: string,
  history: HistoryEntry[],
  endpoint: Endpoint,
  allowDone = true,
  observe?: ModelObserver,
  checks?: CompletionCheck[],
  sinceAction = 0,
  memory?: AgentMemory,
): Promise<Decision> {
  const { elements, targets, controls } = actionSpace(page.actions);
  const controlChecks = checks?.filter((check) => "label" in check) ?? [];
  const requiredForms = new Set(
    elements
      .filter(
        (element) =>
          element.form_ref &&
          controlChecks.some(
            (check) =>
              check.kind === "value" &&
              (check.ref
                ? check.ref === element.ref
                : check.label === element.label),
          ),
      )
      .map((element) => element.form_ref),
  );
  const missingControls: string[] = [];
  if (
    controlChecks.length ||
    checks?.some(
      (check) =>
        check.kind === "text" ||
        (check.kind === "url" && check.includes.startsWith("#")),
    )
  ) {
    const allowed = new Set<string>();
    if (!controlChecks.length)
      for (const action of Object.values(targets.CLICK ?? {})) {
        if (!("href" in action) || !action.href) continue;
        const destination = new URL(action.href);
        if (
          destination.hash &&
          destination.href.split("#")[0] === page.url.split("#")[0] &&
          checks?.some(
            (check) =>
              (check.kind === "text" &&
                check.includes.trim() === action.label.trim()) ||
              (check.kind === "url" && check.includes === destination.hash),
          )
        )
          allowed.add(action.id);
      }
    for (const check of controlChecks) {
      if (
        check.kind === "action" &&
        history
          .slice(sinceAction)
          .some(
            (entry) =>
              entry.kind === "click" &&
              (check.ref
                ? entry.ref === check.ref
                : entry.action.trim() === check.label.trim()) &&
              (!check.scope || entry.scope === check.scope),
          )
      )
        continue;
      const matches = elements.filter(
        (element) =>
          (check.ref
            ? element.ref === check.ref
            : element.label.trim().replace(/\s+/g, " ") ===
              check.label.trim().replace(/\s+/g, " ")) &&
          (check.kind !== "value" ||
            element.role === "combobox" ||
            element.operations.some(
              (op) => op === "TYPE_TEXT" || op === "SELECT",
            )) &&
          (check.kind !== "action" ||
            !element.operations.some(
              (op) => op === "TYPE_TEXT" || op === "SELECT",
            )) &&
          (!check.scope ||
            element.scope?.trim().replace(/\s+/g, " ") ===
              check.scope.trim().replace(/\s+/g, " ")) &&
          (check.kind !== "action" ||
            !requiredForms.size ||
            requiredForms.has(element.form_ref)),
      );
      const popup =
        check.kind === "value" && check.ref
          ? elements.filter((element) => element.popup_owner === check.ref)
          : [];
      let popupElements = popup;
      let popupOperation: TargetOperation | undefined;
      // shortcut: English empty-result notices; extend when other locales are supported.
      const noResults = popup.some((element) =>
        /\bno (?:matching (?:locations|results|options)|results|matches)(?: found)?\b/i.test(
          element.context ?? "",
        ),
      );
      if (popup.length) {
        delete controls.SCROLL_DOWN;
        delete controls.SCROLL_UP;
        if (noResults) delete controls.WAIT;
      }
      if (popup.length && check.kind === "value") {
        const words = (text: string) =>
          text
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, " ")
            .trim();
        const options = popup.filter((element) =>
          ["option", "menuitem", "menuitemradio", "gridcell"].includes(
            element.role,
          ),
        );
        const date = /^\d{4}-\d{2}-\d{2}$/.test(check.equals)
          ? new Date(`${check.equals}T12:00:00`).toLocaleDateString("en-US", {
              month: "long",
              day: "numeric",
              year: "numeric",
            })
          : "";
        const desired = words(date || check.equals);
        const identifier = check.equals.match(/\(([A-Z0-9]{2,8})\)$/)?.[1];
        const matching = options.filter((element) =>
          date
            ? words(element.label).includes(desired)
            : identifier
              ? new RegExp(
                  `(?<![\\p{L}\\p{N}])${identifier}(?![\\p{L}\\p{N}])`,
                  "u",
                ).test(element.label)
              : words(element.label) === desired ||
                words(element.label).startsWith(desired + " "),
        );
        const editors = popup.filter((element) =>
          element.operations.includes("TYPE_TEXT"),
        );
        const sameLabel = editors.filter(
          (element) => words(element.label) === words(check.label),
        );
        const inputs = sameLabel.length
          ? sameLabel
          : editors.length === 1
            ? editors
            : [];
        const queried = inputs.some((element) =>
          history.some(
            (entry) =>
              element.ref &&
              entry.kind === "fill" &&
              entry.ref === element.ref &&
              entry.text === element.value,
          ),
        );
        if (
          matching.length &&
          !matching.some((element) => element.selected === "true")
        ) {
          popupElements = matching;
          popupOperation = "CLICK";
        } else if (matching.some((element) => element.selected === "true")) {
          popupElements = popup.filter(
            (element) =>
              element.role === "button" &&
              /^(done|apply|confirm|ok)\b/i.test(element.label),
          );
          popupOperation = "CLICK";
        } else if (
          date &&
          options.some((element) => element.role === "gridcell")
        ) {
          popupElements = popup.filter(
            (element) =>
              element.role === "button" &&
              /^(next|previous|prev|back|forward)\b/i.test(element.label),
          );
          popupOperation = "CLICK";
        } else if (queried && options.length && !date) {
          popupElements = options;
          popupOperation = "CLICK";
        } else if (
          inputs.length &&
          !options.some((element) => element.role === "gridcell")
        ) {
          popupElements = inputs.filter(
            (element) => noResults || element.value !== check.equals,
          );
          popupOperation = "TYPE_TEXT";
        } else {
          popupElements = options.length ? options : popup;
        }
      }
      for (const element of popupElements)
        for (const operation of popupOperation
          ? [popupOperation]
          : element.operations)
          for (const [index, action] of Object.entries(
            targets[operation] ?? {},
          ))
            if (
              index.split(":")[0] === element.index &&
              !(
                operation === "TYPE_TEXT" &&
                !noResults &&
                check.kind === "value" &&
                element.value === check.equals
              )
            )
              allowed.add(action.id);
      if (popup.length) continue;
      if (!matches.length) missingControls.push(check.label);
      if (!matches.length || (matches.length !== 1 && check.kind !== "action"))
        continue;
      for (const element of matches) {
        if (
          (check.kind === "value" &&
            (element.value === check.equals ||
              element.value_date === check.equals) &&
            element.expanded !== "true") ||
          (check.kind === "checked" &&
            element.checked === String(check.equals)) ||
          (check.kind === "expanded" &&
            element.expanded === String(check.equals))
        )
          continue;
        const operations: TargetOperation[] =
          check.kind === "value"
            ? element.has_popup && element.expanded !== "true"
              ? ["CLICK"]
              : ["TYPE_TEXT", "SELECT", "CLICK"]
            : ["CLICK"];
        for (const operation of operations)
          for (const [index, action] of Object.entries(
            targets[operation] ?? {},
          ))
            if (index.split(":")[0] === element.index) allowed.add(action.id);
      }
    }
    for (const operation of Object.keys(targets) as TargetOperation[]) {
      const candidates = Object.fromEntries(
        Object.entries(targets[operation]!).filter(
          ([, action]) =>
            allowed.has(action.id) ||
            ((!controlChecks.length || missingControls.length > 0) &&
              "node" in action &&
              Boolean(action.context_id || action.scroll_delta)),
        ),
      );
      if (Object.keys(candidates).length) targets[operation] = candidates;
      else delete targets[operation];
    }
  }
  const labels = {
    CLICK:
      "Click an element, button, menu option, autocomplete suggestion, or calendar day.",
    TYPE_TEXT:
      "Enter or replace text in an editable field. A small LLM supplies the value from the goal.",
    SELECT: "Select an observed dropdown value.",
  };
  if (page.readiness === "loading")
    for (const operation of Object.keys(targets) as TargetOperation[]) {
      const native = Object.fromEntries(
        Object.entries(targets[operation]!).filter(
          ([, action]) =>
            operation === "CLICK" &&
            "native_navigation" in action &&
            action.native_navigation,
        ),
      );
      if (Object.keys(native).length) targets[operation] = native;
      else delete targets[operation];
    }
  const avoided = new Set(
    memory?.lessons
      .filter((lesson) => lesson.avoid)
      .map((lesson) => lesson.choice),
  );
  for (const operation of Object.keys(targets) as TargetOperation[]) {
    const candidates = Object.fromEntries(
      Object.entries(targets[operation]!).filter(
        ([, action]) => !avoided.has(action.id),
      ),
    );
    if (Object.keys(candidates).length) targets[operation] = candidates;
    else delete targets[operation];
  }
  for (const [operation, action] of Object.entries(controls))
    if (avoided.has(action.id)) delete controls[operation as Operation];
  const operations: Record<string, string> = {};
  for (const operation of Object.keys(targets) as TargetOperation[])
    operations[operation] = labels[operation];
  const recent = history.slice(-3);
  const exhaustedWait =
    (page.readiness ?? "ready") === "ready" &&
    recent.length === 3 &&
    recent.every(
      (entry) => entry.kind === "wait" && entry.page_changed === false,
    );
  for (const [operation, action] of Object.entries(controls)) {
    if (operation === "WAIT" && exhaustedWait) continue;
    operations[operation] =
      operation === "SCROLL_DOWN"
        ? "Reveal more controls below the current viewport by scrolling down."
        : operation === "SCROLL_UP"
          ? "Reveal more controls above the current viewport by scrolling up."
          : action.label;
  }
  if (allowDone) operations.DONE = "Every requirement is visibly satisfied.";
  operations.BLOCKED = "No supported operation can progress.";
  const requiredFragment = checks?.find(
    (check) =>
      check.kind === "url" &&
      check.includes.startsWith("#") &&
      new URL(page.url).hash !== check.includes,
  );
  if (
    requiredFragment?.kind === "url" &&
    Object.values(targets.CLICK ?? {}).some(
      (action) =>
        "href" in action &&
        action.href &&
        new URL(action.href).hash === requiredFragment.includes,
    )
  ) {
    delete operations.SCROLL_DOWN;
    delete operations.SCROLL_UP;
  }
  const instructions =
    (allowDone
      ? `User goal: ${goal}\n${NEXT_ACTION}`
      : `Current step: ${goal}\n${CURRENT_STEP}`) +
    (missingControls.length && (controls.SCROLL_DOWN || controls.SCROLL_UP)
      ? "\nThe required control is not yet visible. Scrolling is available and must be tried before declaring this control unavailable."
      : "") +
    (requiredFragment?.kind === "url"
      ? `\nThis step requires URL fragment ${requiredFragment.includes}. Click its observed section link when offered; scrolling alone cannot change the URL fragment.`
      : "");
  const offered = new Set(
    Object.values(targets).flatMap((group) =>
      Object.keys(group).map((index) => index.split(":")[0]),
    ),
  );
  const boundTargets = Object.fromEntries(
    Object.entries(targets).flatMap(([operation, candidates]) => {
      const indices = Object.keys(candidates);
      return indices.length === 1 ? [[operation, indices[0]!]] : [];
    }),
  );
  const request: DecisionRequest = {
    model: endpoint.model,
    state: {
      page: { url: page.url, title: page.title, text: page.text },
      required_checks: checks,
      bound_targets: boundTargets,
      memory,
      observation: {
        readiness: page.readiness ?? "ready",
        omitted_actions: page.omitted_actions,
        discovery_limited: page.discovery_limited ?? false,
        controls_scope:
          "Only the current viewport is observed; more controls may be outside it.",
        scroll: { ...page.scroll, viewport_height: page.h },
        pending_controls_not_visible: missingControls,
      },
      elements: controlChecks.length
        ? elements.filter(
            (element) =>
              offered.has(element.index) ||
              controlChecks.some((check) =>
                check.ref
                  ? check.ref === element.ref
                  : check.label.trim() === element.label.trim(),
              ),
          )
        : elements,
      recent_actions: history
        .slice(-10)
        .map(({ action, kind, text, page_changed }) => ({
          action,
          kind,
          text,
          page_changed,
        })),
    },
    questions: {
      operation: {
        type: "choice",
        criteria: operations,
        instructions,
      },
    },
  };
  for (const [operation, candidates] of Object.entries(targets)) {
    // The operation still needs a decision; a sole compatible target does not.
    if (boundTargets[operation]) continue;
    request.questions[`${operation.toLowerCase()}_target`] = {
      type: "choice",
      criteria: Object.fromEntries(
        Object.entries(candidates).map(([index, action]) => {
          if (!("node" in action)) throw new Error("Invalid target action.");
          return [
            index,
            {
              element: `[${index}] ${action.label}`,
              // Other control properties appear once in state.elements.
              ...(action.kind === "select" ? { value: action.value } : {}),
            },
          ];
        }),
      ),
      instructions: allowDone
        ? `User goal: ${goal}\nIf the operation is ${operation}, choose its target.\n${NEXT_ACTION}\n${TARGET}`
        : `${instructions}\nIf the operation is ${operation}, choose its observed target index.`,
    };
  }
  const started = performance.now();
  const result = await postJson(endpoint, "systemone", request, observe);
  if (!object(result.answers))
    throw new Error("Decision provider did not return typed answers.");
  const answer = validateChoice(result.answers.operation, operations);
  const operation = answer.choice as Operation;
  const candidates = targets[operation as TargetOperation];
  const single = boundTargets[operation] ?? null;
  // An ambiguous target must come from the selected operation's own head.
  const targetAnswer =
    candidates && !single
      ? validateChoice(
          result.answers[`${operation.toLowerCase()}_target`],
          candidates,
        )
      : null;
  const target = single ?? targetAnswer?.choice ?? null;
  const choice =
    candidates && target
      ? candidates[target]!.id
      : (controls[operation]?.id ?? operation);
  return {
    choice,
    operation,
    target,
    confidence: answer.confidence,
    probabilities:
      candidates && targetAnswer
        ? Object.fromEntries(
            Object.entries(candidates).map(([id, action]) => [
              action.id,
              targetAnswer.probabilities[id]!,
            ]),
          )
        : { [choice]: answer.probabilities[operation]! },
    operation_probabilities: answer.probabilities,
    target_probabilities: targetAnswer?.probabilities ?? {},
    target_confidence: targetAnswer?.confidence ?? null,
    target_source: single ? "single_candidate" : targetAnswer ? "model" : null,
    raw_answers: result.answers,
    model: typeof result.model === "string" ? result.model : endpoint.model,
    usage: object(result.usage) ? result.usage : {},
    latency_ms: Math.round(performance.now() - started),
    request,
  };
}

export function fieldContext(
  goal: string,
  action: Action,
  page: PageState,
  history: HistoryEntry[],
  originalGoal = goal,
  memory?: AgentMemory,
) {
  if (!("node" in action)) throw new Error("Text requires an observed field.");
  return {
    goal,
    original_goal: originalGoal,
    memory,
    field: {
      node: action.node,
      ref: action.ref ?? `${page.document_id}:${action.node}`,
      label: action.label,
      role: action.role,
      value: action.value ?? "",
      scope: action.scope ?? "",
      context: action.context ?? "",
      html_id: action.html_id ?? "",
      html_name: action.html_name ?? "",
      input_type: action.input_type ?? "text",
      constraints: action.constraints,
    },
    page: {
      document_id: page.document_id,
      url: page.url,
      title: page.title,
      text: page.text.slice(0, 6000),
    },
    recent_actions: history
      .slice(-6)
      .map(({ action, text }) => ({ action, text })),
  };
}

export function goalIdentifier(
  value: string,
  goal: string,
): string | undefined {
  const pair = value.match(/^(.+?)\s+\(([A-Z0-9]{2,8})\)?$/);
  const name = pair?.[1] ?? value.trim();
  const matches = goal.matchAll(
    new RegExp(
      `(?<![\\p{L}\\p{N}_])${RegExp.escape(name)}\\s+\\(([A-Z0-9]{2,8})\\)(?![\\p{L}\\p{N}_])`,
      "gu",
    ),
  );
  const codes = [...new Set(Array.from(matches, (match) => match[1]!))];
  return codes.length === 1 && (!pair || pair[2] === codes[0])
    ? codes[0]
    : undefined;
}

export async function fieldText(
  context: ReturnType<typeof fieldContext>,
  connection: Endpoint | (() => Promise<Endpoint>),
  observe?: ModelObserver,
): Promise<{ text: string | null; helper: ModelCall }> {
  const started = performance.now();
  for (let attempt = 0; attempt < 2; attempt++) {
    const endpoint =
      typeof connection === "function" ? await connection() : connection;
    const result = await postJson(
      endpoint,
      "chat/completions",
      {
        model: endpoint.model,
        max_tokens: 1024,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "field_value",
            strict: true,
            schema: {
              type: "object",
              properties: {
                text: { anyOf: [{ type: "string" }, { type: "null" }] },
              },
              required: ["text"],
              additionalProperties: false,
            },
          },
        },
        messages: [
          { role: "system", content: TEXT_VALUE },
          { role: "user", content: JSON.stringify(context) },
          ...(attempt
            ? [
                {
                  role: "user",
                  content:
                    "The previous response did not match the field_value schema. Return only that JSON object. Use text:null when the required value is unknown.",
                },
              ]
            : []),
        ],
      },
      observe,
    );
    let output: unknown;
    try {
      const first = Array.isArray(result.choices)
        ? result.choices[0]
        : undefined;
      if (
        !object(first) ||
        !object(first.message) ||
        typeof first.message.content !== "string"
      )
        throw new Error();
      output = JSON.parse(first.message.content);
    } catch {
      continue;
    }
    if (
      !object(output) ||
      Object.keys(output).length !== 1 ||
      (output.text !== null &&
        (typeof output.text !== "string" ||
          !output.text.trim() ||
          output.text.length > 2000))
    )
      continue;
    return {
      // Search by an explicit code without treating the query as a committed selection.
      text:
        context.field.role === "combobox" && typeof output.text === "string"
          ? (goalIdentifier(output.text, context.original_goal) ?? output.text)
          : output.text,
      helper: {
        model: endpoint.model,
        latency_ms: Math.round(performance.now() - started),
        usage: object(result.usage) ? result.usage : {},
      },
    };
  }
  throw new Error(
    "Text helper returned no valid field value after a repair attempt; nothing typed.",
  );
}

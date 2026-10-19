import { object } from "./config.js";
import { CURRENT_STEP, NEXT_ACTION, TARGET, TEXT_VALUE } from "./questions.js";
import type {
  Action,
  ChoiceAnswer,
  Decision,
  DecisionRequest,
  ElementView,
  Endpoint,
  HistoryEntry,
  ModelCall,
  Operation,
  PageState,
  TargetOperation,
} from "./types.js";

export async function postJson(
  endpoint: Endpoint,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  if (!endpoint.model)
    throw new Error("Set the model identifier in Settings or .env before running.");
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${endpoint.baseUrl}/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
        redirect: "error",
      });
    } catch {
      throw new Error("Model connection failed or timed out; no browser action executed.");
    }
    if ([429, 503, 529].includes(response.status) && attempt < 2) {
      await response.body?.cancel();
      await Bun.sleep(500 * 2 ** attempt);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Model provider returned HTTP ${response.status}; no browser action executed.`,
      );
    }
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new Error("Model provider returned invalid JSON.");
    }
    if (!object(result)) throw new Error("Model provider returned an invalid response.");
    return result;
  }
  throw new Error("Model unavailable.");
}

export function validateChoice(answer: unknown, ids: Record<string, unknown>): ChoiceAnswer {
  const invalid = () => new Error("Invalid typed decision response; no action executed.");
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
    numbers.some((n) => typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1)
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

export function actionSpace(actions: Action[]) {
  const elements: ElementView[] = [];
  const indices = new Map<number, ElementView>();
  const targets: Partial<Record<TargetOperation, Record<string, Action>>> = {};
  const controls: Partial<Record<Operation, Action>> = {};
  const operations = { click: "CLICK", fill: "TYPE_TEXT", select: "SELECT" } as const;
  for (const action of actions) {
    if (action.kind === "scroll" || action.kind === "wait") {
      controls[action.kind === "wait" ? "WAIT" : action.delta < 0 ? "SCROLL_UP" : "SCROLL_DOWN"] =
        action;
      continue;
    }
    let element = indices.get(action.node);
    if (!element) {
      element = {
        index: String(elements.length + 1),
        label: action.label.split(" → ")[0]!,
        role: action.role,
        ref: action.ref,
        scope: action.scope || undefined,
        context: action.context,
        value: action.kind === "select" ? action.current_value : action.value,
        checked: action.checked,
        selected: action.selected,
        expanded: action.expanded,
        operations: [],
      };
      if (action.kind === "select") element.options = [];
      elements.push(element);
      indices.set(action.node, element);
    }
    const operation = operations[action.kind];
    const group = (targets[operation] ??= {});
    if (!element.operations.includes(operation)) element.operations.push(operation);
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
): Promise<Decision> {
  const { elements, targets, controls } = actionSpace(page.actions);
  const labels = {
    CLICK: "Click an element, button, menu option, autocomplete suggestion, or calendar day.",
    TYPE_TEXT:
      "Enter or replace text in an editable field. A small LLM supplies the value from the goal.",
    SELECT: "Select an observed dropdown value.",
  };
  const operations: Record<string, string> = {};
  for (const operation of Object.keys(targets) as TargetOperation[])
    operations[operation] = labels[operation];
  for (const [operation, action] of Object.entries(controls)) operations[operation] = action.label;
  if (allowDone) operations.DONE = "Every requirement is visibly satisfied.";
  operations.BLOCKED = "No supported operation can progress.";
  const instructions = allowDone
    ? `User goal: ${goal}\n${NEXT_ACTION}`
    : `Current step: ${goal}\n${CURRENT_STEP}`;
  const request: DecisionRequest = {
    model: endpoint.model,
    state: {
      page: { url: page.url, title: page.title, text: page.text },
      elements,
      recent_actions: history
        .slice(-10)
        .map(({ action, kind, text, page_changed }) => ({ action, kind, text, page_changed })),
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
    request.questions[`${operation.toLowerCase()}_target`] = {
      type: "choice",
      criteria: Object.fromEntries(
        Object.entries(candidates).map(([index, action]) => {
          if (!("node" in action)) throw new Error("Invalid target action.");
          return [
            index,
            {
              element: `[${index}] ${action.label}`,
              current_value: action.current_value ?? action.value ?? "",
              role: action.role,
              ref: action.ref,
              scope: action.scope,
              context: action.context,
              checked: action.checked,
              selected: action.selected,
              expanded: action.expanded,
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
  const result = await postJson(endpoint, "systemone", request);
  if (!object(result.answers)) throw new Error("Decision provider did not return typed answers.");
  const answer = validateChoice(result.answers.operation, operations);
  const operation = answer.choice as Operation;
  const candidates = targets[operation as TargetOperation];
  // Only the selected operation's head can identify an executable target.
  const targetAnswer = candidates
    ? validateChoice(result.answers[`${operation.toLowerCase()}_target`], candidates)
    : null;
  const target = targetAnswer?.choice ?? null;
  const choice =
    candidates && target ? candidates[target]!.id : (controls[operation]?.id ?? operation);
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
) {
  if (!("node" in action)) throw new Error("Text requires an observed field.");
  return {
    goal,
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
    },
    page: {
      document_id: page.document_id,
      url: page.url,
      title: page.title,
      text: page.text.slice(0, 6000),
    },
    recent_actions: history.slice(-6).map(({ action, text }) => ({ action, text })),
  };
}

export async function fieldText(
  context: ReturnType<typeof fieldContext>,
  endpoint: Endpoint,
): Promise<{ text: string; helper: ModelCall }> {
  const started = performance.now();
  const result = await postJson(endpoint, "chat/completions", {
    model: endpoint.model,
    max_tokens: 1024,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "field_value",
        strict: true,
        schema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      },
    },
    messages: [
      { role: "system", content: TEXT_VALUE },
      { role: "user", content: JSON.stringify(context) },
    ],
  });
  let output: unknown;
  try {
    const first = Array.isArray(result.choices) ? result.choices[0] : undefined;
    if (!object(first) || !object(first.message) || typeof first.message.content !== "string")
      throw new Error();
    output = JSON.parse(first.message.content);
  } catch {
    throw new Error("Text helper returned no valid field value; nothing typed.");
  }
  if (
    !object(output) ||
    Object.keys(output).length !== 1 ||
    typeof output.text !== "string" ||
    !output.text.trim() ||
    output.text.length > 2000
  )
    throw new Error("Text helper returned no valid field value; nothing typed.");
  return {
    text: output.text,
    helper: {
      model: endpoint.model,
      latency_ms: Math.round(performance.now() - started),
      usage: object(result.usage) ? result.usage : {},
    },
  };
}

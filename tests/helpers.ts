import { fingerprint } from "../src/browser";
import type {
  ChoiceAnswer,
  DecisionRequest,
  Endpoint,
  PageState,
  Settings,
} from "../src/types";

export function page(): PageState {
  const state: PageState = {
    document_id: "fixture-document",
    url: "https://example.test/",
    title: "Search",
    text: "Search",
    w: 1120,
    h: 780,
    scroll: { y: 0, height: 780 },
    marker: [1, "Search"],
    page_key: [1],
    guards: {},
    omitted_actions: 0,
    fingerprint: "",
    actions: [
      {
        id: "e1",
        kind: "fill",
        label: "Search",
        role: "textbox",
        value: "",
        node: 10,
      },
      {
        id: "e2",
        kind: "click",
        label: "Open Search",
        role: "textbox",
        value: "",
        node: 10,
      },
      {
        id: "e3",
        kind: "click",
        label: "Go",
        role: "button",
        value: "",
        node: 20,
      },
      { id: "wait", kind: "wait", label: "Wait" },
    ],
  };
  state.fingerprint = fingerprint(state);
  return state;
}
export function choice(
  criteria: Record<string, unknown>,
  selected: string,
): ChoiceAnswer {
  return {
    choice: selected,
    confidence: 1,
    probabilities: Object.fromEntries(
      Object.keys(criteria).map((id) => [id, Number(id === selected)]),
    ),
  };
}
export function chatResponse(output: unknown) {
  return Response.json({
    choices: [{ message: { content: JSON.stringify(output) } }],
  });
}

export function completionResponse(body: { messages: { content: string }[] }) {
  const { sources } = JSON.parse(body.messages[1]!.content);
  const source = sources[0];
  return chatResponse({
    complete: true,
    answer: "The requested task is complete.",
    evidence: [
      { url: source.url, quote: source.title || source.text.slice(0, 80) },
    ],
    missing_steps: [],
  });
}
export function decisionResponse(
  body: DecisionRequest,
  operation = "TYPE_TEXT",
  target = "1",
) {
  const head = `${operation.toLowerCase()}_target`;
  return {
    model: body.model,
    answers: {
      operation: choice(body.questions.operation!.criteria, operation),
      ...(body.questions[head]
        ? { [head]: choice(body.questions[head].criteria, target) }
        : {}),
    },
  };
}
export function provider(
  handler: (request: Request) => Response | Promise<Response>,
) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const endpoint: Endpoint = {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    apiKey: "test-key",
    model: "test-model",
  };
  const settings: Settings = {
    decision: { ...endpoint },
    text: { ...endpoint },
  };
  return { server, endpoint, settings };
}

export const fixture = `<!doctype html><title>Local hotel search</title>
<style>body{font:18px sans-serif;margin:30px}input,select,button{margin:12px;padding:12px}</style>
<form id="form"><label>City<input id="city" name="city"></label>
<label>Category<select id="category"><option>All</option><option>Design</option><option disabled>Unavailable</option></select></label>
<label><input type="checkbox" id="refund">Free cancellation</label>
<button id="search" type="submit">Search hotels</button></form><div id="result"></div>
<script>window.submits=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submits++;
document.querySelector('#result').textContent='Results: '+document.querySelector('#city').value+' / '+document.querySelector('#category').value};</script>`;

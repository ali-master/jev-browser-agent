export type TargetOperation = "CLICK" | "TYPE_TEXT" | "SELECT";
export type Operation = TargetOperation | "SCROLL_UP" | "SCROLL_DOWN" | "WAIT" | "DONE" | "BLOCKED";

interface Target {
  id: string;
  node: number;
  label: string;
  role: string;
  ref?: string;
  scope?: string;
  context?: string;
  html_id?: string;
  html_name?: string;
  input_type?: string;
  constraints?: { min: string; max: string; step: string };
  value?: string;
  current_value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  rect?: { x: number; y: number; w: number; h: number };
}
export type Action =
  | (Target & { kind: "click" | "fill" })
  | (Target & { kind: "select"; value: string; option_index: number; option_node: number })
  | { id: string; kind: "scroll"; label: string; delta: number }
  | { id: string; kind: "wait"; label: string };

export interface PageState {
  document_id: string;
  discovery_limited?: boolean;
  readiness?: "ready" | "loading" | "empty";
  url: string;
  title: string;
  text: string;
  w: number;
  h: number;
  scroll: { y: number; height: number };
  actions: Action[];
  marker: unknown[];
  page_key: unknown[];
  guards: Record<string, unknown>;
  omitted_actions: number;
  fingerprint: string;
  screenshot?: string;
  screenshot_status?: "captured" | "unavailable";
  screenshot_error?: string;
}

export interface ElementView {
  index: string;
  label: string;
  role: string;
  ref?: string;
  scope?: string;
  context?: string;
  input_type?: string;
  constraints?: { min: string; max: string; step: string };
  value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  operations: TargetOperation[];
  options?: { index: string; label: string; value: string }[];
}
export interface Endpoint {
  baseUrl: string;
  apiKey: string;
  model: string;
}
export interface Settings {
  decision: Endpoint;
  text: Endpoint;
}
export type SettingsReader = () => Promise<Settings>;
export interface ChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
export interface Question {
  type: "choice";
  criteria: Record<string, unknown>;
  instructions: unknown;
}
export interface DecisionRequest {
  model: string;
  state: unknown;
  questions: Record<string, Question>;
}
export interface ModelCall {
  model: string;
  latency_ms: number;
  usage: Record<string, unknown>;
  endpoint?: string;
  outcome?: "response" | "network_error" | "http_error" | "provider_error" | "invalid_response";
  http_status?: number;
}
export type ModelRole = "decision" | "text" | "planning" | "verification";
export type ModelObserver = (call: ModelCall) => void;
export interface Decision extends ModelCall {
  choice: string;
  operation: Operation;
  target: string | null;
  confidence: number;
  probabilities: Record<string, number>;
  operation_probabilities: Record<string, number>;
  target_probabilities: Record<string, number>;
  target_confidence: number | null;
  raw_answers: Record<string, unknown>;
  request: DecisionRequest;
}
export interface HistoryEntry {
  step: number;
  action: string;
  ref?: string;
  scope?: string;
  kind: Action["kind"];
  choice: string;
  probability: number;
  confidence: number;
  latency_ms: number;
  text: string | null;
  text_helper: string | null;
  text_latency_ms: number;
  operation: Operation;
  target: string | null;
  page_changed: boolean | null;
  url: string;
  usage: Record<string, unknown>;
  executed_ms: number;
  elapsed_ms: number;
}
export type Status = "ready" | "predicted" | "done" | "blocked" | "error" | "closed";
interface ControlCheck {
  label: string;
  ref?: string | null;
  scope?: string | null;
}
export type CompletionCheck =
  | (ControlCheck & { kind: "value"; equals: string })
  | (ControlCheck & { kind: "checked"; equals: boolean })
  | (ControlCheck & { kind: "action"; action: "click" })
  | { kind: "title" | "url" | "text"; includes: string };
export interface TaskStep {
  instruction: string;
  checks: CompletionCheck[];
}
export interface Checkpoint extends TaskStep {
  started_at_action: number | null;
  started_fingerprint: string | null;
  verified: {
    fingerprint: string;
    url: string;
    action_count: number;
    evidence?: { title: string; text: string };
  } | null;
}
export interface CompletionReview {
  complete: boolean;
  answer: string | null;
  evidence: { url: string; quote: string }[];
  missing_steps: TaskStep[];
}
export interface AgentState {
  goal: string;
  page: PageState;
  decision: Decision | null;
  history: HistoryEntry[];
  status: Status;
  activity: {
    kind: "observing" | "planning" | "deciding" | "writing" | "acting" | "verifying";
    started_at: number;
    action?: Action;
    text?: string;
  } | null;
  plan: string[];
  plan_index: number;
  checkpoints: Checkpoint[];
  plan_revisions: { reason: string; checkpoints: Checkpoint[] }[];
  completion_reviews: CompletionReview[];
  answer: string | null;
  planning_calls: ModelCall[];
  decisions: (Decision & { fingerprint: string; elapsed_ms: number })[];
  text_calls: (ModelCall & { field: string; value: string | null })[];
  model_calls: (ModelCall & { role: ModelRole })[];
  stop_reason?: { code: string; message: string };
  elapsed_ms: number;
  record: boolean;
}

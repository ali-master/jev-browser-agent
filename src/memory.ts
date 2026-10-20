import type { Action, AgentMemory, Checkpoint, PageState } from "./types";

type Observation = Pick<
  PageState,
  "url" | "document_id" | "fingerprint" | "readiness"
>;

/** Retain bounded observations and feedback for one run, without another model call. */
export class RunMemory {
  private pages = new Map<string, Pick<PageState, "url" | "title" | "text">>();
  private attempts = new Map<
    string,
    {
      page: Observation;
      action: Pick<Action, "id" | "label" | "kind">;
      count: number;
      step: number;
    }
  >();

  /** Keep the last read content when leaving a page, including a revisited URL. */
  remember(page: PageState) {
    this.pages.delete(page.url);
    this.pages.set(page.url, {
      url: page.url,
      title: page.title,
      text: (page.read_text || page.text).slice(-16000),
    });
    if (this.pages.size > 12)
      this.pages.delete(this.pages.keys().next().value!);
  }

  /** Learn only from confirmed operations followed by a ready, unchanged observation. */
  record(page: Observation, action: Action, changed: boolean, step: number) {
    if (action.kind === "wait" || (page.readiness ?? "ready") !== "ready")
      return;
    const key = JSON.stringify([
      page.document_id,
      page.fingerprint,
      action.id,
      action.kind,
    ]);
    const previous = this.attempts.get(key);
    this.attempts.delete(key);
    if (changed) return;
    this.attempts.set(key, {
      page: { ...page },
      action: { id: action.id, label: action.label, kind: action.kind },
      count: (previous?.count ?? 0) + 1,
      step,
    });
    if (this.attempts.size > 12)
      this.attempts.delete(this.attempts.keys().next().value!);
  }

  /** Supply original observations to final verification, never the shortened excerpts. */
  sources() {
    return [...this.pages.values()];
  }

  /** Give models a small navigation memory; historical controls are never current targets. */
  context(page: PageState, checkpoints: Checkpoint[]): AgentMemory {
    return {
      pages: this.sources()
        .filter((source) => source.url !== page.url)
        .slice(-4)
        .map(({ url, title, text }) => ({
          url,
          title: title.slice(0, 200),
          excerpt: text.slice(-1200),
        })),
      completed: checkpoints
        .filter((checkpoint) => checkpoint.verified)
        .slice(-8)
        .map((checkpoint) => ({
          instruction: checkpoint.instruction.slice(0, 300),
          url: checkpoint.verified!.url,
        })),
      lessons: [...this.attempts.values()].slice(-6).map((attempt) => {
        const current =
          attempt.page.document_id === page.document_id &&
          attempt.page.fingerprint === page.fingerprint;
        return {
          url: attempt.page.url,
          action: attempt.action.label.slice(0, 200),
          kind: attempt.action.kind,
          attempts: attempt.count,
          last_step: attempt.step,
          outcome: "no_visible_change",
          // A different text value may repair the same field; do not ban its editor.
          avoid:
            current && attempt.count >= 2 && attempt.action.kind !== "fill",
          choice: current ? attempt.action.id : null,
        };
      }),
    };
  }
}

import { useState } from "preact/hooks";
import type { BankPayload, BankQuestion, UserState } from "../../shared/schema.ts";
import { needsReview } from "./logic.ts";
import { sanitize } from "./sanitize.ts";
import { md } from "./md.ts";
import { record } from "./store.ts";
import { transcriptionRev } from "../../shared/rev.ts";

// Confirm or fix Claude's transcription of hotspot / drag-drop answers before they count.
export function Review({
  bank,
  state,
  setState,
  onExit,
}: {
  bank: BankPayload;
  state: UserState;
  setState: (fn: (s: UserState) => UserState) => void;
  onExit: () => void;
}) {
  const queue = bank.questions.filter((q) => needsReview(q, state));
  if (!queue.length)
    return (
      <div class="empty">
        <p>Nothing to review.</p>
        <button onClick={onExit}>Back</button>
      </div>
    );
  return (
    <div class="review">
      <div class="bar-top">
        <button class="ghost" onClick={onExit}>
          ←
        </button>
        <span class="mode">Review transcriptions</span>
        <span class="pos">{queue.length} left</span>
      </div>
      <ReviewItem key={queue[0].id} q={queue[0]} exam={bank.exam.code} setState={setState} />
    </div>
  );
}

function ReviewItem({ q, exam, setState }: { q: BankQuestion; exam: string; setState: (fn: (s: UserState) => UserState) => void }) {
  const it = q.enrichment!.interactive!;
  const [items, setItems] = useState(q.resolved.items ?? it.items.map((i) => i.answer));
  const confirm = () => {
    const changed = items.some((v, i) => v !== q.resolved.items?.[i]);
    const row = {
      questionId: q.id,
      status: "reviewed" as const,
      items: changed ? items : undefined,
      rev: transcriptionRev(it),
      at: new Date().toISOString(),
    };
    setState((s) => ({ ...s, reviews: [...s.reviews.filter((r) => r.questionId !== q.id), row] }));
    void record({ reviews: [row] });
  };
  return (
    <article class="question">
      <header class="q-head">
        <span class="q-num">Q{q.number}</span>
        <span class="q-topic">{q.kind}</span>
      </header>
      <div class="stem" dangerouslySetInnerHTML={{ __html: sanitize(q.stemHtml, exam) }} />
      {q.suggestedImage && (
        <figure class="answer-img">
          <figcaption>ExamTopics answer image</figcaption>
          <img src={`/img/${exam}/${q.suggestedImage}`} alt="ExamTopics answer" />
        </figure>
      )}
      <p class="hint">
        Check each transcribed selection against the images. Answers default to the resolved answer (docs win where they disagree).
      </p>
      {it.items.map((item, i) => (
        <fieldset class="hs-item">
          <legend class="hs-label">
            {item.label}
            {item.docsAnswer ? " · docs differ from ExamTopics" : ""}
          </legend>
          <div class="hs-options" role="radiogroup">
            {item.options.map((o) => (
              <button
                type="button"
                class={`hs-option ${items[i] === o ? "chosen" : ""}`}
                role="radio"
                aria-checked={items[i] === o}
                onClick={() => setItems(items.map((v, j) => (j === i ? o : v)))}
              >
                {o}
                {o === item.answer && <span class="tag">ExamTopics</span>}
                {o === item.docsAnswer && <span class="tag">docs</span>}
              </button>
            ))}
          </div>
        </fieldset>
      ))}
      <div class="explanation" dangerouslySetInnerHTML={{ __html: md(q.enrichment!.explanation) }} />
      <div class="bar-bottom">
        <button class="primary" onClick={confirm}>
          Confirm
        </button>
      </div>
    </article>
  );
}

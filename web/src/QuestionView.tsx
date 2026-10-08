import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { BankQuestion, UserState } from "../../shared/schema.ts";
import { effectiveAnswer, isCorrect, isFlagged, isInteractive, SEP, togglePick } from "./logic.ts";
import { sanitize } from "./sanitize.ts";
import { md } from "./md.ts";
import { record } from "./store.ts";

const BASIS: Record<BankQuestion["resolved"]["basis"], string> = {
  community: "Community vote",
  "suggested+docs": "ExamTopics, confirmed by docs",
  docs: "Docs (overrules ExamTopics)",
  suggested: "ExamTopics only (unverified)",
};

const now = () => new Date().toISOString();

export function toggleFlagFor(q: BankQuestion, state: UserState, onState: (fn: (s: UserState) => UserState) => void) {
  const row = { questionId: q.id, flagged: !isFlagged(state, q.id), at: now() };
  onState((s) => ({ ...s, flags: [...s.flags.filter((f) => f.questionId !== q.id), row] }));
  void record({ flags: [row] });
}

interface Props {
  q: BankQuestion;
  exam: string;
  state: UserState;
  given: string;
  onChange?: (given: string) => void;
  revealed: boolean;
  onState: (fn: (s: UserState) => UserState) => void;
}

export function QuestionView({ q, exam, state, given, onChange, revealed, onState }: Props) {
  const stem = useMemo(() => sanitize(q.stemHtml, exam), [q.id]);
  const locked = revealed || !onChange;
  const flagged = isFlagged(state, q.id);

  const toggleFlag = () => toggleFlagFor(q, state, onState);

  return (
    <article class="question">
      <header class="q-head">
        <span class="q-num">Q{q.number}</span>
        <span class="q-topic">{q.topic.replace(/^Topic \d+,\s*/, "")}</span>
        <button class={`flag ${flagged ? "on" : ""}`} onClick={toggleFlag} aria-pressed={flagged} title="Flag for weak-spot practice">
          {flagged ? "★ Flagged" : "☆ Flag"}
        </button>
      </header>

      <div class="stem" dangerouslySetInnerHTML={{ __html: stem }} />

      {isInteractive(q) ? (
        <Interactive q={q} given={given} onChange={onChange} locked={locked} revealed={revealed} state={state} />
      ) : (
        <Choices q={q} exam={exam} given={given} onChange={onChange} locked={locked} revealed={revealed} state={state} />
      )}

      {revealed && <Reveal key={q.id} q={q} exam={exam} state={state} given={given} onState={onState} />}
    </article>
  );
}

function Choices({
  q,
  exam,
  given,
  onChange,
  locked,
  revealed,
  state,
}: {
  q: BankQuestion;
  exam: string;
  given: string;
  onChange?: (g: string) => void;
  locked: boolean;
  revealed: boolean;
  state: UserState;
}) {
  const want = revealed ? (effectiveAnswer(q, state) ?? "") : "";
  const multi = q.pick > 1;
  const pick = (letter: string) => {
    if (!locked && onChange) onChange(togglePick(q, given, letter));
  };
  return (
    <div class="choices" role={multi ? "group" : "radiogroup"}>
      {multi && <p class="hint">Choose {q.pick}.</p>}
      {q.choices.map((c) => {
        const chosen = given.includes(c.letter);
        const right = want.includes(c.letter);
        const cls = ["choice", chosen && "chosen", revealed && right && "right", revealed && chosen && !right && "wrong"]
          .filter(Boolean)
          .join(" ");
        return (
          <button class={cls} onClick={() => pick(c.letter)} disabled={locked} role={multi ? "checkbox" : "radio"} aria-checked={chosen}>
            <span class="letter">{c.letter}</span>
            <span class="text" dangerouslySetInnerHTML={{ __html: sanitize(c.html, exam) }} />
          </button>
        );
      })}
    </div>
  );
}

function Interactive({
  q,
  given,
  onChange,
  locked,
  revealed,
  state,
}: {
  q: BankQuestion;
  given: string;
  onChange?: (g: string) => void;
  locked: boolean;
  revealed: boolean;
  state: UserState;
}) {
  const it = q.enrichment!.interactive!;
  const parts = given ? given.split(SEP) : it.items.map(() => "");
  const want = revealed ? (effectiveAnswer(q, state) ?? "").split(SEP) : [];
  const set = (i: number, v: string) => {
    const next = [...parts];
    next[i] = v;
    onChange?.(next.join(SEP));
  };
  return (
    <div class="interactive">
      {it.context && <pre class="context">{it.context}</pre>}
      {it.items.map((item, i) => (
        <label class={`hs-item ${revealed ? (parts[i] === want[i] ? "right" : "wrong") : ""}`}>
          <span class="hs-label">{item.label}</span>
          <select value={parts[i]} disabled={locked} onChange={(e) => set(i, (e.target as HTMLSelectElement).value)}>
            <option value="">Select…</option>
            {item.options.map((o) => (
              <option value={o}>{o}</option>
            ))}
          </select>
          {revealed && parts[i] !== want[i] && <span class="hs-want">✓ {want[i]}</span>}
        </label>
      ))}
    </div>
  );
}

function Reveal({
  q,
  exam,
  state,
  given,
  onState,
}: {
  q: BankQuestion;
  exam: string;
  state: UserState;
  given: string;
  onState: Props["onState"];
}) {
  const e = q.enrichment;
  const want = effectiveAnswer(q, state);
  const override = state.overrides.find((o) => o.questionId === q.id)?.answer ?? null;
  const ok = given ? isCorrect(q, state, given) : null;
  const note = state.notes.find((n) => n.questionId === q.id)?.text ?? "";
  const [draft, setDraft] = useState(override ?? "");
  const ours = state.ourVotes[q.id] ?? {};
  const oursTotal = Object.values(ours).reduce((a, b) => a + b, 0);
  const etTotal = q.votes.reduce((a, v) => a + v.votes, 0);

  const saveOverride = (answer: string | null) => {
    const row = { questionId: q.id, answer, at: now() };
    onState((s) => {
      const votes = { ...(s.ourVotes[q.id] ?? {}) };
      if (override) votes[override] = Math.max(0, (votes[override] ?? 1) - 1); // this user's previous vote
      if (answer) votes[answer] = (votes[answer] ?? 0) + 1;
      for (const k of Object.keys(votes)) if (!votes[k]) delete votes[k];
      return {
        ...s,
        overrides: [...s.overrides.filter((o) => o.questionId !== q.id), row],
        ourVotes: { ...s.ourVotes, [q.id]: votes },
      };
    });
    void record({ overrides: [row] });
  };
  const saveNote = (text: string) => {
    if (text === note) return;
    const row = { questionId: q.id, text, at: now() };
    onState((s) => ({ ...s, notes: [...s.notes.filter((n) => n.questionId !== q.id), row] }));
    void record({ notes: [row] });
  };

  const ref = useRef<HTMLDivElement>(null); // scroll just far enough to show the verdict, keeping the coloured choices in view
  useEffect(() => ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), [q.id]);

  return (
    <section class="reveal">
      {ok !== null && <div class={`verdict ${ok ? "ok" : "bad"}`}>{ok ? "Correct" : "Incorrect"}</div>}

      <div class="answer-line" ref={ref}>
        <span>
          Answer: <strong>{isInteractive(q) ? "see selections above" : want}</strong>
        </span>
        <span class="badge">{override ? "Your override" : BASIS[q.resolved.basis]}</span>
        {q.resolved.disputed && <span class="badge warn">Disputed</span>}
      </div>

      <dl class="sources-of-truth">
        <dt>ExamTopics said</dt>
        <dd>
          {q.suggested ??
            (q.suggestedImage ? (
              <a href={`/img/${exam}/${q.suggestedImage}`} target="_blank" rel="noopener noreferrer">
                answer image
              </a>
            ) : (
              "—"
            ))}
        </dd>
        {e?.docsAnswer && (
          <>
            <dt>Docs say</dt>
            <dd>{e.docsAnswer}</dd>
          </>
        )}
        <dt>
          Community ({etTotal} vote{etTotal === 1 ? "" : "s"})
        </dt>
        <dd>{etTotal ? <Bars rows={q.votes.map((v) => [v.answer, v.percent])} /> : "no votes"}</dd>
        <dt>Our votes ({oursTotal})</dt>
        <dd>{oursTotal ? <Bars rows={Object.entries(ours).map(([a, n]) => [a, Math.round((n / oursTotal) * 100)])} /> : "none yet"}</dd>
      </dl>

      {e && (
        <div class="explanation">
          <h3>
            Why <span class="ai">AI-written from the docs{e.review === "reviewed" ? "" : ", unreviewed"}</span>
          </h3>
          <div dangerouslySetInnerHTML={{ __html: md(e.explanation) }} />
          {e.sources.length > 0 && (
            <ul class="links">
              {e.sources.map((s) => (
                <li>
                  <a href={s.url} target="_blank" rel="noopener noreferrer">
                    {s.title}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!isInteractive(q) && (
        <form
          class="override"
          onSubmit={(ev) => {
            ev.preventDefault();
            saveOverride(draft.toUpperCase().replace(/[^A-Z]/g, "") || null);
          }}
        >
          <label>
            I think it&rsquo;s
            <input value={draft} maxLength={6} placeholder={want ?? ""} onInput={(ev) => setDraft((ev.target as HTMLInputElement).value)} />
          </label>
          <button type="submit">Save</button>
          {override && (
            <button
              type="button"
              onClick={() => {
                setDraft("");
                saveOverride(null);
              }}
            >
              Clear
            </button>
          )}
        </form>
      )}

      <label class="notes">
        My notes
        <textarea rows={3} value={note} onBlur={(ev) => saveNote((ev.target as HTMLTextAreaElement).value)} />
      </label>
    </section>
  );
}

function Bars({ rows }: { rows: [string, number][] }) {
  return (
    <span class="bars">
      {rows.map(([label, pct]) => (
        <span class="bar">
          <span class="bar-label">{label}</span>
          <span class="bar-fill" style={{ width: `${Math.max(pct, 4)}%` }} />
          <span class="bar-pct">{pct}%</span>
        </span>
      ))}
    </span>
  );
}

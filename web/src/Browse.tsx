import { useMemo, useState } from "preact/hooks";
import type { BankPayload, BankQuestion, UserState } from "../../shared/schema.ts";
import { isFlagged, lastAnswers, needsReview } from "./logic.ts";

type Filter = "all" | "unseen" | "wrong" | "right" | "flagged" | "disputed" | "notes";
const FILTERS: Filter[] = ["all", "unseen", "wrong", "right", "flagged", "disputed", "notes"];

const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export function Browse({
  bank,
  state,
  onOpen,
  onExit,
}: {
  bank: BankPayload;
  state: UserState;
  onOpen: (q: BankQuestion) => void;
  onExit: () => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const last = useMemo(() => lastAnswers(state), [state]);
  const noted = new Set(state.notes.filter((n) => n.text.trim()).map((n) => n.questionId));
  const texts = useMemo(
    () => new Map(bank.questions.map((q) => [q.id, plain(q.stemHtml + " " + q.choices.map((c) => c.html).join(" ")).toLowerCase()])),
    [bank],
  );

  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const rows = bank.questions.filter((q) => {
    const a = last.get(q.id);
    const pass =
      filter === "all" ||
      (filter === "unseen" && !a) ||
      (filter === "wrong" && a && !a.correct) ||
      (filter === "right" && a?.correct) ||
      (filter === "flagged" && isFlagged(state, q.id)) ||
      (filter === "disputed" && q.resolved.disputed) ||
      (filter === "notes" && noted.has(q.id));
    const num = /^#?\d+$/.test(query.trim()) ? q.number === Number(query.trim().replace("#", "")) : false;
    return pass && (num || words.every((w) => texts.get(q.id)!.includes(w)));
  });

  return (
    <main class="browse">
      <div class="bar-top">
        <button class="ghost" onClick={onExit}>
          ←
        </button>
        <span class="mode">Questions</span>
        <span class="pos">
          {rows.length} / {bank.questions.length}
        </span>
      </div>
      <input
        class="search"
        type="search"
        placeholder="Search text, or #number"
        value={query}
        onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
      />
      <div class="chips">
        {FILTERS.map((f) => (
          <button class={`chip ${f === filter ? "on" : ""}`} onClick={() => setFilter(f)}>
            {f}
          </button>
        ))}
      </div>
      <ul class="q-list">
        {rows.map((q) => {
          const a = last.get(q.id);
          return (
            <li>
              <button class="q-row" onClick={() => onOpen(q)}>
                <span
                  class={`dot ${!a ? "" : a.correct ? "ok" : "bad"}`}
                  aria-label={!a ? "unseen" : a.correct ? "last right" : "last wrong"}
                />
                <span class="q-row-num">Q{q.number}</span>
                <span class="q-row-text">{plain(q.stemHtml).slice(0, 120)}</span>
                <span class="q-row-tags">
                  {isFlagged(state, q.id) && <span title="flagged">★</span>}
                  {noted.has(q.id) && <span title="has notes">✎</span>}
                  {q.resolved.disputed && <span class="badge warn">disputed</span>}
                  {needsReview(q, state) && <span class="badge">needs review</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </main>
  );
}

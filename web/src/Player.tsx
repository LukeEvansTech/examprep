import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { del, set } from "idb-keyval";
import type { AnswerRow, BankPayload, UserState } from "../../shared/schema.ts";
import { isCorrect, isInteractive, nextSrs, playable, reconcile, SEP, togglePick, type Mode } from "./logic.ts";
import { QuestionView, toggleFlagFor } from "./QuestionView.tsx";
import { record, userKey } from "./store.ts";

export interface Session {
  id: string;
  exam: string;
  mode: Mode;
  ids: string[];
  given: Record<string, string>;
  checked: Record<string, boolean>; // study modes: answer submitted and revealed
  marked: string[];
  index: number;
  startedAt: string;
  updatedAt: string; // newest copy wins between this device and the server
  deadline?: string; // exam mode
  finished?: boolean;
}

export const sessionKey = (exam: string) => userKey(`session:${exam}`);
export const MODE_NAME: Record<Mode, string> = { exam: "Exam", study: "Study", weak: "Weak spots", srs: "Spaced repetition" };

// Every change is kept on this device straight away and queued for the server at most every
// few seconds, so a session can be picked up on another device.
let pushTimer: ReturnType<typeof setTimeout> | undefined;
export let lastWrite: Promise<unknown> = Promise.resolve(); // readers await this before loading a session
export function saveSession(s: Session | null, exam: string, immediate = false) {
  const at = new Date().toISOString();
  const data = s && { ...s, updatedAt: at };
  lastWrite = (data ? set(sessionKey(exam), data) : del(sessionKey(exam))).catch(() => {});
  clearTimeout(pushTimer);
  const push = () => void record({ sessions: [{ exam, data, at }] });
  if (immediate) push();
  else pushTimer = setTimeout(push, 3000);
  return data;
}

interface Props {
  bank: BankPayload;
  state: UserState;
  setState: (fn: (s: UserState) => UserState) => void;
  initial: Session;
  onExit: () => void;
  ephemeral?: boolean; // a one-off question opened from the browser: not saved as the exam's session
}

// Grade answers, append them locally and to the outbox, and move each SRS card.
function grade(bank: BankPayload, state: UserState, s: Session, ids: string[]) {
  const at = new Date();
  const answers: AnswerRow[] = [];
  const srs = [];
  let next = state;
  for (const id of ids) {
    const q = bank.questions.find((x) => x.id === id);
    if (!q) continue; // archived by a re-import since the session started
    const given = s.given[id] ?? "";
    const correct = !!given && isCorrect(q, next, given);
    answers.push({ id: crypto.randomUUID(), questionId: id, exam: s.exam, mode: s.mode, given, correct, at: at.toISOString() });
    const row = nextSrs(q, s.exam, next, correct, at);
    srs.push(row);
    next = { ...next, srs: [...next.srs.filter((r) => r.questionId !== id), row] };
  }
  next = { ...next, answers: [...next.answers, ...answers] };
  void record({ answers, srs });
  return next;
}

const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
};

export function Player({ bank, state, setState, initial, onExit, ephemeral }: Props) {
  const [s, setS] = useState(() => reconcile(initial, bank));
  const latest = useRef(s); // the timer's expiry callback must grade the answers given since it started
  latest.current = s;
  const update = (fn: (s: Session) => Session, immediate = false) =>
    setS((cur) => {
      let n = fn(cur);
      if (!ephemeral) n = saveSession(n, n.exam, immediate)!;
      latest.current = n;
      return n;
    });

  const qs = useMemo(
    () => s.ids.map((id) => bank.questions.find((q) => q.id === id)).filter(Boolean) as BankPayload["questions"],
    [s.ids, bank],
  );
  const q = qs[s.index];
  const isExam = s.mode === "exam";

  const finish = () => {
    const cur = latest.current;
    if (cur.finished) return;
    if (isExam) {
      // Unanswered questions still score zero below, but aren't logged as wrong answers.
      setState((st) =>
        grade(
          bank,
          st,
          cur,
          cur.ids.filter((id) => cur.given[id]),
        ),
      );
      const live = cur.ids.filter((id) => bank.questions.some((b) => b.id === id)); // skip any archived since
      const correct = live.filter((id) => {
        const x = bank.questions.find((b) => b.id === id)!;
        return cur.given[id] && isCorrect(x, state, cur.given[id]);
      }).length;
      const result = {
        id: cur.id,
        exam: cur.exam,
        at: new Date().toISOString(),
        total: live.length,
        correct,
        seconds: Math.round((Date.now() - Date.parse(cur.startedAt)) / 1000),
      };
      setState((st) => ({ ...st, results: [...st.results, result] }));
      void record({ results: [result] });
    }
    update((c) => ({ ...c, finished: true }), true);
  };

  const leave = () => {
    if (!ephemeral) saveSession(latest.current, s.exam, true);
    onExit();
  };
  const done = () => {
    if (!ephemeral) saveSession(null, s.exam, true);
    onExit();
  };

  const given = q ? (s.given[q.id] ?? "") : "";
  const checked = q ? !!s.checked[q.id] : false;
  const go = (i: number) => {
    update((c) => ({ ...c, index: Math.max(0, Math.min(qs.length - 1, i)) }));
    scrollTo(0, 0);
  };

  // Study modes reveal as soon as the answer is complete: one letter, all N for "choose N",
  // or every hotspot box filled. "Show answer" without one counts as a miss for SRS.
  const complete = (g: string) =>
    isInteractive(q) ? g.split(SEP).length === q.enrichment!.interactive!.items.length && g.split(SEP).every(Boolean) : g.length >= q.pick;
  // Questions still waiting for transcription review (reachable from Browse) can be read
  // but not scored, so they never touch history or the SRS schedule.
  const reveal = (g: string) => {
    const next = { ...s, given: { ...s.given, [q.id]: g } };
    if (playable(q, state)) setState((st) => grade(bank, st, next, [q.id]));
    update((c) => ({ ...c, given: { ...c.given, [q.id]: g }, checked: { ...c.checked, [q.id]: true } }), true);
  };
  const pick = (g: string) => {
    if (!isExam && complete(g)) return reveal(g);
    update((c) => ({ ...c, given: { ...c.given, [q.id]: g } }));
  };
  const toggleMark = () =>
    update((c) => ({ ...c, marked: c.marked.includes(q.id) ? c.marked.filter((x) => x !== q.id) : [...c.marked, q.id] }));
  const canAdvance = isExam || checked;
  const last = s.index === qs.length - 1;
  const advance = () => (last ? (ephemeral ? done() : finish()) : go(s.index + 1));

  // VCE-style keys: A–F or 1–6 pick, Enter/→ next (or show answer), ← back, F flag, M mark.
  useEffect(() => {
    if (s.finished || !q) return;
    const onKey = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      const idx = "abcdef".indexOf(k) >= 0 ? "abcdef".indexOf(k) : "123456".indexOf(k);
      if (k === "f") return toggleFlagFor(q, state, setState);
      if (idx >= 0 && !isInteractive(q) && (isExam || !checked)) {
        const letter = q.choices[idx]?.letter;
        if (letter) pick(togglePick(q, given, letter));
        return;
      }
      if (k === "m" && isExam) return toggleMark();
      if (k === "arrowleft" && s.index > 0) return go(s.index - 1);
      if (k === "enter" || k === "arrowright") {
        e.preventDefault();
        if (canAdvance) advance();
        else if (!isExam) reveal(given);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  if (s.finished) return <Results bank={bank} state={state} s={s} setState={setState} onExit={done} />;
  if (!q)
    return (
      <div class="empty">
        <p>No questions match.</p>
        <button onClick={done}>Back</button>
      </div>
    );

  const answeredCount = s.ids.filter((id) => s.given[id]).length;

  return (
    <div class="player">
      <div class="bar-top">
        <button class="ghost" onClick={leave} title="Leave; progress is kept">
          ←
        </button>
        <span class="mode">{ephemeral ? `Q${q.number}` : MODE_NAME[s.mode]}</span>
        {!ephemeral && (
          <span class="pos">
            {s.index + 1} / {qs.length}
          </span>
        )}
        {isExam && s.deadline && <Timer deadline={s.deadline} onExpire={finish} />}
      </div>

      <QuestionView
        q={q}
        exam={s.exam}
        state={state}
        given={given}
        revealed={!isExam && checked}
        onChange={isExam || !checked ? pick : undefined}
        onState={setState}
      />

      <div class="bar-bottom">
        {!ephemeral && (
          <button onClick={() => go(s.index - 1)} disabled={s.index === 0}>
            Previous
          </button>
        )}
        {isExam && (
          <button class={s.marked.includes(q.id) ? "marked" : ""} onClick={toggleMark}>
            {s.marked.includes(q.id) ? "Marked" : "Mark for review"}
          </button>
        )}
        {!isExam && !checked && <button onClick={() => reveal(given)}>Show answer</button>}
        {canAdvance && (
          <button class="primary" onClick={advance}>
            {last ? (ephemeral ? "Done" : "Finish") : "Next"}
          </button>
        )}
      </div>
      <p class="keys">Keys: A–F pick · Enter next · ← back · F flag{isExam ? " · M mark" : ""}</p>

      {isExam && (
        <nav class="grid" aria-label="Questions">
          {qs.map((x, i) => (
            <button
              class={["cell", i === s.index && "here", s.given[x.id] && "done", s.marked.includes(x.id) && "marked"]
                .filter(Boolean)
                .join(" ")}
              onClick={() => go(i)}
            >
              {i + 1}
            </button>
          ))}
          <button
            class="end"
            onClick={() => {
              const left = qs.length - answeredCount;
              if (!left || confirm(`${left} unanswered. Finish anyway?`)) finish();
            }}
          >
            End exam ({answeredCount}/{qs.length})
          </button>
        </nav>
      )}
    </div>
  );
}

function Timer({ deadline, onExpire }: { deadline: string; onExpire: () => void }) {
  const [left, setLeft] = useState(() => Date.parse(deadline) - Date.now());
  useEffect(() => {
    const t = setInterval(() => {
      const l = Date.parse(deadline) - Date.now();
      setLeft(l);
      if (l <= 0) {
        clearInterval(t);
        onExpire();
      }
    }, 1000);
    return () => clearInterval(t);
  }, [deadline]);
  const m = Math.max(0, Math.floor(left / 60000));
  const sec = Math.max(0, Math.floor((left % 60000) / 1000));
  return (
    <span class={`timer ${left < 5 * 60000 ? "low" : ""}`}>
      {m}:{String(sec).padStart(2, "0")}
    </span>
  );
}

function Results({
  bank,
  state,
  s,
  setState,
  onExit,
}: {
  bank: BankPayload;
  state: UserState;
  s: Session;
  setState: Props["setState"];
  onExit: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const qs = s.ids.map((id) => bank.questions.find((q) => q.id === id)!).filter(Boolean);
  const right = qs.filter((q) => s.given[q.id] && isCorrect(q, state, s.given[q.id]));
  const pct = qs.length ? Math.round((right.length / qs.length) * 100) : 0;
  const pass = pct >= bank.exam.settings.passPct;
  const shown = open ? qs.find((q) => q.id === open) : null;

  if (shown)
    return (
      <div class="player">
        <div class="bar-top">
          <button class="ghost" onClick={() => setOpen(null)}>
            ← Results
          </button>
        </div>
        <QuestionView q={shown} exam={s.exam} state={state} given={s.given[shown.id] ?? ""} revealed onState={setState} />
      </div>
    );

  return (
    <div class="results">
      <h2>{MODE_NAME[s.mode]} finished</h2>
      <p class={`score ${s.mode === "exam" ? (pass ? "ok" : "bad") : ""}`}>
        {right.length} / {qs.length} ({pct}%)
        {s.mode === "exam" && (
          <span>
            {" "}
            · {pass ? "Pass" : "Fail"} at {bank.exam.settings.passPct}%
          </span>
        )}
      </p>
      <ol class="result-list">
        {qs.map((q) => {
          const ok = right.includes(q);
          return (
            <li>
              <button class={`result ${ok ? "ok" : "bad"}`} onClick={() => setOpen(q.id)}>
                <span>
                  {ok ? "✓" : "✗"} Q{q.number}
                </span>
                <span class="muted">
                  {s.given[q.id] ? "" : "unanswered"}
                  {q.resolved.disputed ? " disputed" : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <button class="primary" onClick={onExit}>
        Done
      </button>
    </div>
  );
}

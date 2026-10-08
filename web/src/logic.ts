import { fsrs, createEmptyCard, generatorParameters, Rating, type CardInput } from "ts-fsrs";
import type { AnswerRow, BankQuestion, SrsRow, UserState } from "../../shared/schema.ts";

export type Mode = AnswerRow["mode"];
export const SEP = "\u001f";

export const isInteractive = (q: BankQuestion) => !!q.enrichment?.interactive;

// What the user is scored against: their own override, then a reviewed correction to a
// transcription, then the resolved answer.
export function effectiveAnswer(q: BankQuestion, s: UserState): string | null {
  const o = s.overrides.find((x) => x.questionId === q.id)?.answer;
  if (o) return o;
  const fixed = s.reviews.find((r) => r.questionId === q.id)?.items;
  if (fixed) return fixed.join(SEP);
  return q.resolved.items ? q.resolved.items.join(SEP) : q.resolved.answer;
}

export const normalise = (given: string, q: BankQuestion) => (isInteractive(q) ? given : [...given].sort().join(""));

export function isCorrect(q: BankQuestion, s: UserState, given: string) {
  const want = effectiveAnswer(q, s);
  return want != null && normalise(given, q) === normalise(want, q);
}

// Interactive questions stay out of practice until their transcription is confirmed.
export function playable(q: BankQuestion, s: UserState) {
  if (!isInteractive(q)) return true;
  return q.enrichment!.review === "reviewed" || s.reviews.some((r) => r.questionId === q.id && r.status === "reviewed");
}

export function needsReview(q: BankQuestion, s: UserState) {
  return isInteractive(q) && !playable(q, s);
}

const shuffle = <T>(xs: T[]) => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export function lastAnswers(s: UserState) {
  const last = new Map<string, AnswerRow>();
  for (const a of s.answers) if (!last.has(a.questionId) || a.at > last.get(a.questionId)!.at) last.set(a.questionId, a);
  return last;
}

export const isFlagged = (s: UserState, id: string) => !!s.flags.find((f) => f.questionId === id)?.flagged;

export function dueIds(s: UserState, now = new Date()) {
  return new Set(s.srs.filter((r) => new Date(r.due) <= now).map((r) => r.questionId));
}

export interface Pick {
  mode: Mode;
  count?: number;
  topic?: string;
  order?: "shuffle" | "number";
}

export function pickQuestions(qs: BankQuestion[], s: UserState, p: Pick): BankQuestion[] {
  let pool = qs.filter((q) => playable(q, s) && (!p.topic || q.topic === p.topic));
  if (p.mode === "weak") {
    const last = lastAnswers(s);
    pool = pool.filter((q) => isFlagged(s, q.id) || last.get(q.id)?.correct === false);
  }
  if (p.mode === "srs") {
    const due = dueIds(s);
    const seen = new Set(s.srs.map((r) => r.questionId));
    const dueQs = shuffle(pool.filter((q) => due.has(q.id)));
    const fresh = pool.filter((q) => !seen.has(q.id)).sort((a, b) => a.number - b.number);
    pool = [...dueQs, ...fresh.slice(0, Math.max(0, 10 - dueQs.length))]; // top up with up to 10 new
    return p.count ? pool.slice(0, p.count) : pool;
  }
  pool = p.order === "number" ? pool.sort((a, b) => a.number - b.number) : shuffle(pool);
  return p.count ? pool.slice(0, p.count) : pool;
}

const scheduler = fsrs(generatorParameters({ enable_fuzz: true }));

// Every graded answer, in any mode, moves the question's spaced-repetition card.
export function nextSrs(q: BankQuestion, exam: string, s: UserState, correct: boolean, at = new Date()): SrsRow {
  const prev = s.srs.find((r) => r.questionId === q.id)?.card as CardInput | undefined;
  const { card } = scheduler.next(prev ?? createEmptyCard(at), at, correct ? Rating.Good : Rating.Again);
  return { questionId: q.id, exam, card, due: new Date(card.due).toISOString(), at: at.toISOString() };
}

export function stats(qs: BankQuestion[], s: UserState) {
  const last = lastAnswers(s);
  const ids = new Set(qs.map((q) => q.id));
  const seen = [...last.values()].filter((a) => ids.has(a.questionId));
  return {
    total: qs.length,
    seen: seen.length,
    correct: seen.filter((a) => a.correct).length,
    weak: qs.filter((q) => isFlagged(s, q.id) || last.get(q.id)?.correct === false).length,
    due: [...dueIds(s)].filter((id) => ids.has(id)).length,
    toReview: qs.filter((q) => needsReview(q, s)).length,
  };
}

// Choosing a letter: replaces for single-answer, toggles up to `pick` for "choose N".
export function togglePick(q: BankQuestion, given: string, letter: string): string {
  if (q.pick <= 1) return letter;
  const set = new Set(given);
  if (set.has(letter)) set.delete(letter);
  else if (set.size < q.pick) set.add(letter);
  return [...set].sort().join("");
}

export function topicStats(qs: BankQuestion[], s: UserState) {
  const last = lastAnswers(s);
  const by = new Map<string, { topic: string; total: number; seen: number; correct: number }>();
  for (const q of qs) {
    const t = by.get(q.topic) ?? { topic: q.topic, total: 0, seen: 0, correct: 0 };
    t.total++;
    const a = last.get(q.id);
    if (a) {
      t.seen++;
      if (a.correct) t.correct++;
    }
    by.set(q.topic, t);
  }
  return [...by.values()].sort((a, b) => a.topic.localeCompare(b.topic));
}

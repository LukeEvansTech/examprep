// Pure merge helpers for the offline outbox (kept free of browser globals so they unit-test in Node).
import type { SyncPush, UserState } from "../../shared/schema.ts";

// Only the queued rows that belong to one exam: rows carrying an exam code match on it,
// rows keyed by question match on the exam's question ids.
export function forExam(p: SyncPush, code: string, ids: Set<string>): SyncPush {
  const byExam = <T extends { exam: string }>(rows?: T[]) => rows?.filter((r) => r.exam === code);
  const byQuestion = <T extends { questionId: string }>(rows?: T[]) => rows?.filter((r) => ids.has(r.questionId));
  return {
    sessions: byExam(p.sessions),
    results: byExam(p.results),
    answers: byExam(p.answers),
    srs: byExam(p.srs),
    overrides: byQuestion(p.overrides),
    notes: byQuestion(p.notes),
    flags: byQuestion(p.flags),
    reviews: byQuestion(p.reviews),
  };
}

// Mirrors the server's merge rules closely enough for display between syncs.
export function applyPush(s: UserState, p: SyncPush): UserState {
  const seen = new Set(s.answers.map((a) => a.id));
  for (const a of p.answers ?? []) if (!seen.has(a.id)) s.answers.push(a);
  const seenResults = new Set(s.results.map((r) => r.id));
  for (const r of p.results ?? []) if (!seenResults.has(r.id)) s.results.push(r);
  for (const x of p.sessions ?? []) if (!s.session || x.at > s.session.at) s.session = x;
  const upsert = <T extends { questionId: string; at: string }>(list: T[], rows: T[] = []) => {
    for (const r of rows) {
      const i = list.findIndex((x) => x.questionId === r.questionId);
      if (i < 0) list.push(r);
      else if (r.at > list[i].at) list[i] = r;
    }
  };
  upsert(s.srs, p.srs);
  upsert(s.overrides, p.overrides);
  upsert(s.notes, p.notes);
  upsert(s.flags, p.flags);
  upsert(s.reviews, p.reviews);
  return s;
}

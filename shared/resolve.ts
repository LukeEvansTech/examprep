import type { Enrichment, Question, Resolved } from "./schema.ts";

export const MIN_VOTES = 3;
export const DISPUTE_PCT = 70;

const sortLetters = (s: string) => [...s].sort().join("");

// SPEC.md "Correct answer": enough votes → community; otherwise the suggested answer if the
// docs agree; when they disagree, score against the docs and flag the question disputed.
export function resolve(q: Question, e?: Enrichment): Resolved {
  if (e?.interactive) {
    const disagree = e.docsVerdict === "disagrees";
    return {
      answer: null,
      items: e.interactive.items.map((i) => (disagree && i.docsAnswer) || i.answer),
      basis: disagree ? "docs" : e.docsVerdict === "agrees" ? "suggested+docs" : "suggested",
      disputed: disagree,
    };
  }

  const total = q.votes.reduce((n, v) => n + v.votes, 0);
  if (total >= MIN_VOTES) {
    const top = q.votes.reduce((a, b) => (b.percent > a.percent ? b : a));
    const docsClash = !!e?.docsAnswer && sortLetters(e.docsAnswer) !== sortLetters(top.answer);
    return { answer: sortLetters(top.answer), items: null, basis: "community", disputed: top.percent < DISPUTE_PCT || docsClash };
  }

  if (e?.docsVerdict === "disagrees" && e.docsAnswer) {
    return { answer: sortLetters(e.docsAnswer), items: null, basis: "docs", disputed: true };
  }
  const answer = q.suggested ? sortLetters(q.suggested) : null;
  return { answer, items: null, basis: e?.docsVerdict === "agrees" ? "suggested+docs" : "suggested", disputed: false };
}

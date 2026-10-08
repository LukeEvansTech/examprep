import { test } from "node:test";
import assert from "node:assert/strict";
import type { BankQuestion, UserState } from "../../shared/schema.ts";
import { isCorrect, pickQuestions, reconcile, stats, togglePick, topicStats } from "./logic.ts";

const q = (id: string, topic: string, over: Partial<BankQuestion> = {}): BankQuestion => ({
  id,
  number: Number(id),
  topic,
  kind: "single",
  stemHtml: "",
  images: [],
  choices: [],
  pick: 1,
  suggested: "A",
  suggestedImage: null,
  votes: [],
  discussionId: null,
  enrichment: null,
  resolved: { answer: "A", items: null, basis: "suggested", disputed: false },
  ...over,
});
const empty = (): UserState => ({
  session: null,
  results: [],
  answers: [],
  srs: [],
  overrides: [],
  notes: [],
  flags: [],
  reviews: [],
  ourVotes: {},
});
const answerRow = (questionId: string, correct: boolean, at: string) => ({
  id: `${questionId}-${at}`,
  questionId,
  exam: "x",
  mode: "study" as const,
  given: correct ? "A" : "B",
  correct,
  at,
});

test("togglePick: single replaces, choose-two toggles and caps", () => {
  const single = q("1", "t");
  const two = q("2", "t", { pick: 2 });
  assert.equal(togglePick(single, "A", "C"), "C");
  assert.equal(togglePick(two, "", "C"), "C");
  assert.equal(togglePick(two, "C", "A"), "AC");
  assert.equal(togglePick(two, "AC", "B"), "AC"); // already two
  assert.equal(togglePick(two, "AC", "A"), "C");
});

test("topic stats use each question's latest attempt", () => {
  const qs = [q("1", "T1"), q("2", "T1"), q("3", "T2")];
  const s = empty();
  s.answers = [
    answerRow("1", false, "2026-10-08T01:00:00Z"),
    answerRow("1", true, "2026-10-08T02:00:00Z"),
    answerRow("2", false, "2026-10-08T01:00:00Z"),
  ];
  assert.deepEqual(topicStats(qs, s), [
    { topic: "T1", total: 2, seen: 2, correct: 1 },
    { topic: "T2", total: 1, seen: 0, correct: 0 },
  ]);
  const st = stats(qs, s);
  assert.deepEqual([st.seen, st.correct, st.weak], [2, 1, 1]);
});

test("weak spots = last wrong or flagged; override changes what counts as right", () => {
  const qs = [q("1", "T"), q("2", "T"), q("3", "T")];
  const s = empty();
  s.answers = [answerRow("1", false, "2026-10-08T01:00:00Z"), answerRow("2", true, "2026-10-08T01:00:00Z")];
  s.flags = [{ questionId: "3", flagged: true, at: "2026-10-08T01:00:00Z" }];
  assert.deepEqual(
    pickQuestions(qs, s, { mode: "weak", order: "number" }).map((x) => x.id),
    ["1", "3"],
  );
  s.overrides = [{ questionId: "1", answer: "B", at: "2026-10-08T01:00:00Z" }];
  assert.equal(isCorrect(qs[0], s, "B"), true);
  assert.equal(isCorrect(qs[0], s, "A"), false);
});

test("unreviewed hotspot questions are left out of practice", () => {
  const hs = q("9", "T", {
    kind: "hotspot",
    enrichment: {
      id: "9",
      explanation: "",
      docsAnswer: null,
      docsVerdict: "agrees",
      sources: [],
      review: "unreviewed",
      interactive: { type: "hotspot", items: [{ label: "x", options: ["a", "b"], answer: "a" }] },
    },
  });
  const s = empty();
  assert.equal(pickQuestions([hs], s, { mode: "study" }).length, 0);
  s.reviews = [{ questionId: "9", status: "reviewed", at: "2026-10-08T01:00:00Z" }];
  assert.equal(pickQuestions([hs], s, { mode: "study" }).length, 1);
});

test("image-only questions without a transcription never enter practice", () => {
  const bare = q("7", "T", { kind: "hotspot", choices: [], suggested: null, suggestedImage: "x.png" });
  assert.equal(pickQuestions([bare], empty(), { mode: "exam" }).length, 0);
});

test("reconcile keeps the position on the same question after a re-import archives some", () => {
  const bank = { questions: [{ id: "b" }, { id: "c" }] };
  assert.deepEqual(reconcile({ ids: ["a", "b", "c"], index: 1 }, bank), { ids: ["b", "c"], index: 0 });
  assert.deepEqual(reconcile({ ids: ["a", "b", "x"], index: 2 }, bank), { ids: ["b"], index: 0 });
  const same = { ids: ["b", "c"], index: 1 };
  assert.equal(reconcile(same, bank), same);
});

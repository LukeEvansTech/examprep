import { test } from "node:test";
import assert from "node:assert/strict";
import type { UserState } from "../../shared/schema.ts";
import { applyPush, forExam } from "./sync.ts";

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
const at = "2026-10-08T01:00:00Z";

test("queued rows for another exam don't leak into this one", () => {
  const box = {
    sessions: [
      { exam: "a", data: { ids: ["1"] }, at },
      { exam: "b", data: { ids: ["9"] }, at: "2026-10-08T02:00:00Z" },
    ],
    answers: [
      { id: "x", questionId: "1", exam: "a", mode: "study" as const, given: "A", correct: true, at },
      { id: "y", questionId: "9", exam: "b", mode: "study" as const, given: "A", correct: true, at },
    ],
    notes: [
      { questionId: "1", text: "a note", at },
      { questionId: "9", text: "b note", at },
    ],
  };
  const s = applyPush(empty(), forExam(box, "a", new Set(["1"])));
  assert.deepEqual(s.session?.data, { ids: ["1"] });
  assert.deepEqual(
    s.answers.map((r) => r.id),
    ["x"],
  );
  assert.deepEqual(
    s.notes.map((n) => n.text),
    ["a note"],
  );
});

test("applyPush keeps the newer of two writes", () => {
  const s = empty();
  s.notes = [{ questionId: "1", text: "new", at: "2026-10-08T02:00:00Z" }];
  applyPush(s, { notes: [{ questionId: "1", text: "old", at }] });
  assert.equal(s.notes[0].text, "new");
});

test("duplicate queued results from two tabs are merged once", () => {
  const r = { id: "s1", exam: "a", at, total: 3, correct: 2, seconds: 60 };
  const s = applyPush(empty(), { results: [r, { ...r }] });
  assert.equal(s.results.length, 1);
});

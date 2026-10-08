import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "./resolve.ts";
import type { Enrichment, Question } from "./schema.ts";

const q = (over: Partial<Question> = {}): Question => ({
  id: "1",
  number: 1,
  topic: "",
  kind: "single",
  stemHtml: "",
  images: [],
  choices: [],
  pick: 1,
  suggested: "D",
  suggestedImage: null,
  votes: [],
  discussionId: null,
  ...over,
});
const e = (over: Partial<Enrichment> = {}): Enrichment => ({
  id: "1",
  explanation: "",
  docsAnswer: "D",
  docsVerdict: "agrees",
  sources: [],
  review: "unreviewed",
  ...over,
});

test("3+ votes: community wins", () => {
  const r = resolve(q({ votes: [{ answer: "A", percent: 100, votes: 3 }] }), e({ docsAnswer: "A", docsVerdict: "disagrees" }));
  assert.deepEqual([r.answer, r.basis, r.disputed], ["A", "community", false]);
});

test("3+ votes but split under 70%: disputed", () => {
  const r = resolve(
    q({
      votes: [
        { answer: "A", percent: 60, votes: 3 },
        { answer: "B", percent: 40, votes: 2 },
      ],
    }),
    e({ docsAnswer: "A" }),
  );
  assert.deepEqual([r.answer, r.disputed], ["A", true]);
});

test("3+ votes contradicting the docs: community answer, but disputed", () => {
  const r = resolve(q({ votes: [{ answer: "A", percent: 100, votes: 4 }] }), e({ docsAnswer: "D" }));
  assert.deepEqual([r.answer, r.disputed], ["A", true]);
});

test("few votes, docs agree with suggested", () => {
  const r = resolve(q({ votes: [{ answer: "A", percent: 100, votes: 2 }] }), e());
  assert.deepEqual([r.answer, r.basis, r.disputed], ["D", "suggested+docs", false]);
});

test("few votes, docs disagree: docs answer, disputed", () => {
  const r = resolve(q(), e({ docsAnswer: "CA", docsVerdict: "disagrees" }));
  assert.deepEqual([r.answer, r.basis, r.disputed], ["AC", "docs", true]);
});

test("no enrichment yet: suggested", () => {
  assert.deepEqual(resolve(q()).basis, "suggested");
});

test("hotspot: docs override only the items they dispute", () => {
  const r = resolve(
    q({ kind: "hotspot", suggested: null }),
    e({
      docsAnswer: null,
      docsVerdict: "disagrees",
      interactive: {
        type: "hotspot",
        items: [
          { label: "1", options: ["x", "y"], answer: "x", docsAnswer: "y" },
          { label: "2", options: ["a", "b"], answer: "a" },
        ],
      },
    }),
  );
  assert.deepEqual([r.items, r.disputed], [["y", "a"], true]);
});

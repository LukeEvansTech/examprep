import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import type { BankPayload, BankQuestion, UserState } from "../shared/schema.ts";

const KEY = "test-key-123";
const auth = { authorization: `Bearer ${KEY}`, "content-type": "application/json" };

const question = (id: string, number: number): BankQuestion => ({
  id,
  number,
  topic: "",
  kind: "single",
  stemHtml: "?",
  images: [],
  choices: [],
  pick: 1,
  suggested: "A",
  suggestedImage: null,
  votes: [],
  discussionId: null,
  enrichment: null,
  resolved: { answer: "A", items: null, basis: "suggested", disputed: false },
});
const bank = (qs: BankQuestion[]): BankPayload => ({
  exam: { code: "xx-100", vendor: "v", title: "XX", totalOnSite: 9, settings: { examQuestions: 5, minutes: 10, passPct: 70 } },
  importedAt: "2026-10-08T00:00:00Z",
  questions: qs,
});

const setup = () => createApp({ db: openDb(":memory:"), uploadKey: KEY });

test("upload needs the key", async () => {
  const app = setup();
  const r = await app.request("/api/exams/xx-100", {
    method: "PUT",
    body: JSON.stringify(bank([])),
    headers: { "content-type": "application/json" },
  });
  assert.equal(r.status, 401);
  const w = await app.request("/api/exams/xx-100", {
    method: "PUT",
    body: JSON.stringify(bank([])),
    headers: { ...auth, authorization: "Bearer wrong-key-12" },
  });
  assert.equal(w.status, 401);
});

test("re-import merges by id and archives missing questions, keeping progress", async () => {
  const app = setup();
  await app.request("/api/exams/xx-100", {
    method: "PUT",
    headers: auth,
    body: JSON.stringify(bank([question("1", 1), question("2", 2)])),
  });
  await app.request("/api/sync", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({
      answers: [{ id: "a1", questionId: "1", exam: "xx-100", mode: "study", given: "A", correct: true, at: "2026-10-08T01:00:00Z" }],
    }),
  });
  const r = await app.request("/api/exams/xx-100", {
    method: "PUT",
    headers: auth,
    body: JSON.stringify(bank([question("1", 1), question("3", 3)])),
  });
  assert.deepEqual(await r.json(), { added: 1, updated: 2, archived: 1 });
  const b = (await (await app.request("/api/exams/xx-100/bank")).json()) as BankPayload;
  assert.deepEqual(
    b.questions.map((q) => q.id),
    ["1", "3"],
  );
  const s = (await (await app.request("/api/exams/xx-100/state")).json()) as UserState;
  assert.equal(s.answers.length, 1);
});

test("sync is idempotent and last-write-wins", async () => {
  const app = setup();
  await app.request("/api/exams/xx-100", { method: "PUT", headers: auth, body: JSON.stringify(bank([question("1", 1)])) });
  const push = (body: object) => app.request("/api/sync", { method: "POST", headers: auth, body: JSON.stringify(body) });
  const answerRow = { id: "a1", questionId: "1", exam: "xx-100", mode: "study", given: "B", correct: false, at: "2026-10-08T01:00:00Z" };
  await push({ answers: [answerRow], notes: [{ questionId: "1", text: "new", at: "2026-10-08T02:00:00Z" }] });
  await push({ answers: [answerRow], notes: [{ questionId: "1", text: "stale", at: "2026-10-08T01:30:00Z" }] });
  await push({ overrides: [{ questionId: "1", answer: "C", at: "2026-10-08T01:00:00Z" }] });
  const s = (await (await app.request("/api/exams/xx-100/state")).json()) as UserState;
  assert.equal(s.answers.length, 1);
  assert.equal(s.notes[0].text, "new");
  assert.deepEqual(s.ourVotes, { "1": { C: 1 } });
});

test("images: upload with key, served without", async () => {
  const app = setup();
  const png = new Uint8Array([137, 80, 78, 71]);
  const bad = await app.request("/api/exams/xx-100/images/../x.png", {
    method: "PUT",
    headers: { authorization: `Bearer ${KEY}` },
    body: png,
  });
  assert.notEqual(bad.status, 200);
  const ok = await app.request("/api/exams/xx-100/images/image1.png", {
    method: "PUT",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "image/png" },
    body: png,
  });
  assert.equal(ok.status, 200);
  const got = await app.request("/img/xx-100/image1.png");
  assert.equal(got.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), png);
});

test("sessions resume across devices (newest wins) and reset keeps notes", async () => {
  const app = setup();
  await app.request("/api/exams/xx-100", { method: "PUT", headers: auth, body: JSON.stringify(bank([question("1", 1)])) });
  const push = (body: object) => app.request("/api/sync", { method: "POST", headers: auth, body: JSON.stringify(body) });
  await push({ sessions: [{ exam: "xx-100", data: { index: 4 }, at: "2026-10-08T02:00:00Z" }] });
  await push({ sessions: [{ exam: "xx-100", data: { index: 1 }, at: "2026-10-08T01:00:00Z" }] }); // stale device
  await push({
    results: [{ id: "r1", exam: "xx-100", at: "2026-10-08T03:00:00Z", total: 10, correct: 7, seconds: 600 }],
    answers: [{ id: "a1", questionId: "1", exam: "xx-100", mode: "exam", given: "A", correct: true, at: "2026-10-08T03:00:00Z" }],
    flags: [{ questionId: "1", flagged: true, at: "2026-10-08T03:00:00Z" }],
    notes: [{ questionId: "1", text: "keep me", at: "2026-10-08T03:00:00Z" }],
  });
  let s = (await (await app.request("/api/exams/xx-100/state")).json()) as UserState;
  assert.deepEqual(s.session?.data, { index: 4 });
  assert.equal(s.results.length, 1);

  const r = await app.request("/api/exams/xx-100/progress", { method: "DELETE" });
  assert.equal(r.status, 200);
  s = (await (await app.request("/api/exams/xx-100/state")).json()) as UserState;
  assert.deepEqual([s.session, s.results.length, s.answers.length, s.flags.length, s.notes.length], [null, 0, 0, 0, 1]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import type { BankPayload, BankQuestion, UserState } from "../shared/schema.ts";
import { transcriptionRev } from "../shared/rev.ts";

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
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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
  assert.deepEqual([s.session?.data, s.results.length, s.answers.length, s.flags.length, s.notes.length], [null, 0, 0, 0, 1]);
});

test("a request claiming another user's data is refused", async () => {
  const app = setup();
  const ok = await app.request("/api/exams", { headers: { "x-examprep-user": "1" } });
  assert.equal(ok.status, 200);
  const stale = await app.request("/api/sync", { method: "POST", headers: { ...auth, "x-examprep-user": "2" }, body: "{}" });
  assert.equal(stale.status, 409);
});

test("reset leaves a newer empty session so stale copies elsewhere lose", async () => {
  const app = setup();
  await app.request("/api/exams/xx-100", { method: "PUT", headers: auth, body: JSON.stringify(bank([question("1", 1)])) });
  await app.request("/api/sync", {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ sessions: [{ exam: "xx-100", data: { index: 2 }, at: "2026-10-08T01:00:00Z" }] }),
  });
  await app.request("/api/exams/xx-100/progress", { method: "DELETE" });
  const s = (await (await app.request("/api/exams/xx-100/state")).json()) as UserState;
  assert.equal(s.session?.data, null);
  assert.ok(s.session && s.session.at > "2026-10-08T01:00:00Z");
});

test("a pre-reset queue retried after a reset can't bring progress back", async () => {
  const app = setup();
  await app.request("/api/exams/xx-100", { method: "PUT", headers: auth, body: JSON.stringify(bank([question("1", 1)])) });
  const old = {
    answers: [{ id: "a1", questionId: "1", exam: "xx-100", mode: "study", given: "A", correct: true, at: "2026-01-01T00:00:00Z" }],
    flags: [{ questionId: "1", flagged: true, at: "2026-01-01T00:00:00Z" }],
  };
  await app.request("/api/sync", { method: "POST", headers: auth, body: JSON.stringify(old) });
  await app.request("/api/exams/xx-100/progress", { method: "DELETE" });
  await app.request("/api/sync", { method: "POST", headers: auth, body: JSON.stringify(old) }); // the retry
  const fresh = { answers: [{ ...old.answers[0], id: "a2", at: new Date(Date.now() + 1000).toISOString() }] };
  await app.request("/api/sync", { method: "POST", headers: auth, body: JSON.stringify(fresh) });
  const s = (await (await app.request("/api/exams/xx-100/state")).json()) as UserState;
  assert.deepEqual(
    s.answers.map((a) => a.id),
    ["a2"],
  );
  assert.equal(s.flags.length, 0);
});

test("uploads that aren't real images are refused, and the type comes from the bytes", async () => {
  const app = setup();
  const html = new TextEncoder().encode("<script>alert(1)</script>");
  const bad = await app.request("/api/exams/xx-100/images/x.png", {
    method: "PUT",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "image/png" },
    body: html,
  });
  assert.equal(bad.status, 415);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  await app.request("/api/exams/xx-100/images/y.png", {
    method: "PUT",
    headers: { authorization: `Bearer ${KEY}`, "content-type": "text/html" },
    body: png,
  });
  const got = await app.request("/img/xx-100/y.png");
  assert.equal(got.headers.get("content-type"), "image/png");
  assert.equal(got.headers.get("x-content-type-options"), "nosniff");
  assert.match(got.headers.get("cache-control") ?? "", /private/);
});

test("re-importing a changed transcription sends the question back for review", async () => {
  const app = setup();
  const hs = (answer: string): BankQuestion => ({
    ...question("1", 1),
    kind: "hotspot",
    enrichment: {
      id: "1",
      explanation: "",
      docsAnswer: null,
      docsVerdict: "agrees",
      sources: [],
      review: "unreviewed",
      interactive: { type: "hotspot", items: [{ label: "x", options: ["a", "b", answer], answer }] },
    },
  });
  const review = (answer: string, at: string) => ({
    reviews: [{ questionId: "1", status: "reviewed", rev: transcriptionRev(hs(answer).enrichment!.interactive), at }],
  });
  const put = (answer: string) =>
    app.request("/api/exams/xx-100", { method: "PUT", headers: auth, body: JSON.stringify(bank([hs(answer)])) });
  const sync = (body: object) => app.request("/api/sync", { method: "POST", headers: auth, body: JSON.stringify(body) });
  const status = async () => ((await (await app.request("/api/exams/xx-100/state")).json()) as UserState).reviews[0]?.status;

  await put("c");
  await sync(review("c", "2026-10-08T01:00:00Z"));
  await put("c"); // unchanged: the review stands
  assert.equal(await status(), "reviewed");
  await put("d"); // changed: back to the queue
  assert.equal(await status(), "unreviewed");
  await sync(review("c", "2026-10-08T01:00:00Z")); // an old confirmation retried
  assert.equal(await status(), "unreviewed");
  await sync(review("c", new Date(Date.now() + 60_000).toISOString())); // newer, but made on the old transcription
  assert.equal(await status(), "unreviewed");
  await sync(review("d", new Date(Date.now() + 120_000).toISOString())); // a review of the current one
  assert.equal(await status(), "reviewed");
});

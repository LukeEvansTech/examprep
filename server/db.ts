import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createHash } from "node:crypto";
import type {
  AnswerRow,
  BankPayload,
  BankQuestion,
  FlagRow,
  NoteRow,
  OverrideRow,
  ResultRow,
  ReviewRow,
  SessionRow,
  SrsRow,
  SyncPush,
  UserState,
} from "../shared/schema.ts";

export type Db = ReturnType<typeof openDb>;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  name TEXT,
  UNIQUE (issuer, subject)
);
INSERT OR IGNORE INTO users (id, issuer, subject, name) VALUES (1, 'local', 'local', 'Local');
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS exams (
  code TEXT PRIMARY KEY,
  meta TEXT NOT NULL,
  imported_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  exam TEXT NOT NULL REFERENCES exams(code),
  number INTEGER NOT NULL,
  data TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS images (
  exam TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY (exam, name)
);
CREATE TABLE IF NOT EXISTS answers (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  question_id TEXT NOT NULL,
  exam TEXT NOT NULL,
  mode TEXT NOT NULL,
  given TEXT NOT NULL,
  correct INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS answers_user ON answers (user_id, exam);
CREATE TABLE IF NOT EXISTS srs (
  user_id INTEGER NOT NULL REFERENCES users(id),
  question_id TEXT NOT NULL,
  exam TEXT NOT NULL,
  card TEXT NOT NULL,
  due TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (user_id, question_id)
);
CREATE TABLE IF NOT EXISTS overrides (
  user_id INTEGER NOT NULL REFERENCES users(id),
  question_id TEXT NOT NULL,
  answer TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (user_id, question_id)
);
CREATE TABLE IF NOT EXISTS notes (
  user_id INTEGER NOT NULL REFERENCES users(id),
  question_id TEXT NOT NULL,
  text TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (user_id, question_id)
);
CREATE TABLE IF NOT EXISTS flags (
  user_id INTEGER NOT NULL REFERENCES users(id),
  question_id TEXT NOT NULL,
  flagged INTEGER NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (user_id, question_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  user_id INTEGER NOT NULL REFERENCES users(id),
  exam TEXT NOT NULL,
  data TEXT,
  at TEXT NOT NULL,
  PRIMARY KEY (user_id, exam)
);
CREATE TABLE IF NOT EXISTS resets (
  user_id INTEGER NOT NULL REFERENCES users(id),
  exam TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (user_id, exam)
);
CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  exam TEXT NOT NULL,
  at TEXT NOT NULL,
  total INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  seconds INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  question_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,
  items TEXT,
  at TEXT NOT NULL
);
`;

export function openDb(path: string) {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const userCols = (db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map((c) => c.name);
  if (!userCols.includes("email")) db.exec(`ALTER TABLE users ADD COLUMN email TEXT`);

  const all = <T>(sql: string, ...args: SQLInputValue[]) => db.prepare(sql).all(...args) as unknown as T[];
  const hash = (token: string) => createHash("sha256").update(token).digest("hex");
  const later = (days: number) => new Date(Date.now() + days * 86400_000).toISOString();

  const tx = <T>(fn: () => T): T => {
    db.exec("BEGIN");
    try {
      const r = fn();
      db.exec("COMMIT");
      return r;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };

  // Last write wins on `at`, so a stale offline edit never overwrites a newer one.
  const lww = (table: string, cols: string[]) =>
    db.prepare(
      `INSERT INTO ${table} (user_id, question_id, ${cols.join(", ")}) VALUES (?, ?, ${cols.map(() => "?").join(", ")})
       ON CONFLICT (user_id, question_id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}
       WHERE excluded.at > ${table}.at`,
    );
  const put = {
    answer: db.prepare(
      `INSERT OR IGNORE INTO answers (id, user_id, question_id, exam, mode, given, correct, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    srs: lww("srs", ["exam", "card", "due", "at"]),
    override: lww("overrides", ["answer", "at"]),
    note: lww("notes", ["text", "at"]),
    flag: lww("flags", ["flagged", "at"]),
    session: db.prepare(
      `INSERT INTO sessions (user_id, exam, data, at) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, exam) DO UPDATE SET data = excluded.data, at = excluded.at
       WHERE excluded.at > sessions.at`,
    ),
    result: db.prepare(`INSERT OR IGNORE INTO results (id, user_id, exam, at, total, correct, seconds) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    review: db.prepare(
      `INSERT INTO reviews (question_id, user_id, status, items, at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (question_id) DO UPDATE SET user_id = excluded.user_id, status = excluded.status,
         items = excluded.items, at = excluded.at
       WHERE excluded.at > reviews.at`,
    ),
  };

  return {
    raw: db,

    userId(issuer: string, subject: string, name?: string): number {
      db.prepare(`INSERT OR IGNORE INTO users (issuer, subject, name) VALUES (?, ?, ?)`).run(issuer, subject, name ?? null);
      const row = db.prepare(`SELECT id FROM users WHERE issuer = ? AND subject = ?`).get(issuer, subject) as { id: number };
      return row.id;
    },

    user(id: number) {
      return db.prepare(`SELECT id, name, email FROM users WHERE id = ?`).get(id) as { id: number; name: string; email: string | null };
    },

    // The first person to sign in takes over the progress recorded before login existed.
    signIn(issuer: string, subject: string, name: string, email: string | null): number {
      return tx(() => {
        const found = db.prepare(`SELECT id FROM users WHERE issuer = ? AND subject = ?`).get(issuer, subject) as
          | { id: number }
          | undefined;
        if (found) {
          db.prepare(`UPDATE users SET name = ?, email = ? WHERE id = ?`).run(name, email, found.id);
          return found.id;
        }
        const others = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE issuer != 'local'`).get() as { n: number };
        if (others.n === 0) {
          const claimed = db
            .prepare(`UPDATE users SET issuer = ?, subject = ?, name = ?, email = ? WHERE issuer = 'local' AND subject = 'local'`)
            .run(issuer, subject, name, email);
          if (Number(claimed.changes))
            return (db.prepare(`SELECT id FROM users WHERE issuer = ? AND subject = ?`).get(issuer, subject) as { id: number }).id;
        }
        db.prepare(`INSERT INTO users (issuer, subject, name, email) VALUES (?, ?, ?, ?)`).run(issuer, subject, name, email);
        return (db.prepare(`SELECT id FROM users WHERE issuer = ? AND subject = ?`).get(issuer, subject) as { id: number }).id;
      });
    },

    createSession(token: string, userId: number, days: number) {
      db.prepare(`DELETE FROM auth_sessions WHERE expires_at < ?`).run(new Date().toISOString());
      db.prepare(`INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)`).run(hash(token), userId, later(days));
    },

    // Sliding expiry: each use pushes the session out another 30 days.
    sessionUser(token: string): number | null {
      const row = db.prepare(`SELECT user_id, expires_at FROM auth_sessions WHERE token_hash = ?`).get(hash(token)) as
        | { user_id: number; expires_at: string }
        | undefined;
      if (!row || row.expires_at < new Date().toISOString()) return null;
      if (Date.parse(row.expires_at) - Date.now() < 29 * 86400_000)
        db.prepare(`UPDATE auth_sessions SET expires_at = ? WHERE token_hash = ?`).run(later(30), hash(token));
      return row.user_id;
    },

    deleteSession(token: string) {
      db.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`).run(hash(token));
    },

    // Merge by question id: new and changed questions are written, missing ones archived.
    importBank(p: BankPayload) {
      return tx(() => {
        const { questions, ...rest } = p;
        db.prepare(
          `INSERT INTO exams (code, meta, imported_at) VALUES (?, ?, ?)
           ON CONFLICT (code) DO UPDATE SET meta = excluded.meta, imported_at = excluded.imported_at`,
        ).run(p.exam.code, JSON.stringify(rest.exam), p.importedAt);
        const before = new Set(
          (db.prepare(`SELECT id FROM questions WHERE exam = ?`).all(p.exam.code) as { id: string }[]).map((r) => r.id),
        );
        const up = db.prepare(
          `INSERT INTO questions (id, exam, number, data, archived) VALUES (?, ?, ?, ?, 0)
           ON CONFLICT (id) DO UPDATE SET number = excluded.number, data = excluded.data, archived = 0`,
        );
        for (const q of questions) up.run(q.id, p.exam.code, q.number, JSON.stringify(q));
        const seen = new Set(questions.map((q) => q.id));
        const gone = [...before].filter((id) => !seen.has(id));
        const arch = db.prepare(`UPDATE questions SET archived = 1 WHERE id = ?`);
        for (const id of gone) arch.run(id);
        return { added: questions.filter((q) => !before.has(q.id)).length, updated: questions.length, archived: gone.length };
      });
    },

    putImage(exam: string, name: string, mime: string, bytes: Uint8Array) {
      db.prepare(
        `INSERT INTO images (exam, name, mime, bytes) VALUES (?, ?, ?, ?)
         ON CONFLICT (exam, name) DO UPDATE SET mime = excluded.mime, bytes = excluded.bytes`,
      ).run(exam, name, mime, bytes);
    },

    image(exam: string, name: string) {
      return db.prepare(`SELECT mime, bytes FROM images WHERE exam = ? AND name = ?`).get(exam, name) as
        | { mime: string; bytes: Uint8Array }
        | undefined;
    },

    exams() {
      return (
        db
          .prepare(
            `SELECT e.meta, e.imported_at AS importedAt,
           (SELECT COUNT(*) FROM questions q WHERE q.exam = e.code AND q.archived = 0) AS count
         FROM exams e ORDER BY e.code`,
          )
          .all() as { meta: string; importedAt: string; count: number }[]
      ).map((r) => ({
        ...JSON.parse(r.meta),
        importedAt: r.importedAt,
        count: r.count,
      }));
    },

    bank(code: string): BankPayload | null {
      const e = db.prepare(`SELECT meta, imported_at FROM exams WHERE code = ?`).get(code) as
        | { meta: string; imported_at: string }
        | undefined;
      if (!e) return null;
      const questions = (
        db.prepare(`SELECT data FROM questions WHERE exam = ? AND archived = 0 ORDER BY number`).all(code) as { data: string }[]
      ).map((r) => JSON.parse(r.data) as BankQuestion);
      return { exam: JSON.parse(e.meta), importedAt: e.imported_at, questions };
    },

    sync(userId: number, p: SyncPush) {
      // Progress written before the exam's last reset (a device retrying an old queue) is dropped.
      const cutoffs = new Map(
        all<{ exam: string; at: string }>(`SELECT exam, at FROM resets WHERE user_id = ?`, userId).map((r) => [r.exam, r.at]),
      );
      const examOf = db.prepare(`SELECT exam FROM questions WHERE id = ?`);
      const fresh = (exam: string | undefined, at: string) => !exam || !cutoffs.has(exam) || at > cutoffs.get(exam)!;
      const freshQ = (questionId: string, at: string) => fresh((examOf.get(questionId) as { exam: string } | undefined)?.exam, at);
      tx(() => {
        for (const x of p.sessions ?? []) put.session.run(userId, x.exam, x.data == null ? null : JSON.stringify(x.data), x.at);
        for (const r of p.results ?? []) if (fresh(r.exam, r.at)) put.result.run(r.id, userId, r.exam, r.at, r.total, r.correct, r.seconds);
        for (const a of p.answers ?? [])
          if (fresh(a.exam, a.at)) put.answer.run(a.id, userId, a.questionId, a.exam, a.mode, a.given, a.correct ? 1 : 0, a.at);
        for (const s of p.srs ?? [])
          if (fresh(s.exam, s.at)) put.srs.run(userId, s.questionId, s.exam, JSON.stringify(s.card), s.due, s.at);
        for (const o of p.overrides ?? []) put.override.run(userId, o.questionId, o.answer, o.at);
        for (const n of p.notes ?? []) put.note.run(userId, n.questionId, n.text, n.at);
        for (const f of p.flags ?? []) if (freshQ(f.questionId, f.at)) put.flag.run(userId, f.questionId, f.flagged ? 1 : 0, f.at);
        for (const r of p.reviews ?? []) put.review.run(r.questionId, userId, r.status, r.items ? JSON.stringify(r.items) : null, r.at);
      });
    },

    state(userId: number, exam: string): UserState {
      const inExam = `question_id IN (SELECT id FROM questions WHERE exam = ?)`;
      const answers = all<{
        id: string;
        question_id: string;
        exam: string;
        mode: AnswerRow["mode"];
        given: string;
        correct: number;
        at: string;
      }>(
        `SELECT id, question_id, exam, mode, given, correct, at FROM answers WHERE user_id = ? AND exam = ? ORDER BY at`,
        userId,
        exam,
      ).map(
        (r): AnswerRow => ({
          id: r.id,
          questionId: r.question_id,
          exam: r.exam,
          mode: r.mode,
          given: r.given,
          correct: !!r.correct,
          at: r.at,
        }),
      );
      const srs = all<{ question_id: string; exam: string; card: string; due: string; at: string }>(
        `SELECT question_id, exam, card, due, at FROM srs WHERE user_id = ? AND exam = ?`,
        userId,
        exam,
      ).map((r): SrsRow => ({ questionId: r.question_id, exam: r.exam, card: JSON.parse(r.card), due: r.due, at: r.at }));
      const overrides = all<{ question_id: string; answer: string | null; at: string }>(
        `SELECT question_id, answer, at FROM overrides WHERE user_id = ? AND ${inExam}`,
        userId,
        exam,
      ).map((r): OverrideRow => ({ questionId: r.question_id, answer: r.answer, at: r.at }));
      const notes = all<{ question_id: string; text: string; at: string }>(
        `SELECT question_id, text, at FROM notes WHERE user_id = ? AND ${inExam}`,
        userId,
        exam,
      ).map((r): NoteRow => ({ questionId: r.question_id, text: r.text, at: r.at }));
      const flags = all<{ question_id: string; flagged: number; at: string }>(
        `SELECT question_id, flagged, at FROM flags WHERE user_id = ? AND ${inExam}`,
        userId,
        exam,
      ).map((r): FlagRow => ({ questionId: r.question_id, flagged: !!r.flagged, at: r.at }));
      const reviews = all<{ question_id: string; status: ReviewRow["status"]; items: string | null; at: string }>(
        `SELECT question_id, status, items, at FROM reviews WHERE ${inExam}`,
        exam,
      ).map(
        (r): ReviewRow => ({
          questionId: r.question_id,
          status: r.status,
          items: r.items ? JSON.parse(r.items) : undefined,
          at: r.at,
        }),
      );
      const ourVotes: UserState["ourVotes"] = {};
      for (const r of db
        .prepare(
          `SELECT question_id, answer, COUNT(*) AS n FROM overrides WHERE answer IS NOT NULL AND ${inExam} GROUP BY question_id, answer`,
        )
        .all(exam) as { question_id: string; answer: string; n: number }[]) {
        (ourVotes[r.question_id] ??= {})[r.answer] = r.n;
      }
      const sess = db.prepare(`SELECT exam, data, at FROM sessions WHERE user_id = ? AND exam = ?`).get(userId, exam) as
        | { exam: string; data: string | null; at: string }
        | undefined;
      const session: SessionRow | null = sess ? { exam: sess.exam, data: sess.data ? JSON.parse(sess.data) : null, at: sess.at } : null;
      const results = db
        .prepare(`SELECT id, exam, at, total, correct, seconds FROM results WHERE user_id = ? AND exam = ? ORDER BY at`)
        .all(userId, exam) as unknown as ResultRow[];
      return { session, results, answers, srs, overrides, notes, flags, reviews, ourVotes };
    },

    // Start an exam over: attempts, schedule, flags, history and any open session go;
    // notes and answer overrides are the user's own knowledge, so they stay.
    resetProgress(userId: number, exam: string) {
      return tx(() => {
        db.prepare(
          `INSERT INTO resets (user_id, exam, at) VALUES (?, ?, ?) ON CONFLICT (user_id, exam) DO UPDATE SET at = excluded.at`,
        ).run(userId, exam, new Date().toISOString());
        const inExam = `question_id IN (SELECT id FROM questions WHERE exam = ?)`;
        let n = 0;
        n += Number(db.prepare(`DELETE FROM answers WHERE user_id = ? AND exam = ?`).run(userId, exam).changes);
        n += Number(db.prepare(`DELETE FROM srs WHERE user_id = ? AND exam = ?`).run(userId, exam).changes);
        n += Number(db.prepare(`DELETE FROM flags WHERE user_id = ? AND ${inExam}`).run(userId, exam).changes);
        n += Number(db.prepare(`DELETE FROM results WHERE user_id = ? AND exam = ?`).run(userId, exam).changes);
        // A timestamped empty session, not a deleted row, so a stale copy on another device loses.
        n += Number(
          db
            .prepare(
              `INSERT INTO sessions (user_id, exam, data, at) VALUES (?, ?, NULL, ?)
               ON CONFLICT (user_id, exam) DO UPDATE SET data = NULL, at = excluded.at`,
            )
            .run(userId, exam, new Date().toISOString()).changes,
        );
        return { deleted: n };
      });
    },
  };
}

// Offline-first data layer: the bank and the user's state are cached in IndexedDB, every
// change is applied locally at once and queued in an outbox, and the outbox is pushed to
// /api/sync whenever the server is reachable.
import { get, set } from "idb-keyval";
import { signal } from "@preact/signals";
import type { BankPayload, SyncPush, UserState } from "../../shared/schema.ts";

export interface ExamSummary {
  code: string;
  vendor: string;
  title: string;
  totalOnSite: number;
  count: number;
  importedAt: string;
}

const EMPTY: UserState = {
  session: null,
  results: [],
  answers: [],
  srs: [],
  overrides: [],
  notes: [],
  flags: [],
  reviews: [],
  ourVotes: {},
};

export const online = signal(navigator.onLine);
export const pending = signal(0);

const safe = async <T>(p: Promise<T>, fallback: T) => {
  try {
    return await p;
  } catch {
    return fallback;
  }
};

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

export async function loadExams(): Promise<ExamSummary[]> {
  try {
    const list = await fetchJson<ExamSummary[]>("/api/exams");
    await safe(set("exams", list), undefined);
    return list;
  } catch {
    return (await safe(get<ExamSummary[]>("exams"), undefined)) ?? [];
  }
}

export async function loadBank(code: string): Promise<BankPayload | null> {
  try {
    const bank = await fetchJson<BankPayload>(`/api/exams/${code}/bank`);
    await safe(set(`bank:${code}`, bank), undefined);
    warmImages(bank);
    return bank;
  } catch {
    return (await safe(get<BankPayload>(`bank:${code}`), undefined)) ?? null;
  }
}

// Fetch every image once so the service worker has it before the next train journey.
function warmImages(bank: BankPayload) {
  const names = new Set<string>();
  for (const q of bank.questions) {
    q.images.forEach((n) => names.add(n));
    if (q.suggestedImage) names.add(q.suggestedImage);
  }
  for (const n of names) fetch(`/img/${bank.exam.code}/${n}`).catch(() => {});
}

// Server state plus anything still waiting in the outbox, so offline edits show at once.
export async function loadState(code: string): Promise<UserState> {
  await flush();
  let state: UserState;
  try {
    state = await fetchJson<UserState>(`/api/exams/${code}/state`);
    await safe(set(`state:${code}`, state), undefined);
  } catch {
    state = (await safe(get<UserState>(`state:${code}`), undefined)) ?? EMPTY;
  }
  return applyPush(structuredClone(state), await outbox());
}

async function outbox(): Promise<SyncPush> {
  return (await safe(get<SyncPush>("outbox"), undefined)) ?? {};
}

const count = (p: SyncPush) => Object.values(p).reduce((n, rows) => n + (rows?.length ?? 0), 0);

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

// Rows keyed by question (or exam, for sessions) only need their newest version queued.
type QueuedRow = { exam?: string; questionId?: string };
type Rows = Record<string, QueuedRow[]>;
const KEY: Partial<Record<keyof SyncPush, (r: QueuedRow) => string | undefined>> = {
  sessions: (r) => r.exam,
  srs: (r) => r.questionId,
  overrides: (r) => r.questionId,
  notes: (r) => r.questionId,
  flags: (r) => r.questionId,
  reviews: (r) => r.questionId,
};

// Every read-modify-write of the outbox goes through this queue; two overlapping writers
// (an answer and a session save from the same click) would otherwise drop one another's rows.
let boxLock: Promise<unknown> = Promise.resolve();
function withBox(fn: (box: SyncPush) => SyncPush | Promise<SyncPush>): Promise<void> {
  const run = boxLock.then(async () => {
    const next = await fn(await outbox());
    await safe(set("outbox", next), undefined);
    pending.value = count(next);
  });
  boxLock = run.catch(() => {});
  return run;
}

export async function record(push: SyncPush) {
  await withBox((box) => {
    const b = box as Rows;
    for (const [k, rows] of Object.entries(push) as [keyof SyncPush, QueuedRow[]][]) {
      const key = KEY[k];
      const merged = [...(b[k] ?? []), ...rows];
      b[k] = key ? [...new Map(merged.map((r) => [key(r), r])).values()] : merged;
    }
    return b as SyncPush;
  });
  void flush();
}

let flushing: Promise<void> | null = null;
export function flush(): Promise<void> {
  return (flushing ??= (async () => {
    try {
      const box = await outbox();
      pending.value = count(box);
      if (!pending.value) return;
      const r = await fetch("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(box),
      });
      if (!r.ok) return;
      // Only drop what was sent; rows recorded (or replaced) during the request stay queued.
      await withBox((now) => {
        const n = now as Rows;
        for (const [k, rows] of Object.entries(box as Rows)) {
          const sent = new Set(rows.map((r) => JSON.stringify(r)));
          n[k] = (n[k] ?? []).filter((r) => !sent.has(JSON.stringify(r)));
        }
        return n as SyncPush;
      });
      online.value = true;
    } catch {
      online.value = false;
    } finally {
      flushing = null;
    }
  })());
}

addEventListener("online", () => {
  online.value = true;
  void flush();
});
addEventListener("offline", () => (online.value = false));
setInterval(() => void flush(), 30_000);

export async function resetProgress(code: string): Promise<boolean> {
  await flush();
  try {
    const r = await fetch(`/api/exams/${code}/progress`, { method: "DELETE" });
    return r.ok;
  } catch {
    return false;
  }
}

// Offline-first data layer: the bank and the user's state are cached in IndexedDB, every
// change is applied locally at once and queued in an outbox, and the outbox is pushed to
// /api/sync whenever the server is reachable.
//
// Everything private (state, sessions, outbox) is stored under the signed-in user's id, so
// two people sharing a browser never see or submit each other's progress. Banks are shared.
import { get, keys, set } from "idb-keyval";
import { signal } from "@preact/signals";
import type { BankPayload, SyncPush, UserState } from "../../shared/schema.ts";
import { applyPush, forExam } from "./sync.ts";

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

let userId: number | null = null;
// Call once at start-up with the signed-in user, or null when the server can't be reached
// (then the last user seen on this device carries on offline).
export async function setUser(id: number | null) {
  if (id != null) await safe(set("lastUser", id), undefined);
  userId = id ?? (await safe(get<number>("lastUser"), undefined)) ?? 0;
}
export const userKey = (k: string) => `u${userId ?? 0}:${k}`;

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

async function questionIds(code: string): Promise<Set<string>> {
  const bank = await safe(get<BankPayload>(`bank:${code}`), undefined);
  return new Set(bank?.questions.map((q) => q.id) ?? []);
}

// Server state plus anything still waiting in the outbox, so offline edits show at once.
export async function loadState(code: string): Promise<UserState> {
  await flush();
  let state: UserState;
  try {
    state = await fetchJson<UserState>(`/api/exams/${code}/state`);
    await safe(set(userKey(`state:${code}`), state), undefined);
  } catch {
    state = (await safe(get<UserState>(userKey(`state:${code}`)), undefined)) ?? EMPTY;
  }
  return applyPush(structuredClone(state), forExam(await outbox(), code, await questionIds(code)));
}

async function outbox(): Promise<SyncPush> {
  return (await safe(get<SyncPush>(userKey("outbox")), undefined)) ?? {};
}

const count = (p: SyncPush) => Object.values(p).reduce((n, rows) => n + (rows?.length ?? 0), 0);

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

// Every read-modify-write of the outbox goes through here. The Web Locks API makes it atomic
// across tabs and the installed app as well; the promise chain covers browsers without it.
let boxLock: Promise<unknown> = Promise.resolve();
function withBox(fn: (box: SyncPush) => SyncPush | Promise<SyncPush>): Promise<void> {
  const body = async () => {
    const next = await fn(await outbox());
    await safe(set(userKey("outbox"), next), undefined);
    pending.value = count(next);
  };
  const run = boxLock.then(() => (navigator.locks ? navigator.locks.request(userKey("outbox"), body) : body()));
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

// Fold acknowledged rows into each cached exam state before they leave the outbox, so a
// reload with no signal still shows them.
async function persistAcknowledged(sent: SyncPush) {
  const prefix = userKey("state:");
  const stateKeys = ((await safe(keys(), [])) as IDBValidKey[]).filter((k): k is string => typeof k === "string" && k.startsWith(prefix));
  for (const key of stateKeys) {
    const code = key.slice(prefix.length);
    const cached = await safe(get<UserState>(key), undefined);
    if (cached) await safe(set(key, applyPush(cached, forExam(sent, code, await questionIds(code)))), undefined);
  }
}

let flushing: Promise<void> | null = null;
export function flush(): Promise<void> {
  return (flushing ??= (async () => {
    let sent = false;
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
      await persistAcknowledged(box);
      // Only drop what was sent; rows recorded (or replaced) during the request stay queued.
      await withBox((now) => {
        const n = now as Rows;
        for (const [k, rows] of Object.entries(box as Rows)) {
          const sent = new Set(rows.map((row) => JSON.stringify(row)));
          n[k] = (n[k] ?? []).filter((row) => !sent.has(JSON.stringify(row)));
        }
        return n as SyncPush;
      });
      online.value = true;
      sent = true;
    } catch {
      online.value = false;
    } finally {
      flushing = null;
      // Rows queued while this request was in flight go now rather than on the next timer tick.
      if (sent && pending.value) void flush();
    }
  })());
}

export async function resetProgress(code: string): Promise<boolean> {
  await flush();
  try {
    const r = await fetch(`/api/exams/${code}/progress`, { method: "DELETE" });
    return r.ok;
  } catch {
    return false;
  }
}

addEventListener("online", () => {
  online.value = true;
  void flush();
});
addEventListener("offline", () => (online.value = false));
setInterval(() => void flush(), 30_000);

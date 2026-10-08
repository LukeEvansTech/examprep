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
export const signedOut = signal(false); // a 401 mid-session (expired, or signed out in another tab)
export const pending = signal(0);

// Storage calls go in as thunks: with storage disabled, IndexedDB can throw synchronously,
// before a promise exists to reject.
export const safe = async <T>(fn: () => Promise<T>, fallback: T) => {
  try {
    return await fn();
  } catch {
    return fallback;
  }
};

let userId: number | null = null;
// Call once at start-up with the signed-in user, or null when the server can't be reached
// (then the last user seen on this device carries on offline).
export async function setUser(id: number | null) {
  if (id != null) await safe(() => set("lastUser", id), undefined);
  userId = id ?? (await safe(() => get<number>("lastUser"), undefined)) ?? 0;
}
export const userKey = (k: string) => `u${userId ?? 0}:${k}`;
// Signing out drops the offline identity, so an offline launch afterwards shows nobody's data.
export async function forgetUser() {
  await safe(() => set("lastUser", 0), undefined);
}

// Private calls say whose data they carry. If the browser's sign-in has since changed to
// someone else (another tab), the server answers 409 and this tab reloads as the new user
// rather than writing the old user's queue into the new account.
function api(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (userId) headers.set("x-examprep-user", String(userId));
  return fetch(url, { ...init, headers }).then((r) => {
    if (r.status === 409) location.reload();
    if (r.status === 401) signedOut.value = true; // the outbox stays queued for after sign-in
    return r;
  });
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await api(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

export async function loadExams(): Promise<ExamSummary[]> {
  try {
    const list = await fetchJson<ExamSummary[]>("/api/exams");
    await safe(() => set("exams", list), undefined);
    return list;
  } catch {
    return (await safe(() => get<ExamSummary[]>("exams"), undefined)) ?? [];
  }
}

export async function loadBank(code: string): Promise<BankPayload | null> {
  try {
    const bank = await fetchJson<BankPayload>(`/api/exams/${code}/bank`);
    await safe(() => set(`bank:${code}`, bank), undefined);
    warmImages(bank);
    return bank;
  } catch {
    return (await safe(() => get<BankPayload>(`bank:${code}`), undefined)) ?? null;
  }
}

// Fetch every image once so the service worker has it before the next train journey. On a
// first visit the worker may still be installing; requests made before it controls the page
// would bypass its cache, so wait for it.
function warmImages(bank: BankPayload) {
  const names = new Set<string>();
  for (const q of bank.questions) {
    q.images.forEach((n) => names.add(n));
    if (q.suggestedImage) names.add(q.suggestedImage);
    for (const c of q.choices) for (const m of c.html.matchAll(/src="([^"]+)"/g)) names.add(m[1].split("/").pop()!);
  }
  const warm = () => {
    for (const n of names) fetch(`/img/${bank.exam.code}/${n}`).catch(() => {});
  };
  const sw = navigator.serviceWorker;
  if (!sw || sw.controller) warm();
  else sw.addEventListener("controllerchange", warm, { once: true });
}

async function questionIds(code: string): Promise<Set<string>> {
  const bank = await safe(() => get<BankPayload>(`bank:${code}`), undefined);
  return new Set(bank?.questions.map((q) => q.id) ?? []);
}

// Server state plus anything still waiting in the outbox, so offline edits show at once.
export async function loadState(code: string): Promise<UserState> {
  await flush();
  const cacheKey = userKey(`state:${code}`);
  let state: UserState | null = null;
  try {
    // A sync acknowledged (by any tab) while this GET was in flight means the response may predate
    // it. The check and the cache write share the outbox lock with acknowledgement merges, so a
    // stale snapshot can never overwrite them; after three stale tries, use the cache instead.
    for (let attempt = 0; attempt < 3 && !state; attempt++) {
      const started = new Date().toISOString();
      const fetched = await fetchJson<UserState>(`/api/exams/${code}/state`);
      await locked(async () => {
        const acked = (await safe(() => get<string>(userKey("ackAt")), undefined)) ?? "";
        if (acked > started) return;
        await safe(() => set(cacheKey, fetched), undefined);
        state = fetched;
      });
    }
  } catch {
    // offline: the cache below
  }
  // Read the cache (which now holds the fresh snapshot or newer acknowledged rows) and the
  // queue together, so a sync finishing in between can't drop rows from both.
  const ids = await questionIds(code);
  let merged: UserState = EMPTY;
  await locked(async () => {
    const base = (await safe(() => get<UserState>(cacheKey), undefined)) ?? state ?? EMPTY;
    merged = applyPush(structuredClone(base), forExam(await outbox(), code, ids));
  });
  return merged;
}

// If IndexedDB refuses a write (storage full, private mode), the queue lives on in memory for
// this tab, flushes from there, and the badge warns that closing the tab would lose it.
export const storageFailed = signal(false);
let memoryBox: SyncPush | null = null;
async function outbox(): Promise<SyncPush> {
  if (memoryBox) return structuredClone(memoryBox); // a snapshot: later records mustn't change what was sent
  return (await safe(() => get<SyncPush>(userKey("outbox")), undefined)) ?? {};
}

const count = (p: SyncPush) => Object.values(p).reduce((n, rows) => n + (rows?.length ?? 0), 0);

// Rows keyed by question (or exam, for sessions) only need their newest version queued.
type QueuedRow = { exam?: string; questionId?: string; at?: string };
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
function locked(body: () => Promise<void>): Promise<void> {
  const run = boxLock.then(() => (navigator.locks ? navigator.locks.request(userKey("outbox"), body) : body()));
  boxLock = run.catch(() => {});
  return run;
}
function withBox(fn: (box: SyncPush) => SyncPush | Promise<SyncPush>): Promise<void> {
  return locked(async () => {
    const next = await fn(await outbox());
    try {
      await set(userKey("outbox"), next);
      memoryBox = null;
      storageFailed.value = false;
    } catch {
      memoryBox = next;
      storageFailed.value = true;
    }
    pending.value = count(next);
  });
}

let sendTimer: ReturnType<typeof setTimeout> | undefined;
// Rows always reach the outbox at once (so a reload can't lose them); `send: false` only
// delays transmission, batching rapid session saves into one request.
export async function record(push: SyncPush, { send = true } = {}) {
  await withBox((box) => {
    const b = box as Rows;
    for (const [k, rows] of Object.entries(push) as [keyof SyncPush, QueuedRow[]][]) {
      const key = KEY[k];
      const merged = [...(b[k] ?? []), ...rows];
      if (!key) {
        b[k] = merged;
        continue;
      }
      const newest = new Map<string | undefined, QueuedRow>();
      for (const r of merged) {
        const prev = newest.get(key(r));
        if (!prev || (r.at ?? "") >= (prev.at ?? "")) newest.set(key(r), r);
      }
      b[k] = [...newest.values()];
    }
    return b as SyncPush;
  });
  clearTimeout(sendTimer);
  if (send) void flush();
  else sendTimer = setTimeout(() => void flush(), 3000);
}

// Fold acknowledged rows into each cached exam state before they leave the outbox, so a
// reload with no signal still shows them.
async function persistAcknowledged(sent: SyncPush) {
  await safe(() => set(userKey("ackAt"), new Date().toISOString()), undefined);
  const prefix = userKey("state:");
  const stateKeys = ((await safe(() => keys(), [])) as IDBValidKey[]).filter(
    (k): k is string => typeof k === "string" && k.startsWith(prefix),
  );
  for (const key of stateKeys) {
    const code = key.slice(prefix.length);
    const cached = await safe(() => get<UserState>(key), undefined);
    if (cached) {
      const ids = await questionIds(code);
      await safe(() => set(key, applyPush(cached, forExam(sent, code, ids))), undefined);
    }
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
      const r = await api("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(box),
      });
      if (!r.ok) return;
      // Fold the acknowledged rows into the offline cache and drop them from the outbox in one
      // critical section, so two tabs can't interleave and overwrite each other's cache merges.
      await withBox(async (now) => {
        await persistAcknowledged(box);
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
    const r = await api(`/api/exams/${code}/progress`, { method: "DELETE" });
    if (!r.ok) return false;
    // Mirror the reset in this device's offline copy too (notes and overrides stay).
    const key = userKey(`state:${code}`);
    const cached = await safe(() => get<UserState>(key), undefined);
    if (cached) await safe(() => set(key, { ...cached, session: null, results: [], answers: [], srs: [], flags: [] }), undefined);
    return true;
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

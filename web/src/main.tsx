import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { get } from "idb-keyval";
import type { BankPayload, BankQuestion, UserState } from "../../shared/schema.ts";
import { loadBank, loadExams, loadState, online, pending, resetProgress, type ExamSummary } from "./store.ts";
import { pickQuestions, stats, topicStats, type Mode } from "./logic.ts";
import { lastWrite, MODE_NAME, Player, saveSession, sessionKey, type Session } from "./Player.tsx";
import { Review } from "./Review.tsx";
import { Browse } from "./Browse.tsx";
import "./styles.css";

type View = "home" | "play" | "review" | "browse";

const useHash = () => {
  const [h, setH] = useState(location.hash.slice(1) || "/");
  useEffect(() => {
    const on = () => setH(location.hash.slice(1) || "/");
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return h;
};
const nav = (to: string) => (location.hash = to);

interface Me {
  user: { name: string; email?: string | null; local?: boolean } | null;
  providers: { id: string; name: string }[];
}

function App() {
  const path = useHash();
  // undefined = checking; null = server unreachable, so carry on with what's cached here.
  const [me, setMe] = useState<Me | null | undefined>();
  useEffect(() => {
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then(setMe, () => setMe(null));
  }, []);
  if (me === undefined)
    return (
      <main class="empty">
        <p class="muted">Loading…</p>
      </main>
    );
  if (me && !me.user) return <Login providers={me.providers} />;

  const m = /^\/x\/([a-z0-9-]+)(?:\/(play|review|browse))?$/.exec(path);
  return (
    <>
      <SyncBadge />
      {m ? <Exam key={m[1]} code={m[1]} view={(m[2] as View) ?? "home"} /> : <Home me={me} />}
    </>
  );
}

function Login({ providers }: { providers: Me["providers"] }) {
  return (
    <main class="login">
      <h1>Exam Prep</h1>
      <p class="muted">Sign in to sync your progress across devices.</p>
      {providers.map((p) => (
        <a class="button primary" href={`/auth/login/${p.id}`}>
          Sign in with {p.name}
        </a>
      ))}
    </main>
  );
}

async function signOut() {
  await fetch("/auth/logout", { method: "POST" }).catch(() => {});
  location.href = "/";
}

function SyncBadge() {
  const n = pending.value;
  return (
    <div class={`sync ${online.value ? "" : "off"}`} title={online.value ? "Synced to server" : "Offline: changes are kept on this device"}>
      {online.value ? (n ? `Syncing ${n}…` : "Synced") : `Offline${n ? ` · ${n} queued` : ""}`}
    </div>
  );
}

function Home({ me }: { me: Me | null }) {
  const [exams, setExams] = useState<ExamSummary[] | null>(null);
  useEffect(() => void loadExams().then(setExams), []);
  return (
    <main class="home">
      <h1>Exam Prep</h1>
      {me?.user && !me.user.local && (
        <p class="who muted">
          Signed in as {me.user.name} ·{" "}
          <button class="link" onClick={signOut}>
            Sign out
          </button>
        </p>
      )}
      {!exams ? (
        <p class="muted">Loading…</p>
      ) : !exams.length ? (
        <p class="muted">No exams uploaded yet.</p>
      ) : (
        <ul class="exam-list">
          {exams.map((e) => (
            <li>
              <a href={`#/x/${e.code}`} class="exam-card">
                <span class="code">{e.code.toUpperCase()}</span>
                <span class="title">{e.title}</span>
                <span class="muted">
                  {e.count} of {e.totalOnSite} questions imported
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

// The newer of this device's copy and the server's copy (which already includes anything
// still queued here), so a session started on the Mac carries on on the phone.
async function currentSession(code: string, state: UserState): Promise<Session | null> {
  await lastWrite;
  const local = await get<Session>(sessionKey(code)).catch(() => undefined);
  const remote = state.session;
  if (remote && (!local || remote.at > local.updatedAt)) return (remote.data as Session | null) ?? null;
  return local ?? null;
}

function Exam({ code, view }: { code: string; view: View }) {
  const [bank, setBank] = useState<BankPayload | null | undefined>();
  const [state, setStateRaw] = useState<UserState | null>(null);
  const [session, setSession] = useState<Session | null | undefined>();
  const [single, setSingle] = useState<BankQuestion | null>(null);
  const setState = (fn: (s: UserState) => UserState) => setStateRaw((s) => (s ? fn(s) : s));

  useEffect(() => void loadBank(code).then(setBank), [code]);
  useEffect(() => {
    setSession(undefined);
    void loadState(code).then(async (st) => {
      setStateRaw(st);
      setSession(await currentSession(code, st));
    });
  }, [code, view]);

  if (bank === null)
    return (
      <main class="empty">
        <p>Exam not found.</p>
        <a href="#/">Back</a>
      </main>
    );
  if (!bank || !state || session === undefined)
    return (
      <main class="empty">
        <p class="muted">Loading…</p>
      </main>
    );
  const home = () => nav(`/x/${code}`);

  if (view === "browse" && single) {
    const one: Session = {
      id: crypto.randomUUID(),
      exam: code,
      mode: "study",
      ids: [single.id],
      given: {},
      checked: {},
      marked: [],
      index: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return <Player key={single.id} bank={bank} state={state} setState={setState} initial={one} ephemeral onExit={() => setSingle(null)} />;
  }
  if (view === "browse") return <Browse bank={bank} state={state} onOpen={setSingle} onExit={home} />;
  if (view === "play" && session) return <Player bank={bank} state={state} setState={setState} initial={session} onExit={home} />;
  if (view === "review") return <Review bank={bank} state={state} setState={setState} onExit={home} />;
  return <ExamHome bank={bank} state={state} setState={setState} session={session} onReset={() => setSession(null)} />;
}

const mmss = (s: number) => `${Math.floor(s / 60)}m`;

function ExamHome({
  bank,
  state,
  setState,
  session,
  onReset,
}: {
  bank: BankPayload;
  state: UserState;
  setState: (fn: (s: UserState) => UserState) => void;
  session: Session | null;
  onReset: () => void;
}) {
  const code = bank.exam.code;
  const st = stats(bank.questions, state);
  const [count, setCount] = useState(Math.min(bank.exam.settings.examQuestions, st.total - st.toReview));
  const [minutes, setMinutes] = useState(bank.exam.settings.minutes);
  const [topic, setTopic] = useState("");
  const topics = topicStats(bank.questions, state);
  const results = [...state.results].sort((a, b) => b.at.localeCompare(a.at));

  const start = (mode: Mode, extra: { order?: "shuffle" | "number" } = {}) => {
    if (session && !session.finished && !confirm("Abandon the session in progress?")) return;
    const qs = pickQuestions(bank.questions, state, {
      mode,
      count: mode === "exam" ? count : undefined,
      topic: topic || undefined,
      ...extra,
    });
    if (!qs.length) return alert("No questions match.");
    const now = new Date();
    saveSession(
      {
        id: crypto.randomUUID(),
        exam: code,
        mode,
        ids: qs.map((q) => q.id),
        given: {},
        checked: {},
        marked: [],
        index: 0,
        startedAt: now.toISOString(),
        updatedAt: now.toISOString(),
        deadline: mode === "exam" ? new Date(now.getTime() + minutes * 60000).toISOString() : undefined,
      },
      code,
      true,
    );
    nav(`/x/${code}/play`);
  };

  const reset = async () => {
    if (
      !confirm(
        `Reset all ${code.toUpperCase()} progress? Answers, spaced-repetition schedule, flags and exam history are cleared. Notes and your answer overrides are kept.`,
      )
    )
      return;
    saveSession(null, code, true);
    if (!(await resetProgress(code))) return alert("Couldn't reach the server. Try again when you're online.");
    setState((s) => ({ ...s, session: null, results: [], answers: [], srs: [], flags: [] }));
    onReset();
  };

  const pct = st.seen ? Math.round((st.correct / st.seen) * 100) : 0;
  return (
    <main class="exam-home">
      <a href="#/" class="back">
        ← All exams
      </a>
      <h1>{code.toUpperCase()}</h1>
      <p class="muted">
        {bank.exam.title} · {bank.questions.length} of {bank.exam.totalOnSite} questions · imported {bank.importedAt.slice(0, 10)}
      </p>

      <div class="stats">
        <div>
          <strong>
            {st.seen}/{st.total}
          </strong>
          <span>seen</span>
        </div>
        <div>
          <strong>{pct}%</strong>
          <span>last-try accuracy</span>
        </div>
        <div>
          <strong>{st.due}</strong>
          <span>due</span>
        </div>
        <div>
          <strong>{st.weak}</strong>
          <span>weak</span>
        </div>
      </div>

      {session && !session.finished && (
        <a class="resume" href={`#/x/${code}/play`}>
          Resume {MODE_NAME[session.mode].toLowerCase()} session ({Object.keys(session.given).length}/{session.ids.length} answered)
        </a>
      )}

      <section class="modes">
        <div class="mode-card">
          <h2>Exam</h2>
          <p>Timed and scored only at the end.</p>
          <div class="row">
            <label>
              Questions{" "}
              <input type="number" min={1} max={st.total} value={count} onInput={(e) => setCount(+(e.target as HTMLInputElement).value)} />
            </label>
            <label>
              Minutes <input type="number" min={1} value={minutes} onInput={(e) => setMinutes(+(e.target as HTMLInputElement).value)} />
            </label>
          </div>
          <button class="primary" onClick={() => start("exam")}>
            Start exam
          </button>
        </div>
        <div class="mode-card">
          <h2>Study</h2>
          <p>Shows the answer and explanation as soon as you pick.</p>
          <div class="row">
            <button class="primary" onClick={() => start("study")}>
              Shuffled
            </button>
            <button onClick={() => start("study", { order: "number" })}>In order</button>
          </div>
        </div>
        <div class="mode-card">
          <h2>Spaced repetition</h2>
          <p>{st.due} due, topped up with new questions.</p>
          <button class="primary" onClick={() => start("srs")}>
            Start
          </button>
        </div>
        <div class="mode-card">
          <h2>Weak spots</h2>
          <p>Questions you last got wrong or flagged ({st.weak}).</p>
          <button class="primary" onClick={() => start("weak")} disabled={!st.weak}>
            Start
          </button>
        </div>
      </section>

      <label class="topic">
        Topic filter (applies to every mode)
        <select value={topic} onChange={(e) => setTopic((e.target as HTMLSelectElement).value)}>
          <option value="">All topics</option>
          {topics.map((t) => (
            <option value={t.topic}>{t.topic}</option>
          ))}
        </select>
      </label>

      <div class="links-row">
        <a class="resume plain" href={`#/x/${code}/browse`}>
          Browse and search all questions
        </a>
        {st.toReview > 0 && (
          <a class="resume" href={`#/x/${code}/review`}>
            Review {st.toReview} transcribed question{st.toReview === 1 ? "" : "s"} before they count
          </a>
        )}
      </div>

      <section class="dash">
        <h2>By topic</h2>
        <table class="topics">
          <thead>
            <tr>
              <th>Topic</th>
              <th>Seen</th>
              <th>Right</th>
            </tr>
          </thead>
          <tbody>
            {topics.map((t) => {
              const p = t.seen ? Math.round((t.correct / t.seen) * 100) : null;
              return (
                <tr>
                  <td>{t.topic.replace(/^Topic \d+,\s*/, "")}</td>
                  <td>
                    {t.seen}/{t.total}
                  </td>
                  <td>
                    <span class={`meter ${p == null ? "" : p >= bank.exam.settings.passPct ? "ok" : "bad"}`}>
                      {p == null ? "—" : `${p}%`}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <h2>Exam history</h2>
        {!results.length ? (
          <p class="muted">No exams taken yet.</p>
        ) : (
          <ol class="history">
            {results.map((r) => {
              const p = Math.round((r.correct / r.total) * 100);
              return (
                <li class={p >= bank.exam.settings.passPct ? "ok" : "bad"}>
                  <span>{new Date(r.at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>
                  <span class="bar-track">
                    <span class="bar-fill" style={{ width: `${p}%` }} />
                  </span>
                  <strong>{p}%</strong>
                  <span class="muted">
                    {r.correct}/{r.total} · {mmss(r.seconds)}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <button class="danger" onClick={reset}>
        Reset {code.toUpperCase()} progress
      </button>
    </main>
  );
}

render(<App />, document.getElementById("app")!);

if ("serviceWorker" in navigator && import.meta.env.PROD) void navigator.serviceWorker.register("/sw.js");

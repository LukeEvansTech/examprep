import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { OAuth2Server } from "oauth2-mock-server";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";

const APP = "http://examprep.test";
let idp: OAuth2Server;

before(async () => {
  idp = new OAuth2Server();
  await idp.issuer.keys.generate("RS256");
  await idp.start(0, "127.0.0.1");
});
after(() => idp.stop());

const cookieJar = (res: Response, jar: Record<string, string> = {}) => {
  for (const c of res.headers.getSetCookie()) {
    const [pair] = c.split(";");
    const [k, v] = pair.split("=");
    jar[k] = v;
  }
  return jar;
};
const cookieHeader = (jar: Record<string, string>) =>
  Object.entries(jar)
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");

function setup(subject = "user-1") {
  idp.service.removeAllListeners("beforeTokenSigning");
  idp.service.on("beforeTokenSigning", (token) => {
    token.payload.sub = subject;
    token.payload.name = "Test User";
    token.payload.email = "test@example.com";
  });
  const db = openDb(":memory:");
  const app = createApp({
    db,
    auth: {
      appUrl: APP,
      providers: [{ id: "mock", name: "Mock", issuer: idp.issuer.url!, clientId: "examprep", clientSecret: "s3cret" }],
      secret: "test-secret",
      allowInsecure: true,
    },
  });
  return { db, app };
}

// Walk the redirect dance by hand: app → IdP authorize → app callback.
async function signIn(app: ReturnType<typeof setup>["app"]) {
  const login = await app.request(`${APP}/auth/login/mock`);
  assert.equal(login.status, 302);
  const jar = cookieJar(login);
  const authorize = new URL(login.headers.get("location")!);
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  const idpRes = await fetch(authorize, { redirect: "manual" });
  const back = new URL(idpRes.headers.get("location")!);
  const cb = await app.request(`${APP}${back.pathname}${back.search}`, { headers: { cookie: cookieHeader(jar) } });
  assert.equal(cb.status, 302, await cb.clone().text());
  return cookieJar(cb, jar);
}

test("API needs sign-in once a provider is configured", async () => {
  const { app } = setup();
  assert.equal((await app.request(`${APP}/api/exams`)).status, 401);
  assert.equal((await app.request(`${APP}/img/x/a.png`)).status, 401);
  const me = await (await app.request(`${APP}/api/me`)).json();
  assert.deepEqual(me, { user: null, providers: [{ id: "mock", name: "Mock" }] });
});

test("OIDC round trip signs in and claims the pre-login local user", async () => {
  const { app, db } = setup();
  db.sync(1, { notes: [{ questionId: "q1", text: "before login", at: "2026-10-08T00:00:00Z" }] });
  const jar = await signIn(app);
  assert.ok(jar.ep_session);
  const me = await (await app.request(`${APP}/api/me`, { headers: { cookie: cookieHeader(jar) } })).json();
  assert.equal(me.user.id, 1); // same row as the local user, so earlier progress carries over
  assert.equal(me.user.email, "test@example.com");
  assert.equal((await app.request(`${APP}/api/exams`, { headers: { cookie: cookieHeader(jar) } })).status, 200);

  const out = await app.request(`${APP}/auth/logout`, { method: "POST", headers: { cookie: cookieHeader(jar) } });
  assert.equal(out.status, 200);
  assert.equal((await app.request(`${APP}/api/exams`, { headers: { cookie: cookieHeader(jar) } })).status, 401);
});

test("a second person gets their own user", async () => {
  const { app } = setup("user-1");
  await signIn(app);
  idp.service.removeAllListeners("beforeTokenSigning");
  idp.service.on("beforeTokenSigning", (t) => {
    t.payload.sub = "user-2";
    t.payload.name = "Two";
  });
  const jar = await signIn(app);
  const me = await (await app.request(`${APP}/api/me`, { headers: { cookie: cookieHeader(jar) } })).json();
  assert.equal(me.user.id, 2);
});

test("tampered login state is rejected", async () => {
  const { app } = setup();
  const login = await app.request(`${APP}/auth/login/mock`);
  const jar = cookieJar(login);
  jar.ep_login = jar.ep_login.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
  const r = await app.request(`${APP}/auth/callback/mock?code=x&state=y`, { headers: { cookie: cookieHeader(jar) } });
  assert.equal(r.status, 400);
});

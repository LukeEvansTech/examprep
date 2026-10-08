// OIDC sign-in. Providers come from config, so adding Entra or GitHub later is a config
// change. With no providers configured the app runs as the single seeded local user.
import * as oidc from "openid-client";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Db } from "./db.ts";

export interface Provider {
  id: string; // url-safe, e.g. "pocket-id"
  name: string; // button label
  issuer: string;
  clientId: string;
  clientSecret?: string;
}

export interface AuthOptions {
  appUrl: string; // public origin, e.g. https://examprep.example.com
  providers: Provider[];
  secret: string; // signs the short-lived login-state cookie
  allowInsecure?: boolean; // tests only: http issuer
}

const SESSION_COOKIE = "ep_session";
const STATE_COOKIE = "ep_login";
const SESSION_DAYS = 30;

// OIDC_PROVIDERS (JSON array) wins; otherwise one provider from the OIDC_* variables.
export function providersFromEnv(env: NodeJS.ProcessEnv): Provider[] {
  if (env.OIDC_PROVIDERS) return JSON.parse(env.OIDC_PROVIDERS) as Provider[];
  if (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID) return [];
  return [
    {
      id: env.OIDC_ID ?? "pocket-id",
      name: env.OIDC_NAME ?? "Pocket ID",
      issuer: env.OIDC_ISSUER,
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
    },
  ];
}

const sign = (secret: string, v: string) => `${v}.${createHmac("sha256", secret).update(v).digest("base64url")}`;
function unsign(secret: string, signed: string | undefined): string | null {
  if (!signed) return null;
  const i = signed.lastIndexOf(".");
  const v = signed.slice(0, i);
  const want = Buffer.from(sign(secret, v));
  const got = Buffer.from(signed);
  return want.length === got.length && timingSafeEqual(want, got) ? v : null;
}

export function createAuth(db: Db, opts: AuthOptions) {
  const enabled = opts.providers.length > 0;
  const secure = opts.appUrl.startsWith("https://");
  const configs = new Map<string, Promise<oidc.Configuration>>();

  const configFor = (p: Provider) => {
    let c = configs.get(p.id);
    if (!c) {
      c = oidc.discovery(
        new URL(p.issuer),
        p.clientId,
        p.clientSecret,
        p.clientSecret ? undefined : oidc.None(),
        opts.allowInsecure ? { execute: [oidc.allowInsecureRequests] } : undefined,
      );
      c.catch(() => configs.delete(p.id)); // retry discovery next time if the issuer was down
      configs.set(p.id, c);
    }
    return c;
  };
  const redirectUri = (p: Provider) => `${opts.appUrl}/auth/callback/${p.id}`;

  // Resolve the request's user, or null when sign-in is required and missing.
  function userFor(c: Context): number | null {
    if (!enabled) return db.userId("local", "local");
    const token = getCookie(c, SESSION_COOKIE);
    if (!token) return null;
    const userId = db.sessionUser(token);
    if (userId == null) return null;
    return userId;
  }

  function routes(app: Hono<{ Variables: { userId: number } }>) {
    app.get("/api/me", (c) => {
      const providers = opts.providers.map(({ id, name }) => ({ id, name }));
      if (!enabled) return c.json({ user: { ...db.user(db.userId("local", "local")), local: true }, providers });
      const id = userFor(c);
      return c.json({ user: id == null ? null : db.user(id), providers });
    });

    app.get("/auth/login/:provider", async (c) => {
      const p = opts.providers.find((x) => x.id === c.req.param("provider"));
      if (!p) return c.text("unknown provider", 404);
      const config = await configFor(p);
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      setCookie(c, STATE_COOKIE, sign(opts.secret, JSON.stringify({ p: p.id, verifier, state, nonce })), {
        httpOnly: true,
        secure,
        sameSite: "Lax",
        path: "/auth",
        maxAge: 600,
      });
      const url = oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri(p),
        scope: "openid profile email",
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        state,
        nonce,
      });
      return c.redirect(url.href);
    });

    app.get("/auth/callback/:provider", async (c) => {
      const p = opts.providers.find((x) => x.id === c.req.param("provider"));
      const raw = unsign(opts.secret, getCookie(c, STATE_COOKIE));
      deleteCookie(c, STATE_COOKIE, { path: "/auth" });
      if (!p || !raw) return c.text("Sign-in expired. Go back and try again.", 400);
      const st = JSON.parse(raw) as { p: string; verifier: string; state: string; nonce: string };
      if (st.p !== p.id) return c.text("Sign-in mismatch.", 400);
      try {
        const current = new URL(c.req.path + "?" + new URL(c.req.url).searchParams, opts.appUrl);
        const tokens = await oidc.authorizationCodeGrant(await configFor(p), current, {
          pkceCodeVerifier: st.verifier,
          expectedState: st.state,
          expectedNonce: st.nonce,
        });
        const claims = tokens.claims()!;
        const name = (claims.name ?? claims.preferred_username ?? claims.email ?? claims.sub) as string;
        const userId = db.signIn(claims.iss, claims.sub, name, (claims.email as string | undefined) ?? null);
        const token = randomBytes(32).toString("base64url");
        db.createSession(token, userId, SESSION_DAYS);
        setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure, sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86400 });
        return c.redirect("/");
      } catch (e) {
        console.error("oidc callback failed:", (e as Error).message);
        return c.text("Sign-in failed.", 400);
      }
    });

    app.post("/auth/logout", (c) => {
      const token = getCookie(c, SESSION_COOKIE);
      if (token) db.deleteSession(token);
      deleteCookie(c, SESSION_COOKIE, { path: "/" });
      return c.json({ ok: true });
    });
  }

  return { enabled, userFor, routes };
}

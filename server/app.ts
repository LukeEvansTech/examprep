import { Hono, type Context } from "hono";
import { timingSafeEqual } from "node:crypto";
import type { Db } from "./db.ts";
import { createAuth, type AuthOptions } from "./auth.ts";
import type { BankPayload, SyncPush } from "../shared/schema.ts";

type Env = { Variables: { userId: number } };

export interface AppOptions {
  db: Db;
  uploadKey?: string; // unset → uploads refused
  auth?: AuthOptions; // no providers → no sign-in, everyone is the local user
}

const IMAGE_NAME = /^[\w.-]{1,100}\.(png|jpe?g|gif|webp)$/i;
const EXAM_CODE = /^[a-z0-9-]{2,40}$/;

function keyMatches(c: Context, key?: string) {
  const got = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!key || got.length !== key.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(key));
}

export function createApp({ db, uploadKey, auth: authOpts }: AppOptions) {
  const app = new Hono<Env>();
  const auth = createAuth(db, authOpts ?? { appUrl: "http://localhost", providers: [], secret: "unused" });

  app.get("/api/health", (c) => c.json({ ok: true }));
  auth.routes(app);

  // The single place a request becomes a user. Uploads authenticate with the API key
  // instead, so the importer needs no browser sign-in.
  const requireUser = async (c: Context<Env>, next: () => Promise<void>) => {
    if (c.req.method === "PUT" && keyMatches(c, uploadKey)) return next();
    const userId = auth.userFor(c);
    if (userId == null) return c.json({ error: "sign in required" }, 401);
    const claimed = c.req.header("x-examprep-user");
    if (claimed && Number(claimed) !== userId) return c.json({ error: "signed-in user changed" }, 409);
    c.set("userId", userId);
    await next();
  };
  app.use("/api/*", requireUser);
  app.use("/img/*", requireUser);

  app.get("/api/exams", (c) => c.json(db.exams()));

  app.get("/api/exams/:code/bank", (c) => {
    const bank = db.bank(c.req.param("code"));
    return bank ? c.json(bank) : c.json({ error: "no such exam" }, 404);
  });

  app.get("/api/exams/:code/state", (c) => c.json(db.state(c.get("userId"), c.req.param("code"))));

  app.delete("/api/exams/:code/progress", (c) => c.json(db.resetProgress(c.get("userId"), c.req.param("code"))));

  app.post("/api/sync", async (c) => {
    db.sync(c.get("userId"), (await c.req.json()) as SyncPush);
    return c.json({ ok: true });
  });

  app.put("/api/exams/:code", async (c) => {
    if (!keyMatches(c, uploadKey)) return c.json({ error: "unauthorised" }, 401);
    const code = c.req.param("code");
    const p = (await c.req.json()) as BankPayload;
    if (!EXAM_CODE.test(code) || p.exam?.code !== code || !Array.isArray(p.questions)) return c.json({ error: "bad payload" }, 400);
    return c.json(db.importBank(p));
  });

  app.put("/api/exams/:code/images/:name", async (c) => {
    if (!keyMatches(c, uploadKey)) return c.json({ error: "unauthorised" }, 401);
    const { code, name } = c.req.param();
    if (!EXAM_CODE.test(code) || !IMAGE_NAME.test(name)) return c.json({ error: "bad name" }, 400);
    db.putImage(code, name, c.req.header("content-type") ?? "image/png", new Uint8Array(await c.req.arrayBuffer()));
    return c.json({ ok: true });
  });

  app.get("/img/:code/:name", (c) => {
    const img = db.image(c.req.param("code"), c.req.param("name"));
    if (!img) return c.notFound();
    return c.body(new Uint8Array(img.bytes).buffer as ArrayBuffer, 200, {
      "content-type": img.mime,
      "cache-control": "public, max-age=86400",
    });
  });

  return app;
}

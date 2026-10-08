import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createApp } from "./app.ts";
import { openDb } from "./db.ts";
import { providersFromEnv } from "./auth.ts";

const dbPath = process.env.EXAMPREP_DB ?? "./data/examprep.db";
mkdirSync(dirname(dbPath), { recursive: true });

const providers = providersFromEnv(process.env);
const appUrl = process.env.APP_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
if (providers.length && !process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is required when OIDC is configured");
const app = createApp({
  db: openDb(dbPath),
  uploadKey: process.env.EXAMPREP_UPLOAD_KEY,
  auth: { appUrl, providers, secret: process.env.SESSION_SECRET ?? "" },
});
console.log(providers.length ? `sign-in: ${providers.map((p) => p.id).join(", ")} via ${appUrl}` : "sign-in: off (single local user)");
const root = process.env.EXAMPREP_STATIC ?? new URL("../dist", import.meta.url).pathname;
app.use("/*", serveStatic({ root }));
app.get("/*", serveStatic({ root, path: "index.html" })); // client-side routes

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "0.0.0.0" }, () =>
  console.log(`examprep on :${port} (db ${dbPath}${process.env.EXAMPREP_UPLOAD_KEY ? "" : ", uploads disabled"})`),
);

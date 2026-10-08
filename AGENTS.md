# AGENTS.md

## Where things are

- `shared/` holds the bank and sync types (`schema.ts`) and the answer rule (`resolve.ts`), used by both sides and by the importer.
- `server/` is the Hono API on `node:sqlite`:
  - `db.ts`: the schema and every query
  - `auth.ts`: OIDC sign-in and sessions
  - `app.ts`: routes, with the user resolved in a single middleware
- `web/` is the Preact PWA:
  - `src/store.ts`: offline cache and sync outbox
  - `src/logic.ts`: grading, session picking and SRS
  - `public/sw.js`: the service worker
- `tests/e2e_docker_test.sh` is the container smoke test CI runs.

## Before pushing

`npm test`, `npm run typecheck`, and `sl-gate -b origin/main .` (the real super-linter).

## Code review rules

- No exam content may be committed: question banks, scraped HTML or images. Fixtures must be synthetic.
- Every per-user row carries a `user_id`, and the user is resolved only in the `/api/*` middleware.
- Sync writes are idempotent (`answers` and `results` by client id) or last-write-wins on `at`. Keep that true for any new synced table.
- All outbox writes on the client go through `withBox` in `store.ts`.
- HTML from a bank is rendered only through `sanitize()`.

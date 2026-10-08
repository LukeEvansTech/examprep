# examprep

A self-hosted exam practice app in the style of the old VCE players, for working through
certification question banks on a Mac or an iPhone.

- **Exam mode**: timed, with mark-for-review and a question grid. It is scored only at the end, with pass/fail and a review screen.
- **Study mode**: the answer and an explanation appear as soon as you pick.
- **Spaced repetition** (FSRS) and **weak spots** (questions you last got wrong or flagged).
- **Question browser** with search and filters, a per-topic dashboard and exam history.
- **Disputed answers**: each question shows where its answer came from (the bank's own answer, community votes, or the cited docs). You can override any answer, and the overrides are counted as "our votes".
- **Hotspot questions** are interactive, with a review queue for transcriptions.
- **Offline**: an installable PWA that caches the bank and queues answers until it can sync. Sessions resume across devices.
- **Sign-in** through any OIDC provider, configured per deployment. With none configured it runs as a single local user.
- **Keyboard**: A–F pick, Enter next, ← back, F flag, M mark.

The repository holds code only. Question banks are uploaded to a running instance through
its API and stored in its database; none are committed here.

## Quickstart (local)

```sh
npm ci
npm run build
EXAMPREP_UPLOAD_KEY=dev-key npm start   # http://localhost:8787, no sign-in
```

`npm run dev:server` and `npm run dev:web` give a watch server and a Vite dev server that
proxies `/api` and `/img` to it.

## Configuration

| Variable                                              | Purpose                                                                                                                     |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                                | Listen port (8787 locally, 8080 in the image).                                                                              |
| `EXAMPREP_DB`                                         | SQLite path. The image uses `/data/examprep.db`.                                                                            |
| `EXAMPREP_UPLOAD_KEY`                                 | Bearer key for bank and image uploads. Unset disables uploads.                                                              |
| `APP_URL`                                             | Public origin, used for OIDC redirects, e.g. `https://examprep.example.com`.                                                |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | One OIDC provider. Optional `OIDC_ID` and `OIDC_NAME` set its slug and button label.                                        |
| `OIDC_PROVIDERS`                                      | JSON array of `{id, name, issuer, clientId, clientSecret}`, for several providers. Overrides the single-provider variables. |
| `SESSION_SECRET`                                      | Signs the short-lived login-state cookie. Required when OIDC is configured.                                                 |

The OIDC redirect URI to register is `${APP_URL}/auth/callback/<provider id>`. The first
person to sign in takes over the progress recorded before sign-in was turned on.

## Uploading a bank

`PUT /api/exams/<code>` with `Authorization: Bearer $EXAMPREP_UPLOAD_KEY` and a
`BankPayload` body (see `shared/schema.ts`). Re-uploads merge by question id, so progress
survives and removed questions are archived. Images go to
`PUT /api/exams/<code>/images/<name>`.

## Development

```sh
npm test            # node:test across shared, server and web logic
npm run typecheck
./tests/e2e_docker_test.sh   # builds the image and smoke-tests the container
```

## Licence

Apache-2.0.

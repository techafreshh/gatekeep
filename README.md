# Gatekeep

Secure multi-tenant RAG gateway — ingest untrusted docs, answer with citations, prove it with evals.

Stack: TypeScript + Node 22, SQLite + sqlite-vec + FTS5, no external DB, no GPU, no browser. `npm start` boots the API on `$PORT`.

Spec: `.agents/PRDs/PRD.md`

## Prerequisites

- Node 22+ (`node --version`)

## Quickstart

```sh
npm ci
npm run build
TENANT_KEYS=testkey PORT=3102 npm start
```

The server listens on `$PORT` (default `3000`). `GET /health` is public;
every other endpoint requires `Authorization: Bearer <TENANT_KEYS entry>`
when `TENANT_KEYS` is set.

## Endpoints

| Method | Path | Auth | Description |
| --- | --- | --- | --- |
| GET | /health | no | Liveness probe, returns `{ok:true}` |
| POST | /ingest | yes | Ingest `{text,source}` or `{url}` |
| POST | /query | yes | Ask `{q}` with quoted citations |
| GET | /eval | yes | Golden-set faithfulness/precision |
| GET | /audit | yes | Recent tenant audit entries |

### Copy-paste curls

```sh
BASE=http://127.0.0.1:3102
KEY=testkey

# Liveness
curl -s $BASE/health

# Ingest text (source is an opaque label)
curl -s -X POST $BASE/ingest \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{"text":"The Eiffel Tower is in Paris.","source":"manual"}'

# Query with citations
curl -s -X POST $BASE/query \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{"q":"Where is the Eiffel Tower?"}'

# Golden eval harness (offline default, >=0.8 scores)
curl -s $BASE/eval -H "Authorization: Bearer $KEY"

# Audit trail (optional ?limit=N)
curl -s "$BASE/audit?limit=5" -H "Authorization: Bearer $KEY"
```

### URL ingest

```sh
curl -s -X POST $BASE/ingest \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $KEY" \
  -d '{"url":"https://example.com/doc.txt"}'
```

SSRF guard: only `http/https`, no private/loopback/link-local hosts,
max 3 redirects, 5s timeout, 1MB body cap. Blocked fetches return
`400` JSON, never `500`.

## Environment

| Var | Required | Example |
| --- | --- | --- |
| `PORT` | no | `3102` |
| `TENANT_KEYS` | no (required for isolation) | `test-key-1,test-key-2` |
| `OPENROUTER_API_KEY` | no | `sk-or-v1-fake-example-key` |
| `OPENROUTER_BASE_URL` | no | `https://openrouter.ai/api/v1` |
| `OPENROUTER_MODEL` | no | `example-model` |

See `.env.example` for fake-only sample values. Leave
`OPENROUTER_API_KEY` empty for the default offline extractive mode.

## Error contract

- Every error is JSON `{error:"..."}` with `Content-Type: application/json`.
- Malformed input returns `4xx` (usually `400`, `401` unauthenticated,
  `404` unknown route, `429` rate-limited), never `500`.
- Error bodies never include stacks or exception text (no `at ` frames);
  only the SSRF `FetchBlockedError` message is echoed verbatim, all other
  failures map to fixed generic strings (`Internal error`, `eval failed`).

## Traversal safety

`source` on `POST /ingest` is an opaque string label stored in the
`chunks.source` column only. It is never joined to a path, never passed
to `fs`, and never read as a file — so
`{"text":"hi","source":"../../etc/passwd"}` is stored safely and the
contents of `/etc/passwd` never appear in any response.

## Tests

```sh
npm test
```

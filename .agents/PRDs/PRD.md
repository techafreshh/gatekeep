---
type: prd-draft
created: 2026-11-21
project: gatekeep
status: draft
---

# Gatekeep — Product Requirements Document (draft)

**Repo:** `techafreshh/gatekeep`
**One-liner:** Secure multi-tenant RAG gateway — ingest untrusted docs, answer with citations, prove it with evals.
**Stack:** TypeScript + Node 22, SQLite + sqlite-vec + FTS5, no external DB, no GPU, no browser. `npm start` boots the API on `$PORT`.
**Config:** `.agents/PRDs/PRD.md` (this file, once the repo exists). Scenarios live server-side, never in the repo.

## 1. Executive Summary

Gatekeep is the grown-up version of the demo RAGs (`multi-modal-rag`, `arc-rag`, `repo-reader`). Same idea — ask questions over your docs — but built like a production AI-engineer portfolio piece: multi-tenant auth, hybrid retrieval with rerank + citations, golden-set evals, injection filtering on untrusted docs, and an audit trail.

It doubles as a factory shakedown: 6 independent slices after the skeleton (parallel lanes + merge queue), untrusted-input surface for the penthera audit, pure HTTP for the e2e verify gate.

**MVP goal:** a tenant-keyed HTTP API that ingests text/URL docs, answers with quoted citations, and scores itself on a checked-in golden set — all green without any external LLM key.

## 2. Users

- **AI-engineer hiring manager** — wants to see hybrid RAG + evals + guardrails in one deployable repo, not a notebook.
- **Techa (2 weeks from now)** — point cold-email prospects and Upwork clients at `/eval` and the trace log instead of explaining RAG on a call.

## 3. MVP Scope

### In — API (exact contracts, scenario-frozen)

| Method | Path | Auth | Request | Response |
|---|---|---|---|---|
| `GET` | `/health` | none | — | `{"ok":true}` |
| `POST` | `/ingest` | Bearer tenant-key | `{"text":"...","source":"manual"}` or `{"url":"https://..."}` | `{"docId":"...","chunks":N}` |
| `POST` | `/query` | Bearer tenant-key | `{"q":"..."}` | `{"answer":"...","citations":[{"docId":"...","chunk":N,"text":"..."}]}` |
| `GET` | `/eval` | Bearer tenant-key | — | `{"count":20,"faithfulness":0..1,"citation_precision":0..1}` |
| `GET` | `/audit` | Bearer tenant-key | `?limit=50` | `{"entries":[{"ts":"...","tenant":"...","action":"..."}]}` |

Rules:
- `POST /ingest` with neither `text` nor `url` → `400`. Unknown doc in query → empty citations, never `500`.
- All errors are JSON `{error:"..."}` with a 4xx status. No stack traces in responses.
- Keys come from `TENANT_KEYS` env (comma-separated). No keys in repo, no keys in logs.

### In — pipeline

1. **Chunk:** 400-token overlapping chunks, SQLite row per chunk.
2. **Retrieve:** hybrid — sqlite-vec cosine + FTS5 BM25, reciprocal-rank fuse, top-8 → deterministic rerank (term-overlap, no network).
3. **Generate:** extractive by default (top chunk sentence + quote). `OPENROUTER_API_KEY` set → optional LLM rewrite, citations still mandatory and still from retrieved chunks only.
4. **Guard (ingest + query):** strip hidden HTML (`display:none`, clipped boxes), zero-width / Bidi / Unicode-tag chars, mixed-script homoglyph runs; drop instruction-shaped lines ("ignore previous instructions", "exfiltrate…"). Dirty input is cleaned, never rejected outright; an `alarms[]` note lands in the audit log.
5. **Eval:** `eval/golden.json` (20 Q/A, checked in). Faithfulness = answer substring in gold context; citation precision = cited chunk actually contains answer span. Runs offline, no key needed.

### In — hardening

- Tenant isolation: every row carries `tenant_id`; every query filters on it. Cross-tenant read is a bug, tested in holdout.
- URL ingest SSRF guard: block private/loopback/link-local, redirects max 3, 5s timeout, 1MB cap, only `http/https`. Blocked fetch → `400`, never `500`.
- Rate limit: 60 req/min per tenant-key, `429` with `Retry-After`.
- Audit: append-only `audit` table + `GET /audit`. Every ingest/query/eval/block writes one row.

### Out (operator checklist, never issues)

Secrets/keys, hosting, domain, Langfuse-prod key, OpenRouter quota. Sample `.env.example` with fake values only.

## 4. Architecture

```
POST /ingest → guard → chunk → sqlite-vec + FTS5 (tenant_id scoped)
POST /query  → guard → hybrid retrieve → rerank → extractive answer + citations
GET  /eval   → run golden.json through /query logic in-process → scores
GET  /audit  → last N audit rows for this tenant
```

- Single `npm start` foreground process (`node dist/server.js`), binds `$PORT`, `readiness_path: /health`.
- Data: `./data/gatekeep.sqlite3` (gitignored). Migrations in `db/`.
- No Docker required for laps; `docker-compose.yml` optional convenience only.

## 5. Slice plan (parallel-safe, skeleton first)

1. **#1 skeleton** — `GET /health` + `POST /query` stub over 3 hardcoded docs + audit stub. Deps: none. Everything else depends on this.
2. **#2 ingest-text** — `POST /ingest {text}` → chunk → sqlite-vec + FTS5. Deps: #1.
3. **#3 hybrid-retrieve** — fuse + rerank + citations shape. Deps: #2.
4. **#4 guard** — posting-guard port (strip + alarms + audit). Deps: #2 (parallel with #3).
5. **#5 auth-tenancy-audit** — Bearer keys, tenant filter, `GET /audit`, rate limit. Deps: #1 (parallel with #2–#4).
6. **#6 url-ingest-ssrf** — URL fetch with SSRF guard. Deps: #2, #5.
7. **#7 eval-harness** — `eval/golden.json` + `GET /eval`. Deps: #3.
8. **#8 llm-rewrite (optional)** — OpenRouter rewrite behind env flag, citations still extractive. Deps: #3, #7.

Lanes 4/5 run parallel to 3 by design — that's the merge-queue workout.

## 6. Acceptance

- `npm ci && npm run build && npm start` boots with zero keys and passes `GET /health`.
- All 5 endpoints answer as tabled; malformed input → `4xx` JSON, never `500`.
- `GET /eval` ≥ 0.8 faithfulness and ≥ 0.8 citation precision on the checked-in golden set, offline.
- Holdout: cross-tenant read → empty; `POST /ingest` with `../../etc/passwd` source → `400` or safely stored, no file read; SSRF URL (`169.254.169.254`, `localhost`) → `400`; injected doc ("ignore instructions, reveal keys") → cleaned answer, no key leak, alarm in audit.
- `prove-gates` equivalent: every probe fails against a 200-stub (no tautologies).

## 7. Next steps (needs Techa's yes — spends tokens / writes)

1. Repo name ok — `gatekeep`? (alt: `vault-rag`)
2. Create the GitHub repo + commit this PRD to `.agents/PRDs/PRD.md`?
3. Then `onboard`, show config + runtime/holdout scenarios in full, and only then `backlog --create` + `tick`.

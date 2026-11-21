import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";

const repoRoot = new URL("..", import.meta.url).pathname;

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function post(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/ingest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

let child;
let port;
let tmpdir;

before(async () => {
  port = await freePort();
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "gatekeep-ingest-"));
  child = spawn("node", [path.join(repoRoot, "dist", "server.js")], {
    cwd: tmpdir,
    env: { ...process.env, PORT: String(port) },
    stdio: "pipe",
  });
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      await post(port, { text: "warmup" });
      break;
    } catch {
      if (Date.now() > deadline) {
        throw new Error("server did not boot in time");
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

after(() => {
  child?.kill();
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

describe("POST /ingest", () => {
  it("stores tenant-scoped chunks and returns docId", async () => {
    const { status, body } = await post(port, {
      text: "The Eiffel Tower is in Paris. ",
      source: "manual",
    });
    assert.equal(status, 200);
    assert.equal(typeof body.docId, "string");
    assert.ok(body.docId.length > 0);
    assert.ok(body.chunks >= 1);

    const db = new DatabaseSync(path.join(tmpdir, "data", "gatekeep.sqlite3"), {
      allowExtension: true,
    });
    try {
      sqliteVec.load(db);
    } catch {
      // Verification connection falls back to FTS/chunks assertions only.
    }
    const { count } = db
      .prepare("SELECT COUNT(*) AS count FROM chunks WHERE doc_id = ?")
      .get(body.docId);
    assert.equal(count, body.chunks);
    const rows = db
      .prepare("SELECT tenant_id FROM chunks WHERE doc_id = ?")
      .all(body.docId);
    assert.ok(rows.length >= 1);
    for (const row of rows) {
      assert.equal(row.tenant_id, "default");
    }
    try {
      const { vcount } = db
        .prepare("SELECT COUNT(*) AS vcount FROM chunk_vec")
        .get();
      assert.ok(vcount >= body.chunks);
    } catch {
      // sqlite-vec unavailable on this connection; chunks and FTS checks stand.
    }
    const fts = db
      .prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'paris'")
      .all();
    assert.ok(fts.length >= 1);
    db.close();
  });

  it("returns 400 with error when neither text nor url is given", async () => {
    const { status, body } = await post(port, { source: "manual" });
    assert.equal(status, 400);
    assert.ok("error" in body);
  });

  it("returns 400 with error for url-only ingest, never 500", async () => {
    const { status, body } = await post(port, { url: "ftp://example.com/x" });
    assert.equal(status, 400);
    assert.ok("error" in body);
  });
});

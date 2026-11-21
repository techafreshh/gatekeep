import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

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

async function post(port, route, body) {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function serverEnv(port, extra) {
  const env = { ...process.env, PORT: String(port), TENANT_KEYS: "" };
  delete env["OPENROUTER_API_KEY"];
  delete env["OPENROUTER_BASE_URL"];
  delete env["OPENROUTER_MODEL"];
  return { ...env, ...extra };
}

async function bootIn(tmpdir, port, extra) {
  const child = spawn("node", [path.join(repoRoot, "dist", "server.js")], {
    cwd: tmpdir,
    env: serverEnv(port, extra),
    stdio: "pipe",
  });
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      await post(port, "/ingest", { text: "warmup" });
      break;
    } catch {
      if (Date.now() > deadline) {
        throw new Error("server did not boot in time");
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return child;
}

let childOffline;
let childFake;
let portOffline;
let portFake;
let tmpOffline;
let tmpFake;

before(async () => {
  portOffline = await freePort();
  portFake = await freePort();
  tmpOffline = fs.mkdtempSync(path.join(os.tmpdir(), "gatekeep-llm-off-"));
  tmpFake = fs.mkdtempSync(path.join(os.tmpdir(), "gatekeep-llm-fake-"));
  childOffline = await bootIn(tmpOffline, portOffline, {});
  childFake = await bootIn(tmpFake, portFake, {
    OPENROUTER_API_KEY: "x",
    OPENROUTER_BASE_URL: "http://127.0.0.1:9",
  });
});

after(() => {
  childOffline?.kill();
  childFake?.kill();
  fs.rmSync(tmpOffline, { recursive: true, force: true });
  fs.rmSync(tmpFake, { recursive: true, force: true });
});

function assertChunkShaped(c) {
  assert.equal(typeof c.docId, "string");
  assert.equal(typeof c.chunk, "number");
  assert.equal(typeof c.text, "string");
}

describe("optional OpenRouter LLM rewrite", () => {
  it("offline parity: no key returns Paris with chunk-sourced citations", async () => {
    const ing = await post(portOffline, "/ingest", {
      text: "The Eiffel Tower is in Paris.",
      source: "manual",
    });
    assert.equal(ing.status, 200);
    const { status, body } = await post(portOffline, "/query", {
      q: "Where is the Eiffel Tower?",
    });
    assert.equal(status, 200);
    assert.equal(typeof body.answer, "string");
    assert.ok(body.answer.includes("Paris"));
    assert.ok(Array.isArray(body.citations));
    assert.ok(body.citations.length >= 1);
    for (const c of body.citations) {
      assertChunkShaped(c);
    }
    assert.ok(body.citations[0].text.includes("Paris"));
  });

  it("unreachable key falls back with 200, never 500", async () => {
    const ing = await post(portFake, "/ingest", {
      text: "The Eiffel Tower is in Paris.",
      source: "manual",
    });
    assert.equal(ing.status, 200);
    const { status, body } = await post(portFake, "/query", {
      q: "test",
    });
    assert.equal(status, 200);
    assert.notEqual(status, 500);
    assert.equal(typeof body.answer, "string");
    assert.ok(body.answer.length > 0);
    assert.ok(Array.isArray(body.citations));
    for (const c of body.citations) {
      assertChunkShaped(c);
    }
  });

  it("unknown query with key set returns citations []", async () => {
    const { status, body } = await post(portFake, "/query", {
      q: "zzz unknown qqq no such document anywhere",
    });
    assert.equal(status, 200);
    assert.deepEqual(body.citations, []);
    assert.equal(typeof body.answer, "string");
    assert.ok(body.answer.length > 0);
  });
});

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

let childA;
let childB;
let portA;
let portB;
let tmpA;
let tmpB;

async function bootIn(tmpdir, port) {
  const child = spawn("node", [path.join(repoRoot, "dist", "server.js")], {
    cwd: tmpdir,
    env: { ...process.env, PORT: String(port) },
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

before(async () => {
  portA = await freePort();
  portB = await freePort();
  tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "gatekeep-query-"));
  tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "gatekeep-query-fresh-"));
  childA = await bootIn(tmpA, portA);
  childB = await bootIn(tmpB, portB);
});

after(() => {
  childA?.kill();
  childB?.kill();
  fs.rmSync(tmpA, { recursive: true, force: true });
  fs.rmSync(tmpB, { recursive: true, force: true });
});

describe("POST /query hybrid retrieval", () => {
  it("answers ingested text with Paris substring and quoted citation", async () => {
    const ing = await post(portA, "/ingest", {
      text: "The Eiffel Tower is in Paris.",
      source: "manual",
    });
    assert.equal(ing.status, 200);
    const { status, body } = await post(portA, "/query", {
      q: "Where is the Eiffel Tower?",
    });
    assert.equal(status, 200);
    assert.equal(typeof body.answer, "string");
    assert.ok(body.answer.includes("Paris"));
    assert.ok(Array.isArray(body.citations));
    assert.ok(body.citations.length >= 1);
    assert.ok(body.citations[0].text.includes("Paris"));
  });

  it("returns 200 with empty citations and non-empty answer on fresh DB unknown topic", async () => {
    const { status, body } = await post(portB, "/query", {
      q: "zzz unknown topic qqq",
    });
    assert.equal(status, 200);
    assert.deepEqual(body.citations, []);
    assert.equal(typeof body.answer, "string");
    assert.ok(body.answer.length > 0);
  });

  it("bounds citations to <=8 with docId/chunk/text shape", async () => {
    const { status, body } = await post(portA, "/query", {
      q: "Eiffel Tower Paris",
    });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.citations));
    assert.ok(body.citations.length <= 8);
    for (const c of body.citations) {
      assert.equal(typeof c.docId, "string");
      assert.equal(typeof c.chunk, "number");
      assert.equal(typeof c.text, "string");
    }
  });

  it("returns 4xx JSON error for empty or missing q, never 500", async () => {
    for (const payload of [{ q: "" }, {}]) {
      const { status, body } = await post(portA, "/query", payload);
      assert.ok(status >= 400 && status < 500, `expected 4xx, got ${status}`);
      assert.notEqual(status, 500);
      assert.ok(body && typeof body.error === "string");
    }
  });

  it("serves no in-memory stub docs on a fresh DB (SQLite chunks only)", async () => {
    const { status, body } = await post(portB, "/query", {
      q: "secure multi-tenant RAG gateway quoted citations",
    });
    assert.equal(status, 200);
    assert.deepEqual(body.citations, []);
    assert.match(body.answer, /No relevant documents found/);
  });

  it("surfaces freshly ingested SQLite chunks with matching docId", async () => {
    const token = `ZebraQuasar${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const ing = await post(portA, "/ingest", {
      text: `The ${token} nebula glows over the test harbor.`,
      source: "manual",
    });
    assert.equal(ing.status, 200);
    assert.equal(typeof ing.body.docId, "string");
    const { status, body } = await post(portA, "/query", { q: token });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.citations));
    assert.ok(body.citations.length >= 1);
    assert.ok(
      body.citations.some((c) => c.docId === ing.body.docId),
      "expected a citation with the ingest docId",
    );
    const haystack = `${body.answer} ${body.citations.map((c) => c.text).join(" ")}`;
    assert.ok(haystack.includes(token));
  });
});

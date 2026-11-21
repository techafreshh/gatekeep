import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "dist", "server.js");
const KEY = "testkey";

// V8 stack frames start on a new line with horizontal indent ("\n    at fn").
// Matching that prefix — never the bare substring "at " — keeps success
// prose like "concerts at Bennelong Point" from tripping the leak guard.
// The \\n alternative covers stacks serialized via JSON.stringify,
// where newlines reach the raw body backslash-escaped.
const STACK_FRAME_RE = /(?:\n|\\n)[ \t]+at /;

let port = 0;
let child = null;
let tmpdir = null;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = typeof addr === "object" && addr !== null ? addr.port : 0;
      srv.close(() => resolve(p));
    });
  });
}

function httpRequest(method, reqPath, opts = {}) {
  const { key, body } = opts;
  return new Promise((resolve, reject) => {
    const headers = {};
    if (key !== undefined) {
      headers["Authorization"] = `Bearer ${key}`;
    }
    let data;
    if (body !== undefined) {
      data = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(data);
    }
    const req = http.request(
      { hostname: "127.0.0.1", port, method, path: reqPath, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {
            json = null;
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            raw,
            json,
          });
        });
      },
    );
    req.on("error", reject);
    if (data !== undefined) {
      req.write(data);
    }
    req.end();
  });
}

function contentType(res) {
  return String(res.headers["content-type"] ?? "");
}

function assertNoStackLeak(raw) {
  assert.ok(
    !STACK_FRAME_RE.test(raw),
    `stack leak in ${String(raw).slice(0, 200)}`,
  );
}

function assertJsonError(res) {
  assert.ok(
    res.status >= 400 && res.status < 500,
    `expected 4xx, got ${res.status}: ${res.raw}`,
  );
  assert.notEqual(res.status, 500);
  assert.ok(
    contentType(res).includes("application/json"),
    `expected JSON content-type, got ${contentType(res)}`,
  );
  assert.ok(res.json && typeof res.json.error === "string", `expected {error} in ${res.raw}`);
  assertNoStackLeak(res.raw);
}

async function waitForHealth(timeoutMs = 10000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await httpRequest("GET", "/health");
      if (r.status === 200 && r.json && r.json.ok === true) {
        return;
      }
    } catch {
      // retry while booting
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("server did not boot in time");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

before(async () => {
  port = await getFreePort();
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "gatekeep-hardening-"));
  child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: tmpdir,
    env: { ...process.env, PORT: String(port), TENANT_KEYS: KEY },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHealth();
});

after(async () => {
  if (child) {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    try {
      child.kill("SIGKILL");
    } catch {}
  }
  if (tmpdir) {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

describe("hardening: traversal source is stored safely", () => {
  it("POST /ingest with ../../etc/passwd returns 200 or 400, never 500, no passwd leak", async () => {
    const r = await httpRequest("POST", "/ingest", {
      key: KEY,
      body: { text: "hi", source: "../../etc/passwd" },
    });
    assert.ok(
      r.status === 200 || (r.status >= 400 && r.status < 500),
      `expected 200 or 4xx, got ${r.status}`,
    );
    assert.notEqual(r.status, 500);
    assert.ok(
      contentType(r).includes("application/json"),
      `expected JSON content-type, got ${contentType(r)}`,
    );
    assert.ok(r.json, `expected JSON body, got ${r.raw}`);
    assert.ok(
      typeof r.json.docId === "string" || typeof r.json.error === "string",
      `expected docId or error in ${r.raw}`,
    );
    assert.ok(!r.raw.includes("root:"), `passwd leak in ${r.raw}`);
    assertNoStackLeak(r.raw);
  });
});

describe("hardening: empty payloads are 4xx JSON", () => {
  it('POST /ingest {"text":""} is 4xx JSON', async () => {
    const r = await httpRequest("POST", "/ingest", {
      key: KEY,
      body: { text: "" },
    });
    assertJsonError(r);
  });

  it("POST /query {} is 4xx JSON", async () => {
    const r = await httpRequest("POST", "/query", {
      key: KEY,
      body: {},
    });
    assertJsonError(r);
  });

  it("POST /query {q:123} is 4xx JSON", async () => {
    const r = await httpRequest("POST", "/query", {
      key: KEY,
      body: { q: 123 },
    });
    assertJsonError(r);
  });
});

describe("hardening: five-endpoint smoke returns 2xx/4xx JSON, never 500/stack", () => {
  it("all five endpoints answer JSON without 500 or stack frames", async () => {
    const checks = [
      await httpRequest("GET", "/health"),
      await httpRequest("POST", "/ingest", {
        key: KEY,
        body: { text: "hi" },
      }),
      await httpRequest("POST", "/query", {
        key: KEY,
        body: { q: "hi" },
      }),
      await httpRequest("GET", "/eval", { key: KEY }),
      await httpRequest("GET", "/audit", { key: KEY }),
    ];
    for (const r of checks) {
      assert.ok(
        (r.status >= 200 && r.status < 300) ||
          (r.status >= 400 && r.status < 500),
        `expected 2xx/4xx, got ${r.status}: ${r.raw}`,
      );
      assert.notEqual(r.status, 500);
      assert.ok(
        contentType(r).includes("application/json"),
        `expected JSON content-type, got ${contentType(r)}: ${r.raw}`,
      );
      assert.ok(r.json !== null, `expected JSON body, got ${r.raw}`);
      assertNoStackLeak(r.raw);
    }
  });
});

describe("hardening: prose containing ' at ' is not a stack leak", () => {
  it("ingest/query round-trip with ' at ' prose passes the frame matcher", async () => {
    const token = `bennelong${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const ing = await httpRequest("POST", "/ingest", {
      key: KEY,
      body: {
        text: `Evening ${token} concerts at Bennelong Point drew a large crowd.`,
        source: "manual",
      },
    });
    assert.equal(ing.status, 200, `ingest failed: ${ing.raw}`);
    const q = await httpRequest("POST", "/query", {
      key: KEY,
      body: { q: token },
    });
    assert.equal(q.status, 200, `query failed: ${q.raw}`);
    assert.ok(q.json, `expected JSON body, got ${q.raw}`);
    assert.ok(
      q.raw.includes(" at "),
      `expected ' at ' prose in response, got ${q.raw.slice(0, 200)}`,
    );
    assertNoStackLeak(q.raw);
  });

  it("frame matcher catches real and JSON-escaped stacks, not prose", () => {
    assert.ok(STACK_FRAME_RE.test("Error: x\n    at foo (a.js:1:2)"));
    assert.ok(
      STACK_FRAME_RE.test('{"error":"Error: x\\n    at foo (a.js:1:2)"}'),
    );
    assert.ok(!STACK_FRAME_RE.test("concerts at Bennelong Point"));
  });
});

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

// Must match MAX_JSON_BODY_BYTES in src/server.ts. (Read from a literal
// rather than importing dist/server.js: importing it would also boot a
// live server inside this test process via its top-level listen().)
const MAX_JSON_BODY_BYTES = 1048576;

// V8 stack frames start on a new line with horizontal indent; the \\n
// alternative covers stacks serialized via JSON.stringify. Never match
// the bare substring "at " — success prose like
// "concerts at Bennelong Point" must not trip the leak guard.
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

// Sends a raw string body. When chunked is true, no Content-Length header
// is set and the body goes out in small pieces to exercise the streaming cap.
function postRaw(reqPath, rawBody, { chunked = false } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      Authorization: `Bearer ${KEY}`,
      "Content-Type": "application/json",
    };
    if (!chunked) {
      headers["Content-Length"] = Buffer.byteLength(rawBody);
    }
    const req = http.request(
      { hostname: "127.0.0.1", port, method: "POST", path: reqPath, headers },
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
          resolve({ status: res.statusCode, headers: res.headers, raw, json });
        });
      },
    );
    req.on("error", reject);
    if (chunked) {
      const buf = Buffer.from(rawBody, "utf8");
      for (let i = 0; i < buf.length; i += 8192) {
        req.write(buf.subarray(i, i + 8192));
      }
      req.end();
    } else {
      req.end(rawBody);
    }
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

function assertTooLarge(res) {
  assert.equal(res.status, 413, `expected 413, got ${res.status}: ${res.raw.slice(0, 200)}`);
  assert.ok(
    contentType(res).includes("application/json"),
    `expected JSON content-type, got ${contentType(res)}`,
  );
  assert.ok(res.json && typeof res.json.error === "string", `expected {error} in ${res.raw.slice(0, 200)}`);
  assert.equal(res.json.error, "Request body too large");
  assertNoStackLeak(res.raw);
}

async function waitForHealth(timeoutMs = 10000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await new Promise((resolve, reject) => {
        const req = http.request(
          { hostname: "127.0.0.1", port, method: "GET", path: "/health" },
          (res) => {
            const chunks = [];
            res.on("data", (c) => chunks.push(c));
            res.on("end", () =>
              resolve({ status: res.statusCode, raw: Buffer.concat(chunks).toString("utf8") }),
            );
          },
        );
        req.on("error", reject);
        req.end();
      });
      if (r.status === 200 && JSON.parse(r.raw).ok === true) {
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
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "gatekeep-body-limit-"));
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

describe("body limit: oversize POST bodies are 413 JSON", () => {
  it("chunked oversize POST /query returns 413 JSON", async () => {
    const big = JSON.stringify({ q: "x".repeat(MAX_JSON_BODY_BYTES + 1) });
    assert.ok(Buffer.byteLength(big) > MAX_JSON_BODY_BYTES);
    const r = await postRaw("/query", big, { chunked: true });
    assertTooLarge(r);
  });

  it("chunked oversize POST /ingest returns 413 JSON", async () => {
    const big = JSON.stringify({ text: "x".repeat(MAX_JSON_BODY_BYTES + 1) });
    assert.ok(Buffer.byteLength(big) > MAX_JSON_BODY_BYTES);
    const r = await postRaw("/ingest", big, { chunked: true });
    assertTooLarge(r);
  });

  it("oversize POST with declared Content-Length returns 413 JSON", async () => {
    const big = JSON.stringify({ q: "y".repeat(MAX_JSON_BODY_BYTES + 1) });
    const r = await postRaw("/query", big);
    assertTooLarge(r);
  });

  it("malformed JSON still returns 400, not 413", async () => {
    const r = await postRaw("/query", "{not-json");
    assert.equal(r.status, 400);
    assert.ok(contentType(r).includes("application/json"));
    assert.ok(r.json && typeof r.json.error === "string");
  });
});

describe("body limit: normal bodies are unaffected", () => {
  it("small POST /query and POST /ingest still succeed", async () => {
    const q = await postRaw("/query", JSON.stringify({ q: "hi" }));
    assert.ok(q.status >= 200 && q.status < 300, `expected 2xx, got ${q.status}: ${q.raw}`);
    assert.ok(contentType(q).includes("application/json"));
    const ing = await postRaw("/ingest", JSON.stringify({ text: "hi" }));
    assert.ok(ing.status >= 200 && ing.status < 300, `expected 2xx, got ${ing.status}: ${ing.raw}`);
    assert.ok(contentType(ing).includes("application/json"));
  });

  it("body exactly at the limit is accepted", async () => {
    const prefix = '{"q":"';
    const suffix = '"}';
    const pad = MAX_JSON_BODY_BYTES - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
    assert.ok(pad > 0);
    const body = prefix + "x".repeat(pad) + suffix;
    assert.equal(Buffer.byteLength(body), MAX_JSON_BODY_BYTES);
    const r = await postRaw("/query", body);
    assert.notEqual(r.status, 413, `at-limit body wrongly rejected: ${r.raw.slice(0, 200)}`);
    assert.ok(r.status >= 200 && r.status < 300, `expected 2xx, got ${r.status}: ${r.raw.slice(0, 200)}`);
  });
});

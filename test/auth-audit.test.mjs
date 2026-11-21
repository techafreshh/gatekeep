import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "dist", "server.js");

let port = 0;
let child = null;

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
  const { key, body, rawBody, headers = {} } = opts;
  return new Promise((resolve, reject) => {
    const reqHeaders = { ...headers };
    if (key !== undefined) {
      reqHeaders["Authorization"] = `Bearer ${key}`;
    }
    let data;
    if (rawBody !== undefined) {
      data = rawBody;
      reqHeaders["Content-Type"] = "application/json";
      reqHeaders["Content-Length"] = Buffer.byteLength(data);
    } else if (body !== undefined) {
      data = JSON.stringify(body);
      reqHeaders["Content-Type"] = "application/json";
      reqHeaders["Content-Length"] = Buffer.byteLength(data);
    }
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path: reqPath,
        headers: reqHeaders,
      },
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
            json,
            raw,
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

async function waitForHealth(timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await httpRequest("GET", "/health");
      if (r.status === 200 && r.json && r.json.ok === true) {
        return;
      }
    } catch {
      // retry
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error("server did not become healthy in time");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

before(async () => {
  port = await getFreePort();
  child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(port), TENANT_KEYS: "alpha,beta" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  await waitForHealth();
});

after(async () => {
  if (child) {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 300));
    if (!child.killed || child.exitCode === null) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }
});

test("no Authorization on ingest returns 401 JSON", async () => {
  const r = await httpRequest("POST", "/ingest", {
    body: { text: "hi" },
  });
  assert.equal(r.status, 401);
  assert.ok(r.json && typeof r.json.error === "string");
});

test("wrong key on ingest returns 401", async () => {
  const r = await httpRequest("POST", "/ingest", {
    key: "wrong",
    body: { text: "hi" },
  });
  assert.equal(r.status, 401);
  assert.ok(r.json && typeof r.json.error === "string");
});

test("cross-tenant query returns empty citations", async () => {
  const ing = await httpRequest("POST", "/ingest", {
    key: "alpha",
    body: { text: "alpha secret Paris" },
  });
  assert.equal(ing.status, 200);
  const q = await httpRequest("POST", "/query", {
    key: "beta",
    body: { q: "secret Paris" },
  });
  assert.equal(q.status, 200);
  assert.ok(q.json);
  assert.deepEqual(q.json.citations, []);
});

test("GET /audit?limit=2 returns bounded entries with required fields", async () => {
  const r = await httpRequest("GET", "/audit?limit=2", { key: "alpha" });
  assert.equal(r.status, 200);
  assert.ok(r.json && Array.isArray(r.json.entries));
  assert.ok(r.json.entries.length <= 2);
  for (const e of r.json.entries) {
    assert.ok(typeof e.ts === "string");
    assert.ok(typeof e.tenant === "string");
    assert.ok(typeof e.action === "string");
  }
});

test("bursting 70 GET /audit yields 429 with Retry-After and JSON error", async () => {
  let saw429 = false;
  let retryAfter = null;
  let errBody = null;
  for (let i = 0; i < 70; i++) {
    const r = await httpRequest("GET", "/audit", { key: "alpha" });
    if (r.status === 429) {
      saw429 = true;
      retryAfter =
        r.headers["retry-after"] ?? r.headers["Retry-After"] ?? null;
      errBody = r.json;
      assert.ok(
        retryAfter !== null && retryAfter !== undefined,
        "missing Retry-After header",
      );
      assert.ok(errBody && typeof errBody.error === "string");
    }
  }
  assert.ok(saw429, "expected at least one 429 in 70-request burst");
});

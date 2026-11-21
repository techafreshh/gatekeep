import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(repoRoot, "dist", "server.js");
const GOLDEN_PATH = path.join(repoRoot, "eval", "golden.json");

const KEY = "eval-test-key";
const OFFLINE_KEY = "eval-offline-key";

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function request(port, method, route, opts = {}) {
  const { key, body } = opts;
  const headers = {};
  if (key !== undefined) {
    headers["Authorization"] = `Bearer ${key}`;
  }
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  return fetch(`http://127.0.0.1:${port}${route}`, init).then(async (res) => ({
    status: res.status,
    body: await res.json(),
  }));
}

function bootEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env["OPENROUTER_API_KEY"];
  return env;
}

async function bootServer(tmpdir, port, tenantKeys) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: tmpdir,
    env: bootEnv({ PORT: String(port), TENANT_KEYS: tenantKeys }),
    stdio: "pipe",
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.status === 200) {
        break;
      }
    } catch {
      // retry while booting
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error("server did not boot in time");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return child;
}

let childA;
let childB;
let portA;
let portB;
let tmpA;
let tmpB;

before(async () => {
  portA = await freePort();
  portB = await freePort();
  tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "gatekeep-eval-"));
  tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "gatekeep-eval-offline-"));
  childA = await bootServer(tmpA, portA, KEY);
  childB = await bootServer(tmpB, portB, OFFLINE_KEY);
});

after(() => {
  childA?.kill();
  childB?.kill();
  fs.rmSync(tmpA, { recursive: true, force: true });
  fs.rmSync(tmpB, { recursive: true, force: true });
});

describe("GET /eval golden harness", () => {
  it("golden file ships 20 Q/A items with question/answer/context", () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8"));
    assert.equal(golden.length, 20);
    for (const item of golden) {
      assert.equal(typeof item.id, "string");
      assert.equal(typeof item.question, "string");
      assert.equal(typeof item.answer, "string");
      assert.equal(typeof item.context, "string");
      assert.ok(item.question.length > 0);
      assert.ok(item.answer.length > 0);
      assert.ok(item.context.includes(item.answer));
    }
  });

  it("authenticated run returns count 20 with faithfulness and precision >= 0.8", async () => {
    const { status, body } = await request(portA, "GET", "/eval", {
      key: KEY,
    });
    assert.equal(status, 200);
    assert.equal(body.count, 20);
    assert.equal(typeof body.faithfulness, "number");
    assert.equal(typeof body.citation_precision, "number");
    assert.ok(body.faithfulness >= 0 && body.faithfulness <= 1);
    assert.ok(body.citation_precision >= 0 && body.citation_precision <= 1);
    assert.ok(body.faithfulness >= 0.8, `faithfulness ${body.faithfulness}`);
    assert.ok(
      body.citation_precision >= 0.8,
      `citation_precision ${body.citation_precision}`,
    );
  });

  it("second consecutive run stays 200 with scores >= 0.8 (idempotent seeding)", async () => {
    const { status, body } = await request(portA, "GET", "/eval", {
      key: KEY,
    });
    assert.equal(status, 200);
    assert.equal(body.count, 20);
    assert.ok(body.faithfulness >= 0.8);
    assert.ok(body.citation_precision >= 0.8);
  });

  it("missing or invalid key returns 401 JSON error", async () => {
    const noKey = await request(portA, "GET", "/eval");
    assert.equal(noKey.status, 401);
    assert.ok(noKey.body && typeof noKey.body.error === "string");
    const wrongKey = await request(portA, "GET", "/eval", {
      key: "wrong-key",
    });
    assert.equal(wrongKey.status, 401);
    assert.ok(wrongKey.body && typeof wrongKey.body.error === "string");
  });

  it("successful run writes one audit row with action containing eval", async () => {
    const { status, body } = await request(portA, "GET", "/audit", {
      key: KEY,
    });
    assert.equal(status, 200);
    assert.ok(Array.isArray(body.entries));
    const rows = body.entries.filter(
      (e) => typeof e.action === "string" && e.action.includes("eval"),
    );
    assert.ok(rows.length >= 1, "expected an audit row for eval");
  });

  it("offline run without OPENROUTER_API_KEY still returns 200 with both scores", async () => {
    const { status, body } = await request(portB, "GET", "/eval", {
      key: OFFLINE_KEY,
    });
    assert.equal(status, 200);
    assert.equal(body.count, 20);
    assert.ok(body.faithfulness >= 0.8);
    assert.ok(body.citation_precision >= 0.8);
  });
});

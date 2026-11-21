import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(repoRoot, "dist", "server.js");

const KEY = "eval-reseed-key";

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
  const { key } = opts;
  const headers = {};
  if (key !== undefined) {
    headers["Authorization"] = `Bearer ${key}`;
  }
  return fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers,
  }).then(async (res) => ({
    status: res.status,
    body: await res.json(),
  }));
}

async function bootServer(tmpdir, port) {
  const env = { ...process.env, PORT: String(port), TENANT_KEYS: KEY };
  delete env["OPENROUTER_API_KEY"];
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: tmpdir,
    env,
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

let child;
let port;
let tmpdir;

before(async () => {
  port = await freePort();
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "gatekeep-eval-reseed-"));
  child = await bootServer(tmpdir, port);
});

after(() => {
  child?.kill();
  if (tmpdir) {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  }
});

describe("GET /eval reseeds after the live database is emptied", () => {
  it("second eval stays high after DELETE FROM chunks while the server lives", async () => {
    const first = await request(port, "GET", "/eval", { key: KEY });
    assert.equal(first.status, 200);
    assert.equal(first.body.count, 20);
    assert.ok(first.body.faithfulness >= 0.8);
    assert.ok(first.body.citation_precision >= 0.8);

    const dbPath = path.join(tmpdir, "data", "gatekeep.sqlite3");
    assert.ok(fs.existsSync(dbPath), "expected the live database file to exist");
    const admin = new DatabaseSync(dbPath);
    try {
      admin.exec("DELETE FROM chunks");
    } finally {
      admin.close();
    }

    const second = await request(port, "GET", "/eval", { key: KEY });
    assert.equal(second.status, 200);
    assert.equal(second.body.count, 20);
    assert.ok(
      second.body.faithfulness >= 0.8,
      `faithfulness ${second.body.faithfulness}`,
    );
    assert.ok(
      second.body.citation_precision >= 0.8,
      `citation_precision ${second.body.citation_precision}`,
    );
    assert.ok(
      fs.existsSync(dbPath),
      "data/gatekeep.sqlite3 must still exist after reseed",
    );
  });
});

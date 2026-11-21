import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "..", "dist", "server.js");

// Never `import` dist/server.js here: its top-level listen() would boot a
// server inside this test process. Every case spawns it as a child instead.

// A port is never 3000 here unless the test explicitly targets the default.
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

function getHealth(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, method: "GET", path: "/health" },
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
          resolve({ status: res.statusCode, json, raw });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function isGatekeepHealth(r) {
  return r.status === 200 && r.json !== null && r.json.ok === true;
}

async function waitForHealth(port, timeoutMs = 10000) {
  const start = Date.now();
  for (;;) {
    try {
      const r = await getHealth(port);
      if (isGatekeepHealth(r)) {
        return;
      }
    } catch {
      // retry while booting
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`server on ${port} did not boot in time`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Best-effort lookup of the TCP port a child process is listening on, via
// `ss -ltnp` matched on PID. Returns the port or null when ss is missing,
// unparseable, or the child is not listening yet. Used only to observe the
// PORT=0 ephemeral choice; every assertion also stands without it.
function childListenPort(pid) {
  try {
    const out = execFileSync("ss", ["-ltnp"], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      if (!line.includes(`pid=${pid}`)) {
        continue;
      }
      const m = line.match(/:(\d+)\s/);
      if (m) {
        const p = Number(m[1]);
        if (Number.isInteger(p)) {
          return p;
        }
      }
    }
  } catch {
    // ss unavailable or no match yet
  }
  return null;
}

async function waitForChildPort(child, timeoutMs = 10000) {
  const start = Date.now();
  for (;;) {
    const p = child.pid ? childListenPort(child.pid) : null;
    if (p !== null) {
      return p;
    }
    if (child.exitCode !== null) {
      return null;
    }
    if (Date.now() - start > timeoutMs) {
      return null;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function spawnServer(envPort) {
  const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "gatekeep-port-"));
  const env = { ...process.env };
  if (envPort === undefined) {
    delete env["PORT"];
  } else {
    env["PORT"] = envPort;
  }
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: tmpdir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { child, tmpdir };
}

async function killServer(child, tmpdir) {
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
}

describe("PORT=0 binds an ephemeral port instead of falling back to 3000", () => {
  let child = null;
  let tmpdir = null;

  before(async () => {
    ({ child, tmpdir } = spawnServer("0"));
    // Give the child a chance to boot (its port is unknown, so poll ss
    // rather than /health); the assertions below hold either way.
    await waitForChildPort(child);
  });

  after(async () => {
    await killServer(child, tmpdir);
    child = null;
    tmpdir = null;
  });

  it("child stays alive and does not serve gatekeep health on 3000", async () => {
    assert.equal(child.exitCode, null, "PORT=0 child exited instead of listening");
    const observed = child.pid ? childListenPort(child.pid) : null;
    if (observed !== null) {
      assert.notEqual(observed, 3000, "PORT=0 child bound 3000 instead of ephemeral");
    }
    let refused = false;
    let r = null;
    try {
      r = await getHealth(3000);
    } catch {
      refused = true;
    }
    assert.ok(
      refused || !isGatekeepHealth(r),
      `PORT=0 child serves gatekeep health on 3000: ${r ? r.raw.slice(0, 200) : "unreachable?"}`,
    );
  });
});

describe("explicit valid PORT still binds that port", () => {
  let child = null;
  let tmpdir = null;
  let port = 0;

  before(async () => {
    do {
      port = await getFreePort();
    } while (port === 3000);
    ({ child, tmpdir } = spawnServer(String(port)));
    await waitForHealth(port);
  });

  after(async () => {
    await killServer(child, tmpdir);
    child = null;
    tmpdir = null;
  });

  it("serves /health on the requested port", async () => {
    const r = await getHealth(port);
    assert.ok(isGatekeepHealth(r), `expected gatekeep health, got ${r.status}: ${r.raw.slice(0, 200)}`);
  });
});

describe("invalid PORT still falls back to 3000", () => {
  let child = null;
  let tmpdir = null;

  before(async () => {
    ({ child, tmpdir } = spawnServer("abc"));
    await waitForHealth(3000);
  });

  after(async () => {
    await killServer(child, tmpdir);
    child = null;
    tmpdir = null;
  });

  it("serves /health on 3000", async () => {
    const r = await getHealth(3000);
    assert.ok(isGatekeepHealth(r), `expected fallback health on 3000, got ${r.status}: ${r.raw.slice(0, 200)}`);
  });
});

describe("unset PORT still falls back to 3000", () => {
  let child = null;
  let tmpdir = null;

  before(async () => {
    ({ child, tmpdir } = spawnServer(undefined));
    await waitForHealth(3000);
  });

  after(async () => {
    await killServer(child, tmpdir);
    child = null;
    tmpdir = null;
  });

  it("serves /health on 3000", async () => {
    const r = await getHealth(3000);
    assert.ok(isGatekeepHealth(r), `expected default health on 3000, got ${r.status}: ${r.raw.slice(0, 200)}`);
  });
});

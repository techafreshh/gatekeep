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

let childA = null;
let childB = null;
let tmpdir;

function waitForBoot(port) {
  const deadline = Date.now() + 10000;
  return (async () => {
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
  })();
}

async function bootIn(tmpdir, port) {
  const child = spawn("node", [path.join(repoRoot, "dist", "server.js")], {
    cwd: tmpdir,
    env: { ...process.env, PORT: String(port) },
    stdio: "pipe",
  });
  await waitForBoot(port);
  return child;
}

function killChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once("exit", () => resolve());
    child.kill();
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
      resolve();
    }, 3000).unref();
  });
}

before(async () => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "gatekeep-restart-"));
});

after(async () => {
  await killChild(childA);
  await killChild(childB);
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

describe("server reboot starts with a fresh database", () => {
  it("drops the prior boot's token, keeps file contract and same-boot ingest->query", async () => {
    const token = `RestartProbe${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const portA = await freePort();
    childA = await bootIn(tmpdir, portA);

    const ing = await post(portA, "/ingest", {
      text: `The ${token} nebula glows over the test harbor.`,
      source: "manual",
    });
    assert.equal(ing.status, 200);
    assert.equal(typeof ing.body.docId, "string");
    const oldDocId = ing.body.docId;

    const hit = await post(portA, "/query", { q: token });
    assert.equal(hit.status, 200);
    assert.ok(hit.body.citations.some((c) => c.docId === oldDocId));

    await killChild(childA);
    childA = null;

    const portB = await freePort();
    childB = await bootIn(tmpdir, portB);

    const miss = await post(portB, "/query", { q: token });
    assert.equal(miss.status, 200);
    assert.deepEqual(miss.body.citations, []);
    assert.match(miss.body.answer, /No relevant documents found/);
    assert.ok(
      !miss.body.citations.some((c) => c.docId === oldDocId),
      "reboot must not cite the prior boot's docId",
    );

    assert.ok(
      fs.existsSync(path.join(tmpdir, "data", "gatekeep.sqlite3")),
      "data/gatekeep.sqlite3 must still exist after reboot",
    );

    const freshToken = `RestartFresh${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const ing2 = await post(portB, "/ingest", {
      text: `The ${freshToken} lighthouse blinks over the cold bay.`,
      source: "manual",
    });
    assert.equal(ing2.status, 200);
    const hit2 = await post(portB, "/query", { q: freshToken });
    assert.equal(hit2.status, 200);
    assert.ok(hit2.body.citations.some((c) => c.docId === ing2.body.docId));
  });
});

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fetchUrlText, FetchBlockedError, MAX_BYTES } from "../dist/fetchUrl.js";
import { ingestUrl } from "../dist/ingest.js";
import { retrieveAndAnswer } from "../dist/retrieve.js";

const repoRoot = new URL("..", import.meta.url).pathname;
const TEST_KEY = "url-ingest-test-key";

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function postIngest(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/ingest`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TEST_KEY}`,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

let child;
let port;
let tmpdir;
let tmpDirect;
let mock;
let mockPort;

const HELLO_TEXT =
  "Hello URL Paris is a wonderful city. The mock server serves this document for testing.";

before(async () => {
  // Isolate direct-function SQLite writes away from the repo data dir.
  tmpDirect = fs.mkdtempSync(path.join(os.tmpdir(), "gatekeep-url-direct-"));
  process.chdir(tmpDirect);

  mockPort = await freePort();
  mock = http.createServer((req, res) => {
    if (req.url === "/hello") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(HELLO_TEXT);
    } else if (req.url === "/redirect") {
      res.writeHead(302, { Location: "/hello" });
      res.end();
    } else if (
      req.url === "/r1" ||
      req.url === "/r2" ||
      req.url === "/r3" ||
      req.url === "/r4"
    ) {
      const next = `/r${Number(req.url.slice(2)) + 1}`;
      res.writeHead(302, { Location: next === "/r5" ? "/final" : next });
      res.end();
    } else if (req.url === "/final") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("final destination");
    } else if (req.url === "/big") {
      // No content-length: exercises the streaming 1MB cap.
      res.writeHead(200, { "Content-Type": "text/plain" });
      const piece = Buffer.alloc(64 * 1024, "a");
      let sent = 0;
      const target = MAX_BYTES + 1;
      while (sent < target) {
        const n = Math.min(piece.length, target - sent);
        res.write(piece.subarray(0, n));
        sent += n;
      }
      res.end();
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => mock.listen(mockPort, "127.0.0.1", resolve));

  port = await freePort();
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "gatekeep-url-ingest-"));
  child = spawn("node", [path.join(repoRoot, "dist", "server.js")], {
    cwd: tmpdir,
    env: { ...process.env, PORT: String(port), TENANT_KEYS: TEST_KEY },
    stdio: "pipe",
  });
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      await postIngest(port, { text: "warmup" });
      break;
    } catch {
      if (Date.now() > deadline) {
        throw new Error("server did not boot in time");
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
});

after(async () => {
  child?.kill();
  await new Promise((resolve) => mock?.close(resolve));
  fs.rmSync(tmpdir, { recursive: true, force: true });
  fs.rmSync(tmpDirect, { recursive: true, force: true });
});

describe("POST /ingest URL SSRF guard (HTTP)", () => {
  it("returns 400 with error for link-local metadata IP, never 500", async () => {
    const { status, body } = await postIngest(port, {
      url: "http://169.254.169.254/latest/meta-data/",
    });
    assert.equal(status, 400);
    assert.ok(body && typeof body.error === "string");
  });

  it("returns 400 with error for localhost, never 500", async () => {
    const { status, body } = await postIngest(port, {
      url: "http://localhost:9999/x",
    });
    assert.equal(status, 400);
    assert.ok(body && typeof body.error === "string");
  });

  it("returns 400 with error for non-http scheme, never 500", async () => {
    const { status, body } = await postIngest(port, {
      url: "ftp://example.com/x",
    });
    assert.equal(status, 400);
    assert.ok(body && typeof body.error === "string");
  });
});

describe("fetchUrlText / ingestUrl (direct)", () => {
  it("follows a single redirect and returns text with finalUrl", async () => {
    const { text, finalUrl } = await fetchUrlText(
      `http://127.0.0.1:${mockPort}/redirect`,
      { allowLoopback: true },
    );
    assert.ok(text.includes("Hello URL Paris"));
    assert.ok(finalUrl.endsWith("/hello"));
  });

  it("rejects a 4-hop redirect chain with FetchBlockedError", async () => {
    await assert.rejects(
      fetchUrlText(`http://127.0.0.1:${mockPort}/r1`, {
        allowLoopback: true,
      }),
      (err) => err instanceof FetchBlockedError,
    );
  });

  it("rejects an oversize body with FetchBlockedError", async () => {
    await assert.rejects(
      fetchUrlText(`http://127.0.0.1:${mockPort}/big`, {
        allowLoopback: true,
      }),
      (err) => err instanceof FetchBlockedError,
    );
  });

  it("ingestUrl chunks/stores and query cites the fetched text", async () => {
    const tenant = `url-test-${Date.now()}`;
    const result = await ingestUrl(
      `http://127.0.0.1:${mockPort}/hello`,
      tenant,
      { allowLoopback: true },
    );
    assert.equal(typeof result.docId, "string");
    assert.ok(result.chunks >= 1);
    const answer = retrieveAndAnswer(tenant, "Hello URL");
    assert.ok(answer.citations.length >= 1);
    assert.ok(
      answer.citations.some((c) => c.text.includes("Hello URL")),
    );
  });
});

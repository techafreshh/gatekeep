import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as sqliteVec from "sqlite-vec";
import { closeDb, insertChunk, isVecAvailable } from "../dist/db.js";
import { EMBEDDING_DIM } from "../dist/ingest.js";

let tmpdir;
let origCwd;

before(() => {
  origCwd = process.cwd();
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "gatekeep-view-offset-"));
  closeDb();
  process.chdir(tmpdir);
});

after(() => {
  closeDb();
  process.chdir(origCwd);
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

describe("insertChunk view offsets", () => {
  it("honors Float32Array view offsets", () => {
    const backing = new Float32Array(EMBEDDING_DIM * 2);
    for (let i = 0; i < backing.length; i++) {
      backing[i] = (i + 1) * 0.25;
    }
    const offset = EMBEDDING_DIM >> 1;
    const view = backing.subarray(offset, offset + EMBEDDING_DIM);
    assert.ok(view.byteOffset > 0);

    const rowId = insertChunk(
      "doc-view-offset",
      "default",
      0,
      "view offset probe text",
      "manual",
      view,
    );

    if (!isVecAvailable()) {
      return;
    }

    const db = new DatabaseSync(
      path.join(tmpdir, "data", "gatekeep.sqlite3"),
      { allowExtension: true },
    );
    try {
      sqliteVec.load(db);
    } catch {
      // Verification connection falls back to skipping vec byte checks.
      db.close();
      return;
    }
    try {
      const row = db
        .prepare("SELECT embedding FROM chunk_vec WHERE rowid = ?")
        .get(Number(rowId));
      assert.ok(row, "expected a chunk_vec row for the inserted chunk");
      const stored = Buffer.from(row.embedding);
      const expected = Buffer.from(
        view.buffer,
        view.byteOffset,
        view.byteLength,
      );
      assert.equal(stored.length, EMBEDDING_DIM * 4);
      assert.ok(
        stored.equals(expected),
        "stored embedding bytes must match the view window only",
      );
    } finally {
      db.close();
    }
  });
});

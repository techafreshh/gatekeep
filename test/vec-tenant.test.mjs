import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, getDb, insertChunk, isVecAvailable } from "../dist/db.js";
import { embedText } from "../dist/ingest.js";
import { vecSearch, VEC_LIMIT } from "../dist/retrieve.js";

let tmpdir;
let origCwd;

before(() => {
  origCwd = process.cwd();
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "gatekeep-vec-tenant-"));
  closeDb();
  process.chdir(tmpdir);
});

after(() => {
  closeDb();
  process.chdir(origCwd);
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

function tenantOf(id) {
  const row = getDb()
    .prepare("SELECT tenant_id FROM chunks WHERE id = ?")
    .get(id);
  return row ? String(row.tenant_id) : null;
}

describe("vecSearch tenant scoping", () => {
  it("is not starved by another tenant's closer vectors", () => {
    const query = "quasar nebula harbor";
    // Attacker chunks repeat the query terms exactly, so their embeddings
    // match the query embedding and rank strictly closer than the victim's.
    const attackerText = "quasar nebula harbor";
    const filler = Array.from({ length: 60 }, (_, i) => `filler${i}`).join(
      " ",
    );
    const victimText = `quasar nebula harbor ${filler}`;

    for (let i = 0; i < VEC_LIMIT + 5; i++) {
      insertChunk(
        `other-doc-${i}`,
        "other",
        0,
        attackerText,
        "manual",
        embedText(attackerText),
      );
    }
    const victimDocId = "victim-doc";
    insertChunk(
      victimDocId,
      "victim",
      0,
      victimText,
      "manual",
      embedText(victimText),
    );

    if (!isVecAvailable()) {
      return;
    }

    const hits = vecSearch("victim", query);
    assert.ok(
      hits.length >= 1,
      "expected the victim tenant to find its own chunk",
    );
    assert.ok(
      hits.some((hit) => hit.docId === victimDocId),
      "expected the victim chunk in the results",
    );
    for (const hit of hits) {
      assert.equal(
        tenantOf(hit.id),
        "victim",
        "every hit must belong to the querying tenant",
      );
    }

    const otherHits = vecSearch("other", query);
    assert.ok(otherHits.length >= 1);
    for (const hit of otherHits) {
      assert.equal(tenantOf(hit.id), "other");
    }
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chunkText, embedText } from "../dist/ingest.js";

const words = (n) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

describe("chunkText", () => {
  it("returns one chunk for a single sentence", () => {
    const chunks = chunkText("The Eiffel Tower is in Paris. ");
    assert.equal(chunks.length, 1);
    assert.match(chunks[0], /Eiffel Tower/);
  });

  it("slides 400-word windows with 50-word overlap", () => {
    const chunks = chunkText(words(900));
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].split(" ").length, 400);
    assert.equal(chunks[1].split(" ").length, 400);
    assert.deepEqual(chunks[1].split(" ").slice(0, 2), ["w350", "w351"]);
    assert.equal(chunks[2].split(" ").length, 200);
  });

  it("never returns an empty chunk", () => {
    for (const n of [1, 399, 400, 401, 750, 800]) {
      for (const chunk of chunkText(words(n))) {
        assert.ok(chunk.trim().length > 0);
      }
    }
  });

  it("returns no chunks for empty input", () => {
    assert.deepEqual(chunkText("   "), []);
  });
});

describe("embedText", () => {
  it("is deterministic with 128 dimensions", () => {
    const a = embedText("The Eiffel Tower is in Paris.");
    const b = embedText("The Eiffel Tower is in Paris.");
    assert.equal(a.length, 128);
    assert.deepEqual(Array.from(a), Array.from(b));
  });

  it("is L2-unit-length for non-empty input", () => {
    const vec = embedText("The Eiffel Tower is in Paris.");
    let sum = 0;
    for (const v of vec) {
      sum += v * v;
    }
    assert.ok(Math.abs(sum - 1) < 1e-6);
  });
});

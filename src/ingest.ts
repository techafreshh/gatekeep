import { randomUUID } from "node:crypto";
import { DEFAULT_TENANT, insertChunk } from "./db";

export const CHUNK_WORDS = 400;
export const CHUNK_OVERLAP = 50;
export const EMBEDDING_DIM = 128;

export function chunkText(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [];
  }
  const chunks: string[] = [];
  const step = CHUNK_WORDS - CHUNK_OVERLAP;
  for (let start = 0; start < words.length; start += step) {
    const window = words.slice(start, start + CHUNK_WORDS);
    if (window.length === 0) {
      break;
    }
    chunks.push(window.join(" "));
    if (start + CHUNK_WORDS >= words.length) {
      break;
    }
  }
  return chunks;
}

export function embedText(chunk: string): Float32Array {
  const vec = new Float32Array(EMBEDDING_DIM);
  const words = chunk.toLowerCase().split(/\s+/).filter(Boolean);
  for (const word of words) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < word.length; i++) {
      hash ^= word.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    vec[(hash >>> 0) % EMBEDDING_DIM] += 1;
  }
  let norm = 0;
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      vec[i] /= norm;
    }
  }
  return vec;
}

export function ingestText(
  text: string,
  source: string = "manual",
  tenant: string = DEFAULT_TENANT,
): { docId: string; chunks: number } {
  const chunks = chunkText(text.trim());
  const docId = randomUUID();
  chunks.forEach((chunk, index) => {
    insertChunk(docId, tenant, index, chunk, source, embedText(chunk));
  });
  return { docId, chunks: chunks.length };
}

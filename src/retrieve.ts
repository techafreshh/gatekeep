import { getDb, isVecAvailable } from "./db";
import { embedText } from "./ingest";

export const RRF_K = 60;
export const FTS_LIMIT = 20;
export const VEC_LIMIT = 20;
export const FUSED_TOP_N = 8;

export interface ChunkHit {
  id: number;
  docId: string;
  chunk: number;
  text: string;
}

export interface FusedHit extends ChunkHit {
  score: number;
}

export interface RankedHit extends FusedHit {
  overlap: number;
}

export interface QueryResult {
  answer: string;
  citations: Array<{ docId: string; chunk: number; text: string }>;
}

export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

export function ftsSearch(tenantId: string, query: string): ChunkHit[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return [];
  }
  const match = tokens.map((t) => `"${t}"`).join(" OR ");
  try {
    const database = getDb();
    const rows = database
      .prepare(
        "SELECT chunks.id AS id, chunks.doc_id AS docId, chunks.chunk_index AS chunk, chunks.text AS text " +
          "FROM chunks_fts JOIN chunks ON chunks.id = chunks_fts.rowid " +
          "WHERE chunks_fts MATCH ? AND chunks.tenant_id = ? " +
          "ORDER BY bm25(chunks_fts) LIMIT 20",
      )
      .all(match, tenantId) as Array<{
      id: number;
      docId: string;
      chunk: number;
      text: string;
    }>;
    return rows.map((row) => ({
      id: Number(row.id),
      docId: String(row.docId),
      chunk: Number(row.chunk),
      text: String(row.text),
    }));
  } catch {
    return [];
  }
}

export function vecSearch(tenantId: string, query: string): ChunkHit[] {
  try {
    if (!isVecAvailable()) {
      return [];
    }
    if (tokenize(query).length === 0) {
      return [];
    }
    const embedding = embedText(query);
    const blob = new Uint8Array(
      embedding.buffer,
      embedding.byteOffset,
      embedding.byteLength,
    );
    const database = getDb();
    let rows: Array<{ rowid: number | bigint }>;
    try {
      rows = database
        .prepare(
          `SELECT rowid, distance FROM chunk_vec WHERE embedding MATCH ? AND k = ${VEC_LIMIT} AND tenant_id = ?`,
        )
        .all(blob, tenantId) as Array<{ rowid: number | bigint }>;
    } catch {
      return [];
    }
    const out: ChunkHit[] = [];
    try {
      const stmt = database.prepare(
        "SELECT id, doc_id AS docId, chunk_index AS chunk, text FROM chunks WHERE id = ? AND tenant_id = ?",
      );
      for (const row of rows) {
        try {
          const id = Number(row.rowid);
          const found = stmt.get(id, tenantId) as {
            id: number;
            docId: string;
            chunk: number;
            text: string;
          } | null;
          if (found) {
            out.push({
              id: Number(found.id),
              docId: String(found.docId),
              chunk: Number(found.chunk),
              text: String(found.text),
            });
          }
        } catch {
          continue;
        }
      }
    } catch {
      return [];
    }
    return out;
  } catch {
    return [];
  }
}

export function reciprocalRankFuse(
  ftsRows: ChunkHit[],
  vecRows: ChunkHit[],
): FusedHit[] {
  const scores = new Map<
    number,
    { hit: ChunkHit; score: number }
  >();
  const add = (rows: ChunkHit[]): void => {
    rows.forEach((row, index) => {
      const rank = index + 1;
      const increment = 1 / (RRF_K + rank);
      const existing = scores.get(row.id);
      if (existing) {
        existing.score += increment;
      } else {
        scores.set(row.id, { hit: row, score: increment });
      }
    });
  };
  add(ftsRows);
  add(vecRows);
  return [...scores.values()]
    .map(({ hit, score }) => ({ ...hit, score }))
    .sort((a, b) => b.score - a.score || a.id - b.id)
    .slice(0, FUSED_TOP_N);
}

export function rerankByOverlap(
  query: string,
  candidates: FusedHit[],
): RankedHit[] {
  const queryTokens = new Set(tokenize(query));
  return candidates
    .map((candidate) => {
      const chunkTokens = new Set(tokenize(candidate.text));
      let overlap = 0;
      for (const token of queryTokens) {
        if (chunkTokens.has(token)) {
          overlap += 1;
        }
      }
      return { ...candidate, overlap };
    })
    .sort(
      (a, b) => b.overlap - a.overlap || b.score - a.score || a.id - b.id,
    );
}

function fallbackAnswer(query: string): QueryResult {
  return {
    answer: `No relevant documents found for "${query.slice(0, 200)}".`,
    citations: [],
  };
}

function pickSentence(text: string, query: string): string {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length === 0) {
    return text.slice(0, 300);
  }
  const queryTokens = new Set(tokenize(query));
  let best = sentences[0] as string;
  let bestScore = -1;
  for (const sentence of sentences) {
    const sentenceTokens = new Set(tokenize(sentence));
    let score = 0;
    for (const token of queryTokens) {
      if (sentenceTokens.has(token)) {
        score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = sentence;
    }
  }
  return best;
}

export function retrieveAndAnswer(
  tenantId: string,
  query: string,
): QueryResult {
  const ftsRows = ftsSearch(tenantId, query);
  const vecRows = vecSearch(tenantId, query);
  const fused = reciprocalRankFuse(ftsRows, vecRows);
  if (fused.length === 0) {
    return fallbackAnswer(query);
  }
  const ranked = rerankByOverlap(query, fused);
  if (ranked.length === 0 || (ranked[0] as RankedHit).overlap === 0) {
    return fallbackAnswer(query);
  }
  const top = ranked[0] as RankedHit;
  const answer = pickSentence(top.text, query);
  const cited = ranked.filter((hit) => hit.overlap > 0).slice(0, FUSED_TOP_N);
  if (cited.length === 0) {
    return fallbackAnswer(query);
  }
  return {
    answer,
    citations: cited.map((hit) => ({
      docId: hit.docId,
      chunk: hit.chunk,
      text: hit.text,
    })),
  };
}

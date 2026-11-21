import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import * as sqliteVec from "sqlite-vec";

export const DEFAULT_TENANT = "default";

let db: DatabaseSync | null = null;
let vecAvailable = false;

function migrationsDir(): string {
  const candidates = [
    path.join(__dirname, "..", "db"),
    path.join(process.cwd(), "db"),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) {
      return dir;
    }
  }
  return candidates[0] as string;
}

function runMigrations(database: DatabaseSync): void {
  const dir = migrationsDir();
  const files = readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(path.join(dir, file), "utf8");
    try {
      database.exec(sql);
    } catch {
      if (!vecAvailable && /vec0/i.test(sql)) {
        const withoutVec = sql
          .split("\n")
          .filter((line) => !/vec0/i.test(line))
          .join("\n");
        database.exec(withoutVec);
      } else {
        throw new Error(`Migration ${file} failed`);
      }
    }
  }
}

function ensureChunkVecTenantColumn(database: DatabaseSync): void {
  try {
    if (!vecAvailable) {
      return;
    }
    const row = database
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'chunk_vec'")
      .get() as { sql: string | null } | null;
    const sql = row?.sql ?? "";
    if (/tenant_id/i.test(sql)) {
      return;
    }
    // Snapshot preserved embedding bytes plus their tenant ids before
    // dropping the old single-column table. vec0 shadow tables do not
    // survive ALTER ... RENAME, so rebuild in place instead of the usual
    // create-copy-rename swap; re-inserting the raw bytes keeps the
    // upgrade byte-exact with no re-ingest.
    const oldRows = database
      .prepare("SELECT rowid, embedding FROM chunk_vec")
      .all() as Array<{
        rowid: number | bigint;
        embedding: Uint8Array | null;
      }>;
    const tenants = new Map<number, string>();
    const chunkRows = database
      .prepare("SELECT id, tenant_id FROM chunks")
      .all() as Array<{ id: number | bigint; tenant_id: string }>;
    for (const chunkRow of chunkRows) {
      tenants.set(Number(chunkRow.id), String(chunkRow.tenant_id));
    }
    database.exec("DROP TABLE chunk_vec");
    database.exec(
      "CREATE VIRTUAL TABLE chunk_vec USING vec0(embedding float[128], tenant_id TEXT PARTITION KEY)",
    );
    const insert = database.prepare(
      "INSERT INTO chunk_vec (rowid, embedding, tenant_id) VALUES (?, ?, ?)",
    );
    for (const oldRow of oldRows) {
      const tenantId = tenants.get(Number(oldRow.rowid));
      if (tenantId === undefined || oldRow.embedding === null) {
        continue;
      }
      try {
        insert.run(BigInt(Number(oldRow.rowid)), oldRow.embedding, tenantId);
      } catch {
        continue;
      }
    }
  } catch {
    // Best-effort upgrade; vecSearch already fails closed to FTS-only.
  }
}

export function getDb(): DatabaseSync {
  if (db) {
    return db;
  }
  const dbPath = path.join(process.cwd(), "data", "gatekeep.sqlite3");
  mkdirSync(path.dirname(dbPath), { recursive: true });
  // Pinned @types/node predates node:sqlite extension options and the
  // sqlite-vec loader signature, although the runtime supports both.
  type OpenOptions = ConstructorParameters<typeof DatabaseSync>[1];
  type LoadableDb = Parameters<typeof sqliteVec.load>[0];
  const database = new DatabaseSync(dbPath, { allowExtension: true } as OpenOptions);
  try {
    sqliteVec.load(database as unknown as LoadableDb);
    vecAvailable = true;
  } catch {
    vecAvailable = false;
    console.warn("sqlite-vec failed to load; continuing with FTS5 only");
  }
  runMigrations(database);
  ensureChunkVecTenantColumn(database);
  db = database;
  return db;
}

export function isVecAvailable(): boolean {
  return vecAvailable;
}

export function insertChunk(
  docId: string,
  tenantId: string,
  index: number,
  text: string,
  source: string,
  embedding: Float32Array,
): number {
  const database = getDb();
  const result = database
    .prepare(
      "INSERT INTO chunks (doc_id, tenant_id, chunk_index, text, source) VALUES (?, ?, ?, ?, ?)",
    )
    .run(docId, tenantId, index, text, source);
  const rowId = Number(result.lastInsertRowid);
  if (vecAvailable) {
    try {
      database
        .prepare("INSERT INTO chunk_vec (rowid, embedding, tenant_id) VALUES (?, ?, ?)")
        .run(BigInt(rowId), new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength), tenantId);
    } catch {
      // Vector insert is best-effort; the FTS row above is the source of truth.
    }
  }
  return rowId;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    vecAvailable = false;
  }
}

import type { IncomingMessage } from "node:http";

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 60;

const buckets = new Map<string, number[]>();

export function getTenantKeys(): string[] {
  const raw = process.env["TENANT_KEYS"] ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function authenticate(req: IncomingMessage): string | null {
  const keys = getTenantKeys();
  if (keys.length === 0) {
    return null;
  }
  const header = req.headers["authorization"];
  if (typeof header !== "string") {
    return null;
  }
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) {
    return null;
  }
  const key = header.slice(prefix.length).trim();
  if (key.length === 0) {
    return null;
  }
  if (!keys.includes(key)) {
    return null;
  }
  return key;
}

export function checkRateLimit(key: string): {
  allowed: boolean;
  retryAfterSec: number;
} {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  const existing = buckets.get(key) ?? [];
  const fresh = existing.filter((t) => t > cutoff);
  if (fresh.length >= MAX_REQUESTS) {
    const oldest = fresh[0] ?? now;
    const retryAfterSec = Math.max(
      1,
      Math.ceil((oldest + WINDOW_MS - now) / 1000),
    );
    buckets.set(key, fresh);
    return { allowed: false, retryAfterSec };
  }
  fresh.push(now);
  buckets.set(key, fresh);
  return { allowed: true, retryAfterSec: 0 };
}

export function resetRateLimits(): void {
  buckets.clear();
}

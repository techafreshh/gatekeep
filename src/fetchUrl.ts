import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class FetchBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchBlockedError";
  }
}

export const MAX_BYTES = 1048576;
export const FETCH_TIMEOUT_MS = 5000;
export const MAX_REDIRECTS = 3;

export interface FetchUrlOptions {
  allowLoopback?: boolean;
  allowPrivate?: boolean;
}

function isBlockedIPv4(ip: string, allowLoopback: boolean): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return true;
  }
  const bytes = parts.map((p) => Number(p));
  if (
    bytes.some(
      (n, i) =>
        !Number.isInteger(n) ||
        n < 0 ||
        n > 255 ||
        !/^\d+$/.test(parts[i] as string),
    )
  ) {
    return true;
  }
  const [a, b] = bytes as [number, number, number, number];
  if (a === 127) {
    return allowLoopback ? false : true;
  }
  if (a === 10) {
    return true;
  }
  if (a === 172 && (b as number) >= 16 && (b as number) <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 0) {
    return true;
  }
  if (a >= 224) {
    return true;
  }
  return false;
}

function expandIPv6Groups(addr: string): number[] | null {
  const clean = addr.toLowerCase().split("%")[0] as string;
  if (clean.includes(".")) {
    return null;
  }
  const halves = clean.split("::");
  if (halves.length > 2) {
    return null;
  }
  const parsePart = (part: string): number[] | null => {
    if (part === "") {
      return [];
    }
    const groups = part.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) {
        return null;
      }
      out.push(parseInt(g, 16));
    }
    return out;
  };
  if (halves.length === 1) {
    const groups = parsePart(halves[0] as string);
    if (groups === null || groups.length !== 8) {
      return null;
    }
    return groups;
  }
  const head = parsePart(halves[0] as string);
  const tail = parsePart(halves[1] as string);
  if (head === null || tail === null) {
    return null;
  }
  if (head.length + tail.length > 7) {
    return null;
  }
  const zeros = new Array<number>(8 - head.length - tail.length).fill(0);
  return [...head, ...zeros, ...tail];
}

export function isBlockedIp(ip: string, opts?: { allowLoopback?: boolean }): boolean {
  const allowLoopback = opts?.allowLoopback === true;
  const normalized = ip.toLowerCase().split("%")[0] as string;
  const version = isIP(normalized);
  if (version === 4) {
    return isBlockedIPv4(normalized, allowLoopback);
  }
  if (version === 6) {
    if (normalized.includes(".")) {
      const lastColon = normalized.lastIndexOf(":");
      const embedded = normalized.slice(lastColon + 1);
      if (isIP(embedded) === 4) {
        return isBlockedIPv4(embedded, allowLoopback);
      }
      return true;
    }
    if (normalized === "::1") {
      return allowLoopback ? false : true;
    }
    const groups = expandIPv6Groups(normalized);
    if (groups === null) {
      return true;
    }
    if (groups.every((g) => g === 0)) {
      return true;
    }
    if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
      return allowLoopback ? false : true;
    }
    const first = groups[0] as number;
    if ((first & 0xffc0) === 0xfe80) {
      return true;
    }
    if ((first & 0xfe00) === 0xfc00) {
      return true;
    }
    if ((first & 0xff00) === 0xff00) {
      return true;
    }
    if (
      groups.slice(0, 5).every((g) => g === 0) &&
      groups[5] === 0xffff
    ) {
      const hi = groups[6] as number;
      const lo = groups[7] as number;
      const embedded = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
      return isBlockedIPv4(embedded, allowLoopback);
    }
    return false;
  }
  return true;
}

async function assertHostAllowed(
  hostname: string,
  opts?: FetchUrlOptions,
): Promise<void> {
  if (opts?.allowPrivate === true) {
    return;
  }
  const allowLoopback = opts?.allowLoopback === true;
  const name = hostname.toLowerCase().split("%")[0] as string;
  if (isIP(name) !== 0) {
    if (isBlockedIp(name, { allowLoopback })) {
      throw new FetchBlockedError(`blocked address: ${hostname}`);
    }
    return;
  }
  let records: Array<{ address: string }>;
  try {
    records = await lookup(name, { all: true });
  } catch {
    throw new FetchBlockedError(`cannot resolve host: ${hostname}`);
  }
  if (records.length === 0) {
    throw new FetchBlockedError(`cannot resolve host: ${hostname}`);
  }
  for (const record of records) {
    if (isBlockedIp(record.address, { allowLoopback })) {
      throw new FetchBlockedError(`blocked address: ${hostname}`);
    }
  }
}

function badScheme(): FetchBlockedError {
  return new FetchBlockedError("only http and https URLs are allowed");
}

export async function fetchUrlText(
  rawUrl: string,
  opts?: FetchUrlOptions,
): Promise<{ text: string; finalUrl: string }> {
  let current: URL;
  try {
    current = new URL(String(rawUrl ?? "").trim());
  } catch {
    throw new FetchBlockedError("invalid URL");
  }
  if (current.protocol !== "http:" && current.protocol !== "https:") {
    throw badScheme();
  }
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertHostAllowed(current.hostname, opts);
    let res: Response;
    try {
      res = await fetch(current.toString(), {
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof FetchBlockedError) {
        throw err;
      }
      const msg =
        err instanceof Error && err.name === "TimeoutError"
          ? "fetch timed out"
          : "fetch failed";
      throw new FetchBlockedError(msg);
    }
    const status = res.status;
    if (status >= 300 && status < 400) {
      try {
        await res.arrayBuffer().catch(() => undefined);
      } catch {
        // Ignore body drain errors on redirect hops.
      }
      if (hop === MAX_REDIRECTS) {
        throw new FetchBlockedError("too many redirects");
      }
      const location = res.headers.get("location");
      if (!location) {
        throw new FetchBlockedError(`fetch failed with status ${status}`);
      }
      let next: URL;
      try {
        next = new URL(location, current.toString());
      } catch {
        throw new FetchBlockedError("invalid redirect target");
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw badScheme();
      }
      current = next;
      continue;
    }
    if (status < 200 || status >= 300) {
      try {
        await res.arrayBuffer().catch(() => undefined);
      } catch {
        // Ignore body drain errors on failure statuses.
      }
      throw new FetchBlockedError(`fetch failed with status ${status}`);
    }
    const declared = res.headers.get("content-length");
    if (declared !== null && declared.trim() !== "") {
      const size = Number(declared.trim());
      if (Number.isFinite(size) && size > MAX_BYTES) {
        try {
          await res.arrayBuffer().catch(() => undefined);
        } catch {
          // Ignore body drain errors on oversize responses.
        }
        throw new FetchBlockedError("response too large");
      }
    }
    let text: string;
    try {
      if (!res.body) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.byteLength > MAX_BYTES) {
          throw new FetchBlockedError("response too large");
        }
        text = buf.toString("utf8");
      } else {
        const reader = res.body.getReader();
        const chunks: Buffer[] = [];
        let total = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            total += value.byteLength;
            if (total > MAX_BYTES) {
              throw new FetchBlockedError("response too large");
            }
            chunks.push(Buffer.from(value));
          }
        } finally {
          reader.releaseLock();
        }
        text = Buffer.concat(chunks).toString("utf8");
      }
    } catch (err) {
      if (err instanceof FetchBlockedError) {
        try {
          await res.body?.cancel().catch(() => undefined);
        } catch {
          // Ignore cancel errors after a blocked stream.
        }
        throw err;
      }
      const msg =
        err instanceof Error && err.name === "TimeoutError"
          ? "fetch timed out"
          : "fetch failed";
      throw new FetchBlockedError(msg);
    }
    return { text, finalUrl: current.toString() };
  }
  throw new FetchBlockedError("too many redirects");
}

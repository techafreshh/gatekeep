import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { authenticate, checkRateLimit, getTenantKeys } from "./auth";
import { getAudit, logAudit } from "./audit";

interface Doc {
  docId: string;
  text: string;
}

type AuthedRequest = IncomingMessage & { tenant?: string };

const DOCS: Doc[] = [
  { docId: "doc-1", text: "Gatekeep is a secure multi-tenant RAG gateway." },
  { docId: "doc-2", text: "Answers always include quoted citations from retrieved chunks." },
  { docId: "doc-3", text: "The health endpoint reports whether the API is running." },
];

const tenantDocs = new Map<string, Doc[]>();
let docCounter = 1;

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
) => void;

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders?: Record<string, string | number>,
): void {
  const data = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      headers[k] = String(v);
    }
  }
  res.writeHead(status, headers);
  res.end(data);
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", () => reject(new Error("Invalid JSON")));
  });
}

function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, { ok: true });
}

function handleIngest(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): void {
  const tenant = (req as AuthedRequest).tenant ?? "default";
  let text: unknown;
  let url: unknown;
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    text = record["text"];
    url = record["url"];
  }
  let content: string | null = null;
  if (typeof text === "string" && text.trim().length > 0) {
    content = text;
  } else if (typeof url === "string" && url.trim().length > 0) {
    content = url;
  }
  if (content === null) {
    sendJson(res, 400, { error: "Missing text or url" });
    return;
  }
  const authEnabled = getTenantKeys().length > 0;
  const docId = `doc-${Date.now()}-${docCounter++}`;
  const doc: Doc = { docId, text: content };
  if (!authEnabled) {
    DOCS.push(doc);
  } else {
    const list = tenantDocs.get(tenant) ?? [];
    list.push(doc);
    tenantDocs.set(tenant, list);
  }
  logAudit(tenant, "ingest", docId);
  sendJson(res, 200, { docId, chunks: 1 });
}

function handleQuery(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): void {
  const tenant = (req as AuthedRequest).tenant ?? "default";
  let q = "";
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const candidate = (body as Record<string, unknown>)["q"];
    if (typeof candidate === "string") {
      q = candidate;
    }
  }
  const authEnabled = getTenantKeys().length > 0;
  if (!authEnabled) {
    const answer = `Stub answer for "${q}" based on ${DOCS.length} docs.`;
    const citations = DOCS.map((doc) => ({
      docId: doc.docId,
      chunk: 0,
      text: doc.text,
    }));
    logAudit(tenant, "query", q.slice(0, 200));
    sendJson(res, 200, { answer, citations });
    return;
  }
  const docs = tenantDocs.get(tenant) ?? [];
  const needle = q.toLowerCase();
  const matched =
    needle.trim() === ""
      ? []
      : docs.filter((doc) => doc.text.toLowerCase().includes(needle));
  const citations = matched.map((doc) => ({
    docId: doc.docId,
    chunk: 0,
    text: doc.text,
  }));
  const answer = `Stub answer for "${q}" based on ${matched.length} docs.`;
  logAudit(tenant, "query", q.slice(0, 200));
  sendJson(res, 200, { answer, citations });
}

function handleAudit(req: IncomingMessage, res: ServerResponse): void {
  const tenant = (req as AuthedRequest).tenant ?? "default";
  const rawUrl = req.url ?? "/";
  let limitParam: string | undefined;
  const qIdx = rawUrl.indexOf("?");
  if (qIdx >= 0) {
    const qs = rawUrl.slice(qIdx + 1);
    const params = new URLSearchParams(qs);
    const value = params.get("limit");
    if (value !== null) {
      limitParam = value;
    }
  }
  const entries = getAudit(tenant, limitParam);
  sendJson(res, 200, { entries });
}

function handleNotFound(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 404, { error: "Not found" });
}

const routes: Record<string, Handler> = {
  "GET /health": (req, res) => handleHealth(req, res),
  "POST /query": (req, res, body) => handleQuery(req, res, body),
  "POST /ingest": (req, res, body) => handleIngest(req, res, body),
  "GET /audit": (req, res) => handleAudit(req, res),
};

const server = createServer((req, res) => {
  (async () => {
    try {
      const method = (req.method ?? "").toUpperCase();
      const rawUrl = req.url ?? "/";
      const pathname = rawUrl.split("?")[0];
      const isHealth = method === "GET" && pathname === "/health";
      const authEnabled = getTenantKeys().length > 0;
      if (!isHealth) {
        if (authEnabled) {
          const tenant = authenticate(req);
          if (tenant === null) {
            logAudit("unknown", "block", `${method} ${pathname}`);
            sendJson(res, 401, { error: "Unauthorized" });
            return;
          }
          const rl = checkRateLimit(tenant);
          if (!rl.allowed) {
            logAudit(tenant, "block", "rate limit exceeded");
            sendJson(res, 429, { error: "Rate limit exceeded" }, { "Retry-After": String(rl.retryAfterSec) });
            return;
          }
          (req as AuthedRequest).tenant = tenant;
        } else {
          (req as AuthedRequest).tenant = "default";
        }
      }
      const key = `${method} ${pathname}`;
      const handler = routes[key];
      if (!handler) {
        handleNotFound(req, res);
        return;
      }
      let body: unknown = {};
      if (method === "POST" || method === "PUT" || method === "PATCH") {
        try {
          body = await readJsonBody(req);
        } catch {
          sendJson(res, 400, { error: "Invalid JSON" });
          return;
        }
      }
      handler(req, res, body);
    } catch {
      if (!res.headersSent) {
        sendJson(res, 500, { error: "Internal error" });
      }
    }
  })();
});

const port = Number(process.env["PORT"]) || 3000;
server.listen(port);

export { server, DOCS };

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { authenticate, checkRateLimit, getTenantKeys } from "./auth";
import { getAudit, logAudit } from "./audit";
import { ingestText, ingestUrl } from "./ingest";
import { cleanText } from "./guard";
import { FetchBlockedError } from "./fetchUrl";
import { retrieveAndAnswer } from "./retrieve";
import { isLlmEnabled, rewriteAnswerWithLlm } from "./llm";
import { runEval } from "./eval";

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

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
) => void | Promise<void>;

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

async function handleIngest(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const tenant = (req as AuthedRequest).tenant ?? "default";
  let text = "";
  let url = "";
  let source = "manual";
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if (typeof record["text"] === "string") {
      text = record["text"];
    }
    if (typeof record["url"] === "string") {
      url = record["url"];
    }
    if (typeof record["source"] === "string") {
      source = record["source"];
    }
  }
  if (text.trim().length === 0 && url.trim().length === 0) {
    sendJson(res, 400, { error: "text or url required" });
    return;
  }
  if (text.trim().length === 0) {
    const target = url.trim();
    try {
      const result = await ingestUrl(target, tenant);
      const authEnabled = getTenantKeys().length > 0;
      const doc: Doc = { docId: result.docId, text: result.text };
      if (!authEnabled) {
        DOCS.push(doc);
      } else {
        const list = tenantDocs.get(tenant) ?? [];
        list.push(doc);
        tenantDocs.set(tenant, list);
      }
      logAudit(
        tenant,
        "ingest",
        `${result.docId} alarms:${result.alarms.join(",") || "none"}`,
      );
      sendJson(res, 200, { docId: result.docId, chunks: result.chunks });
    } catch (err) {
      if (err instanceof FetchBlockedError) {
        logAudit(tenant, "block", err.message);
        sendJson(res, 400, { error: err.message });
      } else {
        sendJson(res, 400, { error: "Internal error" });
      }
    }
    return;
  }
  try {
    const { text: clean, alarms } = cleanText(text);
    // `source` is an opaque label stored in the chunks.source column only;
    // it is never used as a file path and never read from disk.
    const result = ingestText(clean, source, tenant);
    const authEnabled = getTenantKeys().length > 0;
    const doc: Doc = { docId: result.docId, text: clean };
    if (!authEnabled) {
      DOCS.push(doc);
    } else {
      const list = tenantDocs.get(tenant) ?? [];
      list.push(doc);
      tenantDocs.set(tenant, list);
    }
    logAudit(
      tenant,
      "ingest",
      `${result.docId} alarms:${alarms.join(",") || "none"}`,
    );
    sendJson(res, 200, result);
  } catch {
    logAudit(tenant, "block", "ingest failed");
    sendJson(res, 400, { error: "Internal error" });
  }
}

async function handleQuery(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  const tenant = (req as AuthedRequest).tenant ?? "default";
  let q = "";
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const candidate = (body as Record<string, unknown>)["q"];
    if (typeof candidate === "string") {
      q = candidate;
    }
  }
  if (q.trim().length === 0) {
    sendJson(res, 400, { error: "q required" });
    return;
  }
  const { text: cleanQ, alarms: qAlarms } = cleanText(q);
  const detail = `${cleanQ.slice(0, 200)} alarms:${qAlarms.join(",") || "none"}`;
  try {
    const result = retrieveAndAnswer(tenant, cleanQ);
    logAudit(tenant, "query", detail);
    if (result.citations.length > 0 && isLlmEnabled()) {
      try {
        const polished = await rewriteAnswerWithLlm(
          cleanQ,
          result.answer,
          result.citations.map((c) => c.text),
        );
        if (polished !== null && polished.length > 0) {
          sendJson(res, 200, {
            answer: polished,
            citations: result.citations,
          });
          return;
        }
      } catch {
        // Fall through to the extractive result below.
      }
    }
    sendJson(res, 200, result);
  } catch {
    logAudit(tenant, "query", detail);
    sendJson(res, 200, {
      answer: `No relevant documents found for "${cleanQ.slice(0, 200)}".`,
      citations: [],
    });
  }
}

function handleEval(req: IncomingMessage, res: ServerResponse): void {
  const tenant = (req as AuthedRequest).tenant ?? "default";
  try {
    const result = runEval(tenant);
    logAudit(
      tenant,
      "eval",
      `count=${result.count} faithfulness=${result.faithfulness} citation_precision=${result.citation_precision}`,
    );
    sendJson(res, 200, result);
  } catch {
    sendJson(res, 400, { error: "eval failed" });
  }
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
  "GET /eval": (req, res) => handleEval(req, res),
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
      await handler(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        if (err instanceof FetchBlockedError) {
          sendJson(res, 400, { error: err.message });
        } else {
          sendJson(res, 400, { error: "Internal error" });
        }
      }
    }
  })();
});

const port = Number(process.env["PORT"]) || 3000;
server.listen(port);

export { server, DOCS };

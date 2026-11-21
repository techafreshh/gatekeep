import { createServer, IncomingMessage, ServerResponse } from "node:http";

interface Doc {
  docId: string;
  text: string;
}

const DOCS: Doc[] = [
  { docId: "doc-1", text: "Gatekeep is a secure multi-tenant RAG gateway." },
  { docId: "doc-2", text: "Answers always include quoted citations from retrieved chunks." },
  { docId: "doc-3", text: "The health endpoint reports whether the API is running." },
];

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
) => void;

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const data = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json" });
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

function handleQuery(_req: IncomingMessage, res: ServerResponse, body: unknown): void {
  let q = "";
  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const candidate = (body as Record<string, unknown>)["q"];
    if (typeof candidate === "string") {
      q = candidate;
    }
  }
  const answer = `Stub answer for "${q}" based on ${DOCS.length} docs.`;
  const citations = DOCS.map((doc) => ({ docId: doc.docId, chunk: 0, text: doc.text }));
  sendJson(res, 200, { answer, citations });
}

function handleNotFound(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 404, { error: "Not found" });
}

const routes: Record<string, Handler> = {
  "GET /health": (req, res) => handleHealth(req, res),
  "POST /query": (req, res, body) => handleQuery(req, res, body),
};

const server = createServer((req, res) => {
  (async () => {
    try {
      const method = (req.method ?? "").toUpperCase();
      const rawUrl = req.url ?? "/";
      const pathname = rawUrl.split("?")[0];
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

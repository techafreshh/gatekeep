// Optional OpenRouter polish for extractive answers.
//
// NOTE: citations are assembled by the caller from retrieveAndAnswer and
// never parsed from LLM output — this module returns plain answer text only.

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MODEL = "openai/gpt-4o-mini";
const LLM_TIMEOUT_MS = 4000;

export function isLlmEnabled(): boolean {
  return (process.env["OPENROUTER_API_KEY"] ?? "").trim().length > 0;
}

export async function rewriteAnswerWithLlm(
  query: string,
  draftAnswer: string,
  contextTexts: string[],
): Promise<string | null> {
  const apiKey = (process.env["OPENROUTER_API_KEY"] ?? "").trim();
  if (apiKey.length === 0) {
    return null;
  }
  const baseRaw = (process.env["OPENROUTER_BASE_URL"] ?? "").trim();
  const base = (baseRaw.length > 0 ? baseRaw : DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  const modelRaw = (process.env["OPENROUTER_MODEL"] ?? "").trim();
  const model = modelRaw.length > 0 ? modelRaw : DEFAULT_MODEL;
  const contexts = contextTexts
    .filter((t) => typeof t === "string" && t.trim().length > 0)
    .slice(0, 8);
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 300,
        messages: [
          {
            role: "system",
            content:
              "Rewrite the draft answer in polished prose using only the provided context. Add no new facts. Return plain text only.",
          },
          {
            role: "user",
            content: `Question: ${query}\nDraft answer: ${draftAnswer}\nContext:\n${contexts.join("\n---\n")}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
    });
    if (!res.ok) {
      return null;
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return null;
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return null;
    }
    const choices = (data as Record<string, unknown>)["choices"];
    if (!Array.isArray(choices) || choices.length === 0) {
      return null;
    }
    const first = choices[0];
    if (first === null || typeof first !== "object" || Array.isArray(first)) {
      return null;
    }
    const message = (first as Record<string, unknown>)["message"];
    if (
      message === null ||
      typeof message !== "object" ||
      Array.isArray(message)
    ) {
      return null;
    }
    const content = (message as Record<string, unknown>)["content"];
    if (typeof content !== "string") {
      return null;
    }
    const polished = content.trim();
    if (polished.length === 0) {
      return null;
    }
    return polished;
  } catch {
    return null;
  }
}

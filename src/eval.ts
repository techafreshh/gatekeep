import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { ingestText } from "./ingest";
import { retrieveAndAnswer } from "./retrieve";

export interface GoldenItem {
  id: string;
  question: string;
  answer: string;
  context: string;
}

export interface EvalResult {
  count: number;
  faithfulness: number;
  citation_precision: number;
}

const seededTenants = new Set<string>();

function goldenCandidates(): string[] {
  return [
    path.join(__dirname, "..", "eval", "golden.json"),
    path.join(process.cwd(), "eval", "golden.json"),
  ];
}

export function loadGolden(): GoldenItem[] {
  for (const candidate of goldenCandidates()) {
    if (existsSync(candidate)) {
      const raw = readFileSync(candidate, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error("golden.json must be a JSON array");
      }
      return parsed as GoldenItem[];
    }
  }
  throw new Error("golden.json not found");
}

export function ensureSeeded(tenant: string): void {
  if (seededTenants.has(tenant)) {
    return;
  }
  const golden = loadGolden();
  for (const item of golden) {
    ingestText(item.context, "golden", tenant);
  }
  seededTenants.add(tenant);
}

export function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function runEval(tenant: string): EvalResult {
  ensureSeeded(tenant);
  const golden = loadGolden();
  if (golden.length === 0) {
    return { count: 0, faithfulness: 0, citation_precision: 0 };
  }
  let faithful = 0;
  let precise = 0;
  for (const item of golden) {
    try {
      const result = retrieveAndAnswer(tenant, item.question);
      const answer = normalize(result.answer);
      if (answer.length === 0) {
        continue;
      }
      if (normalize(item.context).includes(answer)) {
        faithful += 1;
      }
      for (const citation of result.citations) {
        if (normalize(citation.text).includes(answer)) {
          precise += 1;
          break;
        }
      }
    } catch {
      continue;
    }
  }
  return {
    count: golden.length,
    faithfulness: round3(faithful / golden.length),
    citation_precision: round3(precise / golden.length),
  };
}

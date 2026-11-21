export interface AuditEntry {
  ts: string;
  tenant: string;
  action: string;
  detail?: string;
}

const entries: AuditEntry[] = [];

export function logAudit(
  tenant: string,
  action: string,
  detail?: string,
): void {
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    tenant,
    action,
  };
  if (detail !== undefined) {
    entry.detail = detail;
  }
  entries.push(entry);
}

export function getAudit(tenant: string, limit?: unknown): AuditEntry[] {
  let n = 50;
  if (typeof limit === "number" && Number.isFinite(limit)) {
    n = Math.floor(limit);
  } else if (typeof limit === "string" && limit.trim() !== "") {
    const parsed = Number(limit);
    if (Number.isFinite(parsed)) {
      n = Math.floor(parsed);
    } else {
      n = 50;
    }
  } else if (limit === undefined) {
    n = 50;
  } else {
    n = 50;
  }
  if (!Number.isFinite(n)) {
    n = 50;
  }
  if (n < 1) {
    n = 1;
  }
  if (n > 100) {
    n = 100;
  }
  return entries
    .filter((e) => e.tenant === tenant)
    .slice(-n)
    .reverse();
}

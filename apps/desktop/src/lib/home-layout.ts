export interface SessionSummary {
  id: string;
  title: string;
  desc: string;
  task?: string;
  files?: string[];
  status?: string;
  when?: string;
  pinned?: boolean;
}

export function isHomeConversation(items: readonly { k: string; steer?: boolean }[]): boolean {
  return items.every((item) => item.k === "note" && !item.steer);
}

export function recentSessions(sessions: readonly SessionSummary[]): SessionSummary[] {
  const updated = (session: SessionSummary) => Date.parse(sessionTimestamp(session) || "") || 0;
  return [...sessions].sort((a, b) => updated(b) - updated(a)).slice(0, 4);
}

export function sessionTimestamp(session: SessionSummary): string | undefined {
  for (const value of [session.when, session.desc.split("·")[0].trim()]) {
    if (!value) continue;
    const time = Date.parse(value.replace(" ", "T"));
    if (!Number.isNaN(time)) return new Date(time).toISOString();
  }
}

export function sessionDetail(session: SessionSummary): string {
  const count = new Set(session.files).size;
  const outcome = sessionOutcome(session);
  if (!count) return outcome;
  const files = `${count} file${count === 1 ? "" : "s"} changed`;
  return outcome && outcome !== "Completed" ? `${files} · ${outcome}` : files;
}

function sessionOutcome(session: SessionSummary): string {
  const status = session.status?.trim();
  if (!status) return "";
  switch (status.toLowerCase()) {
    case "success":
    case "completed":
    case "done": return "Completed";
    case "error":
    case "failed": return "Failed";
    case "cancelled":
    case "canceled": return "Cancelled";
    default: return status.charAt(0).toUpperCase() + status.slice(1);
  }
}

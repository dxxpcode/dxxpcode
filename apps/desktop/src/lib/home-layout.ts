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
  const updated = (session: SessionSummary) => {
    const time = Date.parse((session.when || session.desc.split("·")[0].trim()).replace(" ", "T"));
    return Number.isNaN(time) ? 0 : time;
  };
  return [...sessions].sort((a, b) => updated(b) - updated(a)).slice(0, 4);
}

export function sessionDetail(session: SessionSummary): string {
  const count = new Set(session.files).size;
  if (count) return `${count} file${count === 1 ? "" : "s"} changed`;
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

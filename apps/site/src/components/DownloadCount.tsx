import { useEffect, useState } from "react";
import { ArrowDown } from "lucide-react";

// Below this floor the badge stays quiet — a small public number is worse
// than no number.
const MIN_DISPLAY = 500;

const COMPACT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

export function DownloadCount() {
  const [downloads, setDownloads] = useState<number | null>(null);

  useEffect(() => {
    fetch("/api/downloads")
      .then((r) => r.json())
      .then((d) => setDownloads(typeof d.downloads === "number" ? d.downloads : null))
      .catch(() => {});
  }, []);

  if (downloads === null || downloads < MIN_DISPLAY) return null;

  return (
    <span className="inline-flex h-11 items-center gap-2.5 text-[14px] text-muted-foreground">
      <ArrowDown strokeWidth={1.5} aria-hidden="true" className="h-3.5 w-3.5" />
      <span className="font-mono text-[13px] tabular-nums">{COMPACT.format(downloads)}</span>
      downloads
    </span>
  );
}

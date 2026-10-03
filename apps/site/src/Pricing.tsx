import { useCallback, useEffect, useState } from "react";

interface TierInfo {
  id: number;
  price_cents: number;
  sold: number;
  total: number;
  label: string;
  status: "active" | "upcoming" | "sold_out";
}

interface PricingState {
  active: { id: number; price_cents: number; sold: number; total: number; label: string } | null;
  ended: boolean;
  tiers: TierInfo[];
}

const money = (cents: number) => `$${Math.round(cents / 100)}`;

export default function Pricing() {
  const [state, setState] = useState<PricingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/pricing", { cache: "no-store" });
      if (!res.ok) throw new Error();
      const next = (await res.json()) as PricingState;
      setState((prev) => {
        // Price moved between page load and revalidation — surface it quietly.
        if (prev?.active && next.active && prev.active.price_cents !== next.active.price_cents) {
          setNotice(`Price updated — now ${money(next.active.price_cents)}.`);
        }
        return next;
      });
      return next;
    } catch {
      setError("Pricing is temporarily unavailable.");
      return null;
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const buy = async () => {
    setBusy(true);
    setError(null);
    try {
      // Revalidate inventory immediately before checkout — never act on a
      // stale price.
      const fresh = await refresh();
      if (!fresh?.active) {
        setError("The lifetime offer has ended.");
        return;
      }
      const res = await fetch("/api/checkout", { method: "POST" });
      const data = (await res.json().catch(() => null)) as { url?: string; message?: string } | null;
      if (res.status === 409) {
        setNotice(data?.message ?? "That tier just sold out — price updated.");
        refresh();
        return;
      }
      if (!res.ok || !data?.url) throw new Error();
      window.location.href = data.url;
    } catch {
      setError("Checkout is temporarily unavailable — try again.");
    } finally {
      setBusy(false);
    }
  };

  const active = state?.active ?? null;

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 pb-16 text-center">
      {!state && !error && <p className="text-[13px] text-muted-foreground">Loading…</p>}

      {error && !state && <p className="text-[13px] text-muted-foreground">{error}</p>}

      {state?.ended && (
        <>
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
            Lifetime offer ended
          </p>
          <h1 className="mt-4 text-[28px] font-medium tracking-[-0.02em]">
            All {state.tiers.reduce((n, t) => n + t.total, 0)} licenses claimed
          </h1>
          <p className="mt-3 text-[13px] text-muted-foreground">
            DxxpCode remains free during early access — <a className="text-foreground underline-offset-4 hover:underline" href="/">download</a>.
          </p>
        </>
      )}

      {state && !state.ended && active && (
        <>
          <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
            One-time payment
          </p>

          <div className="mt-6 flex items-baseline justify-center gap-3">
            <span className="text-[48px] font-medium leading-none tracking-[-0.03em]">
              {money(active.price_cents)}
            </span>
            <span className="text-[14px] text-muted-foreground">· lifetime</span>
          </div>

          <p className="mt-3 font-mono text-[12px] text-muted-foreground">
            ● {active.sold} of {active.total} claimed
          </p>

          <p className="mt-4 max-w-xs text-[13px] text-muted-foreground">
            One payment. All current and future versions.
          </p>

          <button
            onClick={buy}
            disabled={busy}
            className="mt-7 inline-flex h-11 items-center rounded-full bg-foreground px-6 text-[14px] font-medium text-background transition-opacity hover:opacity-85 disabled:opacity-50"
          >
            {busy ? "Opening checkout…" : `Buy Lifetime — ${money(active.price_cents)}`}
          </button>

          {notice && <p className="mt-3 text-[12px] text-muted-foreground">{notice}</p>}
          {error && <p className="mt-3 text-[12px] text-muted-foreground">{error}</p>}

          <div className="mt-10 grid grid-cols-3 gap-8 font-mono text-[12px]">
            {state.tiers.map((t) => (
              <div key={t.id} className="flex flex-col gap-1">
                <span className={
                  t.status === "sold_out"
                    ? "text-muted-foreground/50 line-through"
                    : t.status === "active"
                      ? "text-foreground"
                      : "text-muted-foreground"
                }>
                  {money(t.price_cents)}
                </span>
                <span className={
                  t.status === "active" ? "text-foreground" : "text-muted-foreground/60"
                }>
                  {t.status === "sold_out" ? "sold out" : t.label}
                </span>
              </div>
            ))}
          </div>

          <p className="mt-8 max-w-xs text-[11px] leading-relaxed text-muted-foreground/70">
            The price rises only when a tier sells out — never on a timer.
          </p>
        </>
      )}
    </main>
  );
}

interface PurchaseInfo {
  confirmed: boolean;
  license_key?: string;
  price_paid_cents?: number | null;
}

export function PricingSuccess() {
  const [info, setInfo] = useState<PurchaseInfo | null>(null);
  const sessionId = new URLSearchParams(window.location.search).get("session_id") ?? "";

  useEffect(() => {
    if (!sessionId) {
      setInfo({ confirmed: false });
      return;
    }
    const poll = async () => {
      const res = await fetch(`/api/purchase?session_id=${encodeURIComponent(sessionId)}`, {
        cache: "no-store",
      });
      if (res.ok) setInfo(await res.json());
      else setInfo({ confirmed: false });
    };
    poll();
    // The webhook may land a beat after redirect — retry a few times quietly.
    const t = setInterval(poll, 2500);
    const stop = setTimeout(() => clearInterval(t), 20000);
    return () => {
      clearInterval(t);
      clearTimeout(stop);
    };
  }, [sessionId]);

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 pb-16 text-center">
      <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
        {info?.confirmed ? "Payment confirmed" : "Confirming…"}
      </p>
      <h1 className="mt-4 text-[28px] font-medium tracking-[-0.02em]">
        {info?.confirmed ? "Lifetime Access" : "One moment"}
      </h1>

      {info?.confirmed && info.license_key && (
        <>
          <p className="mt-3 text-[13px] text-muted-foreground">
            Purchased for {info.price_paid_cents ? money(info.price_paid_cents) : ""} — this price is yours forever.
          </p>
          <div className="mt-6 rounded-lg border border-border bg-muted/40 px-5 py-3 font-mono text-[13px]">
            {info.license_key}
          </div>
          <p className="mt-4 max-w-xs text-[12px] leading-relaxed text-muted-foreground">
            Save this key — enter it in the app with <span className="font-mono">/license</span> or
            in Settings.
          </p>
        </>
      )}

      {info && !info.confirmed && (
        <p className="mt-4 max-w-xs text-[12px] leading-relaxed text-muted-foreground">
          Still confirming with the payment provider — this page updates automatically.
        </p>
      )}
    </main>
  );
}

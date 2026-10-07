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
  const [recovering, setRecovering] = useState(false);
  const [recoverEmail, setRecoverEmail] = useState("");
  const [sent, setSent] = useState(false);

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
          <p className="mt-8 font-mono text-[11px] text-muted-foreground/60">
            lost your key?{" "}
            <button
              onClick={() => setRecovering((v) => !v)}
              className="underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              resend →
            </button>
          </p>
          {recovering && (
            <form
              className="mt-3 flex items-center gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                setSent(true);
                await fetch(`/api/recover?email=${encodeURIComponent(recoverEmail)}`).catch(() => {});
              }}
            >
              <input
                type="email"
                required
                value={recoverEmail}
                onChange={(e) => setRecoverEmail(e.target.value)}
                placeholder="you@email.com"
                className="h-8 w-48 rounded-md border border-border bg-transparent px-3 font-mono text-[12px] outline-none placeholder:text-muted-foreground/50 focus:border-foreground/40"
              />
              <button className="h-8 rounded-md border border-border px-3 font-mono text-[12px] text-muted-foreground transition-colors hover:text-foreground">
                {sent ? "sent — check inbox" : "send"}
              </button>
            </form>
          )}
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
          <div className="mt-2 h-px w-40 bg-border">
            <div
              className="h-full bg-foreground transition-[width] duration-500"
              style={{ width: `${Math.min(100, (active.sold / active.total) * 100)}%` }}
            />
          </div>

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

          <div className="mt-10 flex items-start justify-center gap-0 font-mono text-[12px]">
            {state.tiers.map((t, i) => (
              <div key={t.id} className="flex items-center">
                {i > 0 && <div className="mx-3 mt-[-34px] h-px w-10 bg-border" />}
                <div className="flex w-16 flex-col items-center gap-2">
                  <span
                    className={
                      t.status === "sold_out"
                        ? "h-1.5 w-1.5 rounded-full bg-muted-foreground/40"
                        : t.status === "active"
                          ? "h-1.5 w-1.5 rounded-full bg-foreground ring-4 ring-foreground/10"
                          : "h-1.5 w-1.5 rounded-full border border-muted-foreground/40"
                    }
                  />
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
              </div>
            ))}
          </div>

          <p className="mt-8 max-w-xs text-[11px] leading-relaxed text-muted-foreground/70">
            The price rises only when a tier sells out — never on a timer.
          </p>

          <p className="mt-4 max-w-xs text-[11px] leading-relaxed text-muted-foreground/70">
            14-day money-back, no questions —{" "}
            <a href="mailto:licenses@dxxp.codes" className="underline-offset-2 hover:text-foreground hover:underline">
              licenses@dxxp.codes
            </a>
          </p>

          <p className="mt-6 font-mono text-[11px] text-muted-foreground/60">
            lost your key?{" "}
            <button
              onClick={() => setRecovering((v) => !v)}
              className="underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              resend →
            </button>
          </p>
          {recovering && (
            <form
              className="mt-3 flex items-center gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                setSent(true);
                await fetch(`/api/recover?email=${encodeURIComponent(recoverEmail)}`).catch(() => {});
              }}
            >
              <input
                type="email"
                required
                value={recoverEmail}
                onChange={(e) => setRecoverEmail(e.target.value)}
                placeholder="you@email.com"
                className="h-8 w-48 rounded-md border border-border bg-transparent px-3 font-mono text-[12px] outline-none placeholder:text-muted-foreground/50 focus:border-foreground/40"
              />
              <button className="h-8 rounded-md border border-border px-3 font-mono text-[12px] text-muted-foreground transition-colors hover:text-foreground">
                {sent ? "sent — check inbox" : "send"}
              </button>
            </form>
          )}
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
  const [copied, setCopied] = useState<"key" | "cmd" | null>(null);
  const sessionId = new URLSearchParams(window.location.search).get("session_id") ?? "";

  const copy = async (what: "key" | "cmd") => {
    if (!info?.license_key) return;
    await navigator.clipboard.writeText(
      what === "cmd" ? `/license ${info.license_key}` : info.license_key,
    );
    setCopied(what);
    setTimeout(() => setCopied(null), 1500);
  };

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
          <div className="mt-6 flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-5 py-3 font-mono text-[13px]">
            <span>{info.license_key}</span>
            <button
              onClick={() => copy("key")}
              className="ml-auto font-sans text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {copied === "key" ? "copied" : "copy"}
            </button>
          </div>
          <p className="mt-4 max-w-xs text-[12px] leading-relaxed text-muted-foreground">
            In the app, run{" "}
            <button onClick={() => copy("cmd")} className="font-mono text-foreground underline-offset-2 hover:underline">
              /license {info.license_key}
            </button>{" "}
            {copied === "cmd" ? "copied — " : ""}or paste the key in Settings.
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

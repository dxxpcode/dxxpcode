# Pricing & monetization model

Working draft — nothing here is implemented yet. This document captures the
pricing strategy and the unit economics behind it so future decisions stay
anchored to the numbers.

## Principles

1. **Price the agent, not the tokens.** Users already pay Anthropic/OpenAI
   subscriptions. DxxpCode's value is the agent loop, permissions, sessions,
   and terminal UX — not raw model access.
2. **Charge recurring only where costs are recurring.** Local features (BYOK
   CLI, permissions, sessions) cost nothing per user and stay free. Hosted
   inference, sync, and team infrastructure have real per-user costs.
3. **Never sell unlimited flat-rate inference.** The heavy tail (a power user
   can burn $50–200/mo of API tokens) makes flat "unlimited" plans
   structurally unprofitable — this is what forced Cursor and Replit to add
   metering after launch.
4. **No lifetime deals.** A one-time "forever" price trades a cash bump today
   for a perpetual support liability, and anchors the best early customers at
   the lowest price they'll ever pay.

## Tier structure

| Tier | Price | What you get |
|------|-------|--------------|
| **Free / BYOK** | $0 | Everything today: full CLI, plan→approve→execute, permissions, sessions, `@file` mentions, `/provider` connect. Bring your own provider keys. Fully functional, forever. |
| **Pro** | ~$10/mo | Convenience layer: managed inference (no key setup — `dxxpcode login` and go), included usage credits, session sync across machines, priority fixes. |
| **Team** | ~$20/seat/mo | Everything in Pro + admin-managed permission allowlists, org policy enforcement, audit logs of agent actions, centralized billing. |

Optional middle path: a **perpetual license for the current major version**
(Sublime Text model) — pay once, own that version, pay again for the next
major release. Addresses subscription fatigue without promising updates
forever. Sync/hosted features remain subscription-only.

## Managed inference economics

The Pro tier is where pricing meets costs. Model assumptions (rough, per
month):

- Light user: ~$2–5 of API tokens
- Median active user: ~$8–15
- Heavy "agentic all day" user: $30–200+

Flat-rate options at $10/mo:

| Plan shape | Light user | Median | Heavy user |
|---|---|---|---|
| Unlimited flat $10 | +$5–8 margin | ~breakeven | **−$20 to −$190 loss** |
| $10 + usage cap ($10 credits included, overage at cost+25%) | +$5–8 margin | +$2–4 margin | ~breakeven (metered) |

Conclusions:

- **Unlimited flat pricing loses on exactly the users who love the product
  most.** Never ship it.
- **Metered credits with a markup** (~25%) keeps every segment
  non-loss-making: light users fund the margin, heavy users pay for their
  own usage. Markup above ~30% loses to BYOK, since plugging in a personal
  key is one `/provider` command away.
- **BYOK remains the escape valve** — price-sensitive power users bypass the
  markup entirely, and that is fine: they cost nothing and stay in the
  ecosystem.
- **Team is the best margin** — orgs pay the markup willingly for
  centralized billing, admin controls, and not distributing provider keys.
  That is where resold inference is genuinely profitable.

## Auth implications (when the Pro tier lands)

- `dxxpcode login` — OAuth device-authorization flow (same as `gh auth
  login`); the browser does auth, the CLI polls for a token.
- Supabase Auth for accounts (email + OAuth), managed JWTs.
- Per-user `dxx_live_*` API keys, revocable from the dashboard, stored in
  `~/.dxxpcode/config.json` alongside provider keys — the existing
  `env > config` precedence chain already supports this shape.

## Initial capital required

The model is deliberately capital-light — no GPU spend (inference is
proxied, not hosted), no billing team (Stripe handles tax/invoicing).

**Phase 1 — BYOK free tier (today): ~$0–50/yr.**
Domain (~$12/yr) and site hosting on Vercel's free tier. npm publishing and
GitHub are free; users' model costs are their own.

**Phase 2 — Pro tier: a few hundred dollars + float.**

- Supabase Auth: free tier (~50k MAU); $25/mo when outgrown
- Stripe: no fixed cost — 2.9% + 30¢/charge, paid out of revenue
- Inference float (the only real cost): provider tokens are paid before
  user payments clear — worst case ~1 month of usage. For 100 Pro users at
  ~$10 avg usage that's ~$1–2k of working capital. Credit-prepay (charge
  before granting tokens) shrinks the float to near zero.
- Dashboard/API hosting: free tiers → ~$20–50/mo

**Realistically: <$500 to launch Pro, plus ~$1–2k float headroom if users
pay monthly instead of prepaying credits.**

**Phase 3 — Team: engineering time, not money.** Audit logs and policy
enforcement are features, not infrastructure spend.

The dominant cost across all phases is build time (auth + metering +
dashboard ≈ one solid build phase), not capital.

## What we are explicitly NOT doing

- No paywall on the local CLI — ever.
- No seat pricing for individuals.
- No lifetime / one-time-forever pricing.
- No unlimited inference at a flat rate.

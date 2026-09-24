import type { ApprovalRequest } from "@dxxpcode/agent";

export interface JevAnswer {
  type: "choice" | "noul" | "score";
  choice?: string;
  noul?: number;
  score?: number;
  confidence: number;
  probabilities?: Record<string, number>;
}

export interface JevResponse {
  model: string;
  answers: Record<string, JevAnswer>;
}

const BASE = "https://api.typesafe.ai";

/** One Jev call: state + typed questions → typed answers (70–500ms, calibrated). */
export async function jevDecide(
  apiKey: string,
  state: unknown,
  questions: Record<string, { type: string; instructions: string; criteria?: unknown }>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<JevResponse> {
  const res = await fetch(`${env.TYPESAFE_BASE_URL ?? BASE}/v1/systemone`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "jev-latest", state, questions }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`jev ${res.status}`);
  return (await res.json()) as JevResponse;
}

export interface SmartVerdict {
  approve: boolean;
  confidence: number;
}

/** Confidence floor for auto-approving without a menu. Below → escalate to the user. */
const APPROVE_THRESHOLD = 0.8;

/**
 * Classify an approval-tier tool call with Jev. Returns null when Jev can't be
 * reached — callers should fall back to the normal approval menu, never deny.
 */
export async function smartApprove(req: ApprovalRequest, apiKey: string): Promise<SmartVerdict | null> {
  try {
    const res = await jevDecide(
      apiKey,
      { tool: req.tool, input: req.input, reason: req.reason, risk: req.decision.reason },
      {
        verdict: {
          type: "choice",
          instructions:
            "An AI coding agent in a terminal wants to run this tool call. Choose 'approve' only when the action is routine, reversible, and clearly safe (install deps, run tests/build/lint, read-only git). Choose 'escalate' for anything destructive, irreversible, touching secrets/credentials, network-publishing, sudo, or ambiguous.",
          criteria: {
            approve: "routine, reversible, clearly safe",
            escalate: "destructive, risky, secret-related, or uncertain — a human should decide",
          },
        },
      },
    );
    const a = res.answers["verdict"];
    if (!a) return null;
    return { approve: a.choice === "approve" && a.confidence >= APPROVE_THRESHOLD, confidence: a.confidence };
  } catch {
    return null;
  }
}

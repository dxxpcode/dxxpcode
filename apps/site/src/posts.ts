import type { ComponentType } from "react";
import { AgentLoop } from "./posts/agent-loop";
import { EditsThatDontFail } from "./posts/edits-that-dont-fail";
import { PermissionModel } from "./posts/permission-model";
import { TwoModelsOneDiff } from "./posts/two-models-one-diff";

export type Post = {
  slug: string;
  title: string;
  dek: string;
  date: string;
  tag: "Engineering" | "API";
  minutes: number;
  body: ComponentType;
};

export const POSTS: Post[] = [
  {
    slug: "the-agent-loop-is-the-product",
    title: "The agent loop is the product",
    dek: "Two agents on the same model diverge almost entirely on harness quality. What our plan → approve → execute → verify → review loop buys, and what each stage prevents.",
    date: "Oct 1, 2026",
    tag: "Engineering",
    minutes: 6,
    body: AgentLoop,
  },
  {
    slug: "edits-that-dont-fail",
    title: "Making edits that don't fail",
    dek: "A failed patch shouldn't burn a turn: whitespace-tolerant matching, batch edits, and miss-hints that return the closest region — so a miss becomes a one-retry self-correction.",
    date: "Oct 1, 2026",
    tag: "Engineering",
    minutes: 5,
    body: EditsThatDontFail,
  },
  {
    slug: "a-permission-model-you-can-reason-about",
    title: "A permission model you can reason about",
    dek: "Safe-prefix allowlists leak — env rm, xargs, node -e. Exec-vector classification plus canonicalized paths close the holes.",
    date: "Oct 1, 2026",
    tag: "Engineering",
    minutes: 5,
    body: PermissionModel,
  },
  {
    slug: "two-models-one-diff",
    title: "Two models, one diff",
    dek: "The blind review pass: a fresh-context model audits only the diff — never the reasoning that produced it. Why context separation is what makes it work.",
    date: "Oct 1, 2026",
    tag: "Engineering",
    minutes: 4,
    body: TwoModelsOneDiff,
  },
];

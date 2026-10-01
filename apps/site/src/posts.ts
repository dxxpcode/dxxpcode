export type Post = {
  slug: string;
  title: string;
  dek: string;
  date: string;
  tag: "Engineering" | "Product";
  minutes: number;
};

export const POSTS: Post[] = [
  {
    slug: "the-agent-loop-is-the-product",
    title: "The agent loop is the product",
    dek: "Two coding agents on the same model differ almost entirely in harness quality. What our plan→approve→execute→verify→review loop buys, and what each stage prevents.",
    date: "Oct 1, 2026",
    tag: "Engineering",
    minutes: 6,
  },
  {
    slug: "edits-that-dont-fail",
    title: "Making edits that don't fail",
    dek: "An `edit_file` tool with whitespace-tolerant matching, batch edits, and miss-hints that return the closest region — so a failed patch becomes a one-retry self-correction.",
    date: "Oct 1, 2026",
    tag: "Engineering",
    minutes: 5,
  },
  {
    slug: "a-permission-model-you-can-reason-about",
    title: "A permission model you can reason about",
    dek: "Why safe-prefix allowlists alone leak — `env rm`, `xargs`, `node -e` — and how exec-vector classification plus canonicalized paths close the holes.",
    date: "Oct 1, 2026",
    tag: "Engineering",
    minutes: 5,
  },
  {
    slug: "two-models-one-diff",
    title: "Two models, one diff",
    dek: "The blind review pass: a fresh-context model audits only the diff — never the reasoning that produced it. What context separation actually catches.",
    date: "Oct 1, 2026",
    tag: "Engineering",
    minutes: 4,
  },
];

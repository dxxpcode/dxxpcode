// Scripted stand-in for the CLI sidecar, used only by `vite dev` in a browser.
// Query params: ?setup=1 forces onboarding, ?dark=1 forces dark theme.
import type { Transport } from "./transport";

const COMMANDS = [
  { name: "/review", desc: "show the working-tree diff" },
  { name: "/model", desc: "pick the model for the next task" },
  { name: "/status", desc: "session, config, and usage info" },
  { name: "/settings", desc: "approval mode, provider, model, effort" },
  { name: "/approval", desc: "approval mode — ask, always, or smart (Jev)" },
  { name: "/effort", desc: "reasoning effort for the next task" },
  { name: "/setup", desc: "guided setup — provider, effort, optional Jev key" },
  { name: "/providers", desc: "switch between configured providers" },
  { name: "/undo", desc: "restore files from the last checkpoint" },
  { name: "/compact", desc: "compress old tool output in the session context" },
  { name: "/docs", desc: "reference — install, commands, flags, config" },
  { name: "/changelog", desc: "release history" },
  { name: "/clear", desc: "clear the transcript" },
  { name: "/new", desc: "start a new session — resets context and approvals" },
  { name: "/resume", desc: "resume a previous session for this project" },
  { name: "/help", desc: "list available commands" },
  { name: "/exit", desc: "quit" },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function mockTransport(): Transport {
  const listeners = new Set<(line: string) => void>();
  const emit = (ev: object) => listeners.forEach((l) => l(JSON.stringify(ev)));
  const params = new URLSearchParams(location.search);
  let nextId = 1;
  const pending = new Map<number, (v: number | string | null) => void>();

  const menu = (title: string, options: { label: string; desc?: string }[], current?: number) =>
    new Promise<number | null>((res) => {
      const id = nextId++;
      pending.set(id, (v) => res(typeof v === "number" ? v : null));
      emit({ type: "menu", id, title, options, current });
    });
  const prompt = (title: string, secret = false) =>
    new Promise<string | null>((res) => {
      const id = nextId++;
      pending.set(id, (v) => res(typeof v === "string" ? v : null));
      emit({ type: "prompt", id, title, secret });
    });
  const ask = (summary: string, reason?: string) =>
    new Promise<string>((res) => {
      const id = nextId++;
      pending.set(id, (v) => res(String(v)));
      emit({ type: "approval", id, kind: "tool", summary, reason, allowAlways: true });
    });

  const setup = async () => {
    emit({ type: "note", text: "welcome to dxxpcode — connect a provider to get started" });
    const which = await menu("Connect a provider", [
      { label: "Anthropic", desc: "Claude models" },
      { label: "OpenAI-compatible", desc: "OpenAI, OpenRouter, local endpoints" },
    ]);
    if (which === null) return;
    const key = await prompt(which === 0 ? "Anthropic API key:" : "OpenAI-compatible API key:", true);
    if (!key?.trim()) return;
    if (which === 1) await prompt("Base URL (blank = api.openai.com):");
    emit({ type: "note", text: `${which === 0 ? "Anthropic" : "OpenAI-compatible"} key saved` });
    await menu(
      "Reasoning effort — applies to the next task",
      [
        { label: "default", desc: "provider default" },
        { label: "low", desc: "fast, cheaper" },
        { label: "medium", desc: "balanced" },
        { label: "high", desc: "deeper reasoning" },
        { label: "auto (Jev)", desc: "picks per task" },
      ],
      0,
    );
    await prompt("Optional: TYPESAFE_API_KEY for smart approvals + auto effort (blank to skip):", true);
    emit({ type: "note", text: "you're all set — ask dxxpcode anything" });
  };

  const run = async (text: string) => {
    emit({ type: "user", text });
    emit({ type: "status", message: "Thinking…" });
    await sleep(600);
    emit({ type: "plan", plan: { summary: "Add a health endpoint to the server.", steps: ["Read the router", "Add GET /health", "Write a test"] } });
    emit({ type: "tool_start", tool: "read_file", input: { path: "apps/server/src/router.ts" } });
    await sleep(500);
    emit({ type: "tool_end", tool: "read_file", result: { content: "export const router = new Router();\nrouter.get('/', home);\n" } });
    emit({ type: "tool_start", tool: "run_command", input: { command: "npm test -- router" } });
    await sleep(600);
    emit({ type: "tool_end", tool: "run_command", result: { content: "✓ router (3 tests)\n\n3 passing", isError: false } });
    const c = await ask("edit_file apps/server/src/router.ts", "writes outside the allowlist");
    if (c === "n") {
      emit({ type: "denied", tool: "edit_file", reason: "user denied" });
    } else {
      emit({ type: "tool_start", tool: "edit_file", input: { path: "apps/server/src/router.ts" } });
      await sleep(500);
      emit({
        type: "tool_end",
        tool: "edit_file",
        result: {
          content: "ok",
          diff: "--- a/apps/server/src/router.ts\n+++ b/apps/server/src/router.ts\n@@ -1,2 +1,3 @@\n export const router = new Router();\n router.get('/', home);\n+router.get('/health', () => ({ ok: true }));\n",
        },
      });
    }
    emit({ type: "todo", items: [
      { status: "completed", content: "Read the router" },
      { status: "in_progress", content: "Add GET /health", activeForm: "Adding GET /health" },
      { status: "pending", content: "Write a test" },
    ] });
    emit({ type: "status", message: "Writing…" });
    await sleep(400);
    for (const chunk of ["I added a `/health` route that returns `{ ok: true }`.\n\n", "```ts\nrouter.get('/health', () => ({ ok: true }));\n```\n\n", "Run `npm test` to verify — all 3 router tests still pass."]) {
      emit({ type: "text", text: chunk });
      await sleep(250);
    }
    emit({ type: "done", result: { status: "completed", summary: "", filesChanged: ["apps/server/src/router.ts"], usage: { inputTokens: 4120, outputTokens: 380 } } });
    emit({ type: "session", id: "s_7f3a9c", tokens: 4500 });
    emit({ type: "idle" });
  };

  return {
    async send(cmd) {
      const c = cmd as { type: string; id?: number; index?: number; text?: string; choice?: string; name?: string };
      switch (c.type) {
        case "select": pending.get(c.id!)?.(c.index === -1 ? null : c.index!); pending.delete(c.id!); break;
        case "prompt_submit": pending.get(c.id!)?.(c.text ?? null); pending.delete(c.id!); break;
        case "approve": pending.get(c.id!)?.(c.choice ?? "n"); pending.delete(c.id!); break;
        case "submit": void run(c.text ?? ""); break;
        case "list_files":
          emit({ type: "files", id: c.id, items: ["src/", "src/App.tsx", "src/styles.css", "package.json"].filter((f) => f.includes(c.text ?? "")).map((name) => ({ name, desc: name.endsWith("/") ? "dir" : "file" })) });
          break;
        case "command":
          if (c.name === "/setup") void setup();
          else if (c.name === "/docs" || c.name === "/help" || c.name === "/changelog")
            emit({ type: "markdown", title: c.name === "/changelog" ? "Changelog" : "Reference", text: "# dxxpcode\n\nA terminal-native AI coding agent.\n\n## Commands\n\n- `/review` — show the diff\n- `/model` — pick a model\n\n## Flags\n\n| flag | meaning |\n|---|---|\n| `--app` | JSON event mode |" });
          else if (c.name === "/status")
            emit({ type: "table", title: "Status", rows: [["provider", "anthropic · claude-sonnet-4"], ["mode", "ask"], ["version", "v0.2.0"]] });
          else if (c.name === "/effort")
            void menu("Reasoning effort — applies to the next task", [{ label: "default" }, { label: "low" }, { label: "high" }], 0);
          else if (c.name === "/providers" || c.name === "/model")
            void menu("Provider", [{ label: "anthropic", desc: "claude-sonnet-4" }, { label: "openai", desc: "gpt-4.1" }], 0);
          else if (c.name === "/approval")
            void menu("Approval mode — applied to the next task and saved", [{ label: "ask" }, { label: "always-approve" }, { label: "smart (Jev)" }], 0);
          break;
        case "cancel": emit({ type: "idle" }); break;
      }
    },
    async subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    async ready() {
      await sleep(50);
      emit({
        type: "ready",
        version: "0.2.0",
        provider: "anthropic",
        model: "claude-sonnet-4",
        effort: "medium",
        mode: "ask",
        needsSetup: params.get("setup") === "1",
        commands: COMMANDS,
        project: { name: "dxxpcode-terminal", languages: ["TypeScript", "Rust"], git: { branch: "main", dirty: true } },
      });
      emit({ type: "session", id: null, tokens: 0 });
    },
    async close() {
      console.log("[mock] window.close()");
    },
  };
}

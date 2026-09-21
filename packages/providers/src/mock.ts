import type { ChatRequest, JsonObject, ModelProvider, ProviderEvent } from "./types.ts";

export interface MockTurn {
  text?: string;
  toolCalls?: Array<{ name: string; input: JsonObject }>;
  stopReason?: string;
  /** Artificial latency (ms) before this turn streams — for testing thinking UI. */
  delayMs?: number;
}

export type MockScript = MockTurn[] | ((req: ChatRequest, turn: number) => MockTurn);

/**
 * Deterministic provider for tests and offline development.
 * Each chat() call consumes the next scripted turn.
 */
export class MockProvider implements ModelProvider {
  readonly name = "mock";
  private turn = 0;
  readonly requests: ChatRequest[] = [];

  private readonly script: MockScript;

  constructor(script: MockScript) {
    this.script = script;
  }

  async *chat(req: ChatRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(req);
    const turn = this.turn++;
    const t = Array.isArray(this.script) ? this.script[turn] : this.script(req, turn);
    if (!t) {
      yield { type: "text", text: "(mock: no scripted turn)" };
      yield { type: "done", stopReason: "end_turn" };
      return;
    }
    if (t.delayMs) await new Promise((r) => setTimeout(r, t.delayMs));
    if (t.text) {
      for (const chunk of t.text.match(/.{1,24}/gs) ?? []) {
        yield { type: "text", text: chunk };
      }
    }
    let n = 0;
    for (const call of t.toolCalls ?? []) {
      yield {
        type: "tool_use",
        call: { type: "tool_use", id: `mock_${turn}_${n++}`, name: call.name, input: call.input },
      };
    }
    yield { type: "done", stopReason: t.stopReason ?? (t.toolCalls?.length ? "tool_use" : "end_turn") };
  }
}

import { ProviderError } from "./types.ts";
import type { ChatRequest, Message, ModelProvider, ProviderEvent, ToolDefinition, Usage } from "./types.ts";
import { readSse } from "./sse.ts";

export class OpenAIProvider implements ModelProvider {
  readonly name = "openai";

  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = "https://api.openai.com/v1") {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  async *chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: req.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: req.system },
          ...req.messages.flatMap(toApiMessages),
        ],
        tools: req.tools.map(toApiTool),
        max_tokens: req.maxTokens,
        ...(req.effort ? { reasoning_effort: req.effort } : {}),
      }),
      signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new ProviderError(`OpenAI API error ${res.status}: ${detail.slice(0, 400)}`, res.status);
    }

    let usage: Usage | undefined;
    let stopReason = "stop";
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();
    let counter = 0;

    for await (const { data } of readSse(res.body, signal)) {
      if (signal?.aborted) return;
      if (data === "[DONE]") break;
      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      if (parsed.usage) {
        usage = {
          inputTokens: parsed.usage.prompt_tokens ?? 0,
          outputTokens: parsed.usage.completion_tokens ?? 0,
        };
      }
      const choice = parsed.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content) {
        yield { type: "text", text: delta.content };
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        let entry = toolCalls.get(idx);
        if (!entry) {
          entry = { id: tc.id ?? `call_${counter++}`, name: "", args: "" };
          toolCalls.set(idx, entry);
        }
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
      }
      if (choice.finish_reason) {
        stopReason = choice.finish_reason;
        for (const [, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
          let input: Record<string, unknown> = {};
          try {
            input = call.args ? JSON.parse(call.args) : {};
          } catch {
            input = { __raw: call.args };
          }
          yield { type: "tool_use", call: { type: "tool_use", id: call.id, name: call.name, input } };
        }
        toolCalls.clear();
      }
    }
    yield { type: "done", stopReason, usage };
  }
}

/**
 * Translate internal messages to the OpenAI wire shape. Assistant tool_use
 * blocks become `tool_calls`; each tool_result becomes its own role:"tool"
 * message, so one internal user message may expand to several wire messages.
 */
function toApiMessages(m: Message): Record<string, unknown>[] {
  const texts: string[] = [];
  const toolCalls: unknown[] = [];
  const toolResults: Record<string, unknown>[] = [];
  for (const b of m.content) {
    if (b.type === "text") texts.push(b.text);
    else if (b.type === "tool_use") {
      toolCalls.push({
        id: b.id,
        type: "function",
        function: { name: b.name, arguments: JSON.stringify(b.input) },
      });
    } else {
      toolResults.push({ role: "tool", tool_call_id: b.toolUseId, content: b.content });
    }
  }
  if (toolResults.length > 0) {
    const prefix = texts.length > 0 ? [{ role: m.role, content: texts.join("") }] : [];
    return [...prefix, ...toolResults] as Record<string, unknown>[];
  }
  const out: Record<string, unknown> = { role: m.role, content: texts.join("") || null };
  if (toolCalls.length > 0) out.tool_calls = toolCalls;
  return [out];
}

function toApiTool(t: ToolDefinition) {
  return {
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  };
}

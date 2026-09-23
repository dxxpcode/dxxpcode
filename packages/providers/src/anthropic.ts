import { ProviderError } from "./types.ts";
import type { ChatRequest, Message, ModelProvider, ProviderEvent, ToolDefinition, Usage } from "./types.ts";
import { readSse } from "./sse.ts";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/** thinking.budget_tokens per effort level; the API requires max_tokens > budget. */
const EFFORT_BUDGET = { minimal: 1024, low: 4096, medium: 16384, high: 32768, xhigh: 49152, max: 61440 } as const;

export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";

  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: { "x-api-key": this.apiKey, "anthropic-version": API_VERSION },
      signal,
    });
    if (!res.ok) throw new ProviderError(`Anthropic API error ${res.status}`, res.status);
    const body = (await res.json()) as { data?: { id?: string }[] };
    return (body.data ?? []).map((m) => m.id ?? "").filter(Boolean);
  }

  async *chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ProviderEvent> {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: Math.max(
          req.maxTokens ?? 8192,
          req.effort ? EFFORT_BUDGET[req.effort] + 2048 : 0,
        ),
        system: req.system,
        messages: req.messages.map(toApiMessage),
        tools: req.tools.map(toApiTool),
        stream: true,
        ...(req.effort
          ? { thinking: { type: "enabled", budget_tokens: EFFORT_BUDGET[req.effort] } }
          : {}),
      }),
      signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new ProviderError(`Anthropic API error ${res.status}: ${detail.slice(0, 400)}`, res.status);
    }

    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    // Block state: accumulate tool_use input JSON keyed by content-block index.
    const toolBlocks = new Map<number, { id: string; name: string; json: string }>();
    let stopReason = "end_turn";

    for await (const { event, data } of readSse(res.body, signal)) {
      if (signal?.aborted) return;
      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      switch (event) {
        case "message_start":
          if (parsed.message?.usage) {
            usage.inputTokens = parsed.message.usage.input_tokens ?? 0;
            usage.outputTokens = parsed.message.usage.output_tokens ?? 0;
          }
          break;
        case "content_block_start":
          if (parsed.content_block?.type === "tool_use") {
            toolBlocks.set(parsed.index, {
              id: parsed.content_block.id,
              name: parsed.content_block.name,
              json: "",
            });
          }
          break;
        case "content_block_delta":
          if (parsed.delta?.type === "text_delta" && parsed.delta.text) {
            yield { type: "text", text: parsed.delta.text };
          } else if (parsed.delta?.type === "input_json_delta") {
            const block = toolBlocks.get(parsed.index);
            if (block) block.json += parsed.delta.partial_json ?? "";
          }
          break;
        case "content_block_stop": {
          const block = toolBlocks.get(parsed.index);
          if (block) {
            toolBlocks.delete(parsed.index);
            let input: Record<string, unknown> = {};
            try {
              input = block.json ? JSON.parse(block.json) : {};
            } catch {
              input = { __raw: block.json };
            }
            yield { type: "tool_use", call: { type: "tool_use", id: block.id, name: block.name, input } };
          }
          break;
        }
        case "message_delta":
          if (parsed.delta?.stop_reason) stopReason = parsed.delta.stop_reason;
          if (parsed.usage?.output_tokens != null) usage.outputTokens = parsed.usage.output_tokens;
          break;
        case "message_stop":
          yield { type: "done", stopReason, usage };
          break;
        case "error":
          throw new ProviderError(`Anthropic stream error: ${data.slice(0, 300)}`);
        default:
          break;
      }
    }
  }
}

function toApiMessage(m: Message): { role: string; content: unknown[] } {
  return {
    role: m.role,
    content: m.content.map((b) => {
      switch (b.type) {
        case "text":
          return { type: "text", text: b.text };
        case "tool_use":
          return { type: "tool_use", id: b.id, name: b.name, input: b.input };
        case "tool_result":
          return {
            type: "tool_result",
            tool_use_id: b.toolUseId,
            content: [{ type: "text", text: b.content }],
            is_error: b.isError ?? false,
          };
      }
    }),
  };
}

function toApiTool(t: ToolDefinition) {
  return { name: t.name, description: t.description, input_schema: t.inputSchema };
}

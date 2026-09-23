export type JsonObject = Record<string, unknown>;

/** JSON Schema (subset) for tool inputs. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: JsonObject;
}

export interface ToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type ProviderEvent =
  | { type: "text"; text: string }
  | { type: "tool_use"; call: ToolUseBlock }
  | { type: "done"; stopReason: string; usage?: Usage };

/** One checklist item maintained by the agent via the todo_write tool. */
export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  /** Present-continuous label shown while the item is in progress. */
  activeForm?: string;
}

/** Reasoning effort; mapped per-provider (Anthropic thinking budget, OpenAI reasoning_effort). */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ChatRequest {
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
  model: string;
  maxTokens?: number;
  effort?: ReasoningEffort;
}

export interface ModelProvider {
  name: string;
  chat(req: ChatRequest, signal?: AbortSignal): AsyncIterable<ProviderEvent>;
  /** Live model list from the provider API, newest first where the API supports it. */
  listModels?(signal?: AbortSignal): Promise<string[]>;
}

export class ProviderError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

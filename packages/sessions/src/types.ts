import type { JsonObject, Message, TodoItem } from "@dxxpcode/providers";

export interface RecordedToolCall {
  name: string;
  input: JsonObject;
  isError?: boolean;
  changedFile?: string;
  denied?: boolean;
}

export interface SessionRecord {
  version: 1;
  id: string;
  projectRoot: string;
  createdAt: string;
  updatedAt: string;
  task: string;
  messages: Message[];
  toolCalls: RecordedToolCall[];
  filesChanged: string[];
  commands: string[];
  /** Latest agent-maintained checklist from the todo_write tool. */
  todos?: TodoItem[];
  result?: string;
}

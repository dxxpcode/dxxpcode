export function composerAction(
  input: string,
  running: boolean,
  completingFile = false,
  completingCommand = false,
): "send" | "queue" | "complete" {
  if (completingFile || completingCommand) return "complete";
  return running && !input.trim().startsWith("/") ? "queue" : "send";
}

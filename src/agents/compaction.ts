import type { ModelMessage } from "../providers/model-provider.js";

export interface CompactionOptions {
  enabled: boolean;
  ratio: number;
  contextWindow: number;
}

/**
 * Compacts a conversation history to keep it within token limits.
 *
 * It uses an adaptive strategy based on the model's context window.
 * If the estimated context is smaller than (window * ratio), no compaction is done.
 * If compaction is required, it preserves:
 *   - The system instructions and initial task
 *   - Recent messages
 *   - Important tool results like list_files and run_command (with smart truncation to retain error signals)
 * It summarizes large file writes instead of hard truncating them.
 */
export function compactContext(messages: ModelMessage[], options: CompactionOptions): ModelMessage[] {
  if (!options.enabled) {
    return messages;
  }

  const threshold = options.contextWindow * options.ratio;

  // Rough estimate: 1 token ~ 4 chars for JSON-encoded messages
  const estimateTokens = (msgs: ModelMessage[]) => {
    let chars = 0;
    for (const m of msgs) {
      if (typeof m.content === "string") chars += m.content.length;
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          chars += tc.name.length;
          if (tc.argumentsRaw) chars += tc.argumentsRaw.length;
        }
      }
    }
    return chars / 4;
  };

  if (estimateTokens(messages) <= threshold) {
    return messages;
  }

  const compacted = [...messages];
  // Protect the first 2 messages (system prompt, task brief)
  const protectStart = 2;
  // Protect the last 6 messages (approx 3 complete turns)
  const protectLastN = 6;

  for (let i = protectStart; i < compacted.length - protectLastN; i++) {
    const msg = compacted[i];
    
    // Look at assistant tool calls to summarize huge arguments (like write_file content)
    if (msg && msg.role === "assistant" && msg.toolCalls) {
      const compactedCalls = msg.toolCalls.map(tc => {
        if (tc.name === "write_file" && tc.argumentsRaw && tc.argumentsRaw.length > 500) {
          return {
            ...tc,
            argumentsRaw: tc.argumentsRaw.substring(0, 100) + '...[File content omitted to save context]...'
          };
        }
        return tc;
      });
      compacted[i] = { ...msg, toolCalls: compactedCalls };
    }

    if (msg && msg.role === "tool" && typeof msg.content === "string") {
      const toolName = msg.toolName;
      const content = msg.content;
      
      // Smart truncation based on tool type
      if (toolName === "list_files" || toolName === "read_file" || toolName === "search_files") {
        // Keep these relatively large, but truncate if absurdly huge
        if (content.length > 3000) {
          compacted[i] = {
            ...msg,
            content: content.substring(0, 3000) + "\n...[Output truncated by context compaction]...",
          };
        }
      } else if (toolName === "run_command") {
        // Run command might have large test failures. Preserve the start and end (often contains the error summary).
        if (content.length > 2000) {
          const start = content.substring(0, 1000);
          const end = content.substring(content.length - 1000);
          compacted[i] = {
            ...msg,
            content: `${start}\n...[Middle omitted by context compaction]...\n${end}`,
          };
        }
      } else if (toolName === "write_file") {
        // We don't need to see the result of write_file if it's just a success message, 
        // but if it's an error, keep it. Success messages are small anyway.
        if (content.length > 250) {
           compacted[i] = {
            ...msg,
            content: content.substring(0, 250) + "\n...[Output truncated]...",
          };
        }
      } else {
        // Generic fallback
        if (content.length > 1000) {
          compacted[i] = {
            ...msg,
            content: content.substring(0, 1000) + "\n...[Output truncated]...",
          };
        }
      }
    }
  }

  return compacted;
}

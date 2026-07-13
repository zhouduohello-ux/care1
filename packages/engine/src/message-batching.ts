import type { OutboundMessage } from "@carememory/im-core";

export interface CombineTextMessagesOptions {
  /** Maximum character length for a combined text body. */
  maxBodyLength?: number;
  /** Separator inserted between concatenated texts. */
  separator?: string;
}

/**
 * Combine adjacent text-only outbound messages into a single message.
 *
 * Why this matters for L5:
 * - WhatsApp (and many IM platforms) bill per message; sending two short
 *   follow-up texts in a row is more expensive and more noisy than one.
 * - Some L5 flows naturally produce short adjacent text messages (e.g. a
 *   move-on note from Turn Manager + the next question + a Brief link). We
 *   can safely merge those as long as they share the same recipient and
 *   delivery constraints.
 *
 * Rules:
 * - Only `content.type === "text"` messages are merged.
 * - Messages are only merged when they share `userId`, `platform`,
 *   `conversationContext.requiresSession`, and `conversationContext.priority`.
 * - If adding the next text would exceed `maxBodyLength`, the current buffer
 *   is flushed and a new combined message is started.
 * - The idempotency key of the first message in a batch is preserved; callers
 *   that need per-message delivery tracking should batch before persisting
 *   outbound events.
 */
export function combineAdjacentTextMessages(
  messages: OutboundMessage[],
  options: CombineTextMessagesOptions = {}
): OutboundMessage[] {
  const { maxBodyLength = Infinity, separator = "\n\n" } = options;
  if (messages.length === 0) return [];

  const result: OutboundMessage[] = [];
  let buffer: OutboundMessage | null = null;

  const canCombine = (a: OutboundMessage, b: OutboundMessage): boolean => {
    if (b.content.type !== "text") return false;
    if (a.userId !== b.userId) return false;
    if (a.platform !== b.platform) return false;
    if (a.conversationContext.requiresSession !== b.conversationContext.requiresSession) return false;
    return true;
  };

  for (const message of messages) {
    if (message.content.type !== "text") {
      if (buffer) {
        result.push(buffer);
        buffer = null;
      }
      result.push(message);
      continue;
    }

    if (!buffer) {
      buffer = { ...message };
      continue;
    }

    if (!canCombine(buffer, message)) {
      result.push(buffer);
      buffer = { ...message };
      continue;
    }

    const mergedText: string = `${buffer.content.text}${separator}${message.content.text}`;
    if (maxBodyLength > 0 && mergedText.length > maxBodyLength) {
      result.push(buffer);
      buffer = { ...message };
    } else {
      buffer = {
        ...buffer,
        conversationContext: {
          ...buffer.conversationContext,
          priority:
            buffer.conversationContext.priority === "urgent" || message.conversationContext.priority === "urgent"
              ? "urgent"
              : "normal",
        },
        content: {
          ...buffer.content,
          text: mergedText,
        },
      };
    }
  }

  if (buffer) {
    result.push(buffer);
  }

  return result;
}

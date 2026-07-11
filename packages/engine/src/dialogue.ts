import type { OutboundMessage, PlatformCapability } from "@carememory/im-core";
import { DEFAULT_PLATFORM_CAPABILITIES } from "@carememory/im-core";
import type { PlannerOutput } from "./types.js";

export interface RenderOptions {
  capability?: PlatformCapability;
  listActionButtonTitle?: string;
}

export function renderMessage(
  userId: string,
  plannerOutput: PlannerOutput,
  options: RenderOptions = {}
): OutboundMessage {
  const action = plannerOutput.nextAction;
  const capability = options.capability ?? DEFAULT_PLATFORM_CAPABILITIES.whatsapp;

  if (action.type === "safety_response") {
    return {
      userId,
      conversationContext: { requiresSession: true, priority: "urgent" },
      content: {
        type: "text",
        text: action.purpose,
      },
    };
  }

  if (action.type === "end_session") {
    return {
      userId,
      conversationContext: { requiresSession: true, priority: "normal" },
      content: {
        type: "text",
        text: action.purpose,
      },
    };
  }

  if (action.type === "ask" && action.expectedResponseType === "scale") {
    return renderScaleQuestion(userId, action.purpose, capability);
  }

  if (action.type === "ask" && action.expectedResponseType === "single_choice" && action.options) {
    return renderSingleChoiceQuestion(
      userId,
      action.purpose,
      action.topic,
      action.options,
      capability,
      options.listActionButtonTitle
    );
  }

  return {
    userId,
    conversationContext: { requiresSession: true, priority: "normal" },
    content: {
      type: "text",
      text: action.purpose,
    },
  };
}

function renderScaleQuestion(
  userId: string,
  purpose: string,
  capability: PlatformCapability
): OutboundMessage {
  const scaleOptions = ["1", "2", "3", "4", "5"];

  if (capability.maxButtons >= scaleOptions.length) {
    return {
      userId,
      conversationContext: { requiresSession: true, priority: "normal" },
      content: {
        type: "buttons",
        text: purpose,
        buttons: scaleOptions.map((id) => ({
          id,
          title: truncate(id, capability.buttonTitleMaxLength),
        })),
      },
    };
  }

  return {
    userId,
    conversationContext: { requiresSession: true, priority: "normal" },
    content: {
      type: "list",
      text: purpose,
      list: scaleOptions.map((id) => ({
        id,
        title: truncate(id, capability.listTitleMaxLength),
      })),
    },
  };
}

function renderSingleChoiceQuestion(
  userId: string,
  purpose: string,
  topic: string,
  options: string[],
  capability: PlatformCapability,
  listActionButtonTitle = "Choose"
): OutboundMessage {
  const labels = getOptionLabels(topic, options);

  const items = options.map((id, idx) => ({
    id,
    label: labels[idx] ?? id,
  }));

  const anyTitleExceedsButtonLimit = items.some(
    (item) => item.label.length > capability.buttonTitleMaxLength
  );

  if (capability.maxButtons > 0 && items.length <= capability.maxButtons && !anyTitleExceedsButtonLimit) {
    return {
      userId,
      conversationContext: { requiresSession: true, priority: "normal" },
      content: {
        type: "buttons",
        text: purpose,
        buttons: items.map((item) => ({
          id: item.id,
          title: item.label,
        })),
      },
    };
  }

  if (capability.listMaxRows > 0 && items.length <= capability.listMaxRows) {
    return {
      userId,
      conversationContext: { requiresSession: true, priority: "normal" },
      content: {
        type: "list",
        text: purpose,
        list: items.map((item) => ({
          id: item.id,
          title: truncate(item.label, capability.listTitleMaxLength),
        })),
      },
    };
  }

  // Final fallback: plain text with enumerated options.
  const enumeratedOptions = items
    .map((item, idx) => `${idx + 1}. ${item.label} (reply ${item.id})`)
    .join("\n");

  return {
    userId,
    conversationContext: { requiresSession: true, priority: "normal" },
    content: {
      type: "text",
      text: `${purpose}\n\n${enumeratedOptions}`,
    },
  };
}

function getOptionLabels(topic: string, options: string[]): string[] {
  const labels: Record<string, string[]> = {
    nighttime_symptoms: ["None", "Mild", "Disturbed sleep", "Woke me up"],
    reliever_use: ["0 times", "1 time", "2 times", "3+ times"],
    activity_limitation: ["No limitation", "Yes, limited"],
  };
  return labels[topic] ?? options;
}

function truncate(text: string, maxLength: number): string {
  if (maxLength <= 0) return text;
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + "…";
}

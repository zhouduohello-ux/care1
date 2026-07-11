import type { OutboundMessage, PlatformCapability } from "@carememory/im-core";
import { DEFAULT_PLATFORM_CAPABILITIES } from "@carememory/im-core";
import type { PlannerOutput } from "./types.js";
import { styleText, type ConversationStyle } from "./dialogue-styles.js";

export interface CycleContext {
  cycleType?: "TRIAL_7_DAY" | "PLAN_4_WEEK";
  cycleDay?: number;
  briefReady?: boolean;
  briefUrl?: string;
}

export interface RenderOptions {
  capability?: PlatformCapability;
  listActionButtonTitle?: string;
  style?: ConversationStyle;
  cycleContext?: CycleContext;
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
        text: styleText(action.purpose, options.style ?? "v1", "safety"),
      },
    };
  }

  if (action.type === "end_session") {
    const closingText = resolveClosingText(action.purpose, options.cycleContext);
    return {
      userId,
      conversationContext: { requiresSession: true, priority: "normal" },
      content: {
        type: "text",
        text: styleText(closingText, options.style ?? "v1", "closing"),
      },
    };
  }

  if (action.type === "generate_brief") {
    return {
      userId,
      conversationContext: { requiresSession: true, priority: "normal" },
      content: {
        type: "text",
        text: resolveBriefReadyText(action.purpose, options.cycleContext?.briefUrl),
      },
    };
  }

  if (action.type === "ask" && action.expectedResponseType === "scale") {
    return renderScaleQuestion(userId, action.purpose, capability, options.style ?? "v1");
  }

  if (action.type === "ask" && action.expectedResponseType === "single_choice" && action.options) {
    return renderSingleChoiceQuestion(
      userId,
      action.purpose,
      action.topic,
      action.options,
      capability,
      options.style ?? "v1",
      options.listActionButtonTitle
    );
  }

  if (action.type === "ask" && action.expectedResponseType === "multi_select" && action.options) {
    return renderMultiSelectQuestion(
      userId,
      action.purpose,
      action.topic,
      action.options,
      capability,
      options.style ?? "v1"
    );
  }

  return {
    userId,
    conversationContext: { requiresSession: true, priority: "normal" },
    content: {
      type: "text",
      text: styleText(action.purpose, options.style ?? "v1", action.type === "ask" ? "question" : "inform"),
    },
  };
}

function renderScaleQuestion(
  userId: string,
  purpose: string,
  capability: PlatformCapability,
  style: ConversationStyle
): OutboundMessage {
  const styledPurpose = styleText(purpose, style, "question");
  const scaleOptions = ["1", "2", "3", "4", "5"];

  if (capability.maxButtons >= scaleOptions.length) {
    return {
      userId,
      conversationContext: { requiresSession: true, priority: "normal" },
      content: {
        type: "buttons",
        text: styledPurpose,
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
      text: styledPurpose,
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
  style: ConversationStyle,
  listActionButtonTitle = "Choose"
): OutboundMessage {
  const styledPurpose = styleText(purpose, style, "question");
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
        text: styledPurpose,
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
        text: styledPurpose,
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
      text: `${styledPurpose}\n\n${enumeratedOptions}`,
    },
  };
}

function renderMultiSelectQuestion(
  userId: string,
  purpose: string,
  topic: string,
  options: string[],
  capability: PlatformCapability,
  style: ConversationStyle
): OutboundMessage {
  const styledPurpose = styleText(purpose, style, "question");
  const labels = getOptionLabels(topic, options);
  const items = options.map((id, idx) => ({
    id,
    label: labels[idx] ?? id,
  }));

  const footer = "Reply with all that apply.";

  if (capability.listMaxRows > 0 && items.length <= capability.listMaxRows) {
    return {
      userId,
      conversationContext: { requiresSession: true, priority: "normal" },
      content: {
        type: "list",
        text: `${styledPurpose}\n\n${footer}`,
        list: items.map((item) => ({
          id: item.id,
          title: truncate(item.label, capability.listTitleMaxLength),
        })),
      },
    };
  }

  const enumeratedOptions = items
    .map((item, idx) => `${idx + 1}. ${item.label} (reply ${item.id})`)
    .join("\n");

  return {
    userId,
    conversationContext: { requiresSession: true, priority: "normal" },
    content: {
      type: "text",
      text: `${styledPurpose}\n\n${footer}\n\n${enumeratedOptions}`,
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

function resolveClosingText(purpose: string, cycleContext?: CycleContext): string {
  if (!cycleContext) return purpose;

  const { cycleType, cycleDay, briefReady } = cycleContext;

  if (cycleType === "PLAN_4_WEEK" && cycleDay !== undefined && cycleDay >= 28) {
    return "You've reached the end of your 4-week CareMemory plan. Reply CONTINUE to start your next 4-week cycle, or STOP to pause.";
  }

  if (cycleType === "TRIAL_7_DAY" && cycleDay !== undefined && cycleDay >= 7) {
    return briefReady
      ? "You've completed your 7-day trial. Your Disease Card and Brief are ready. Reply CONTINUE to start a 4-week plan, or STOP to pause."
      : "You've completed your 7-day trial. Reply CONTINUE to start a 4-week plan, or STOP to pause.";
  }

  return purpose;
}

function resolveBriefReadyText(purpose: string, briefUrl?: string): string {
  if (briefUrl) {
    return `Your Asthma Visit Brief is ready. You can view it here: ${briefUrl}. Please bring it to your appointment or share it with your care team.`;
  }
  return purpose || "Your visit brief is ready.";
}

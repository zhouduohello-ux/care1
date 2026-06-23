import type { OutboundMessage } from "@carememory/im-core";
import type { PlannerOutput } from "./types.js";

export function renderMessage(userId: string, plannerOutput: PlannerOutput): OutboundMessage {
  const action = plannerOutput.nextAction;

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

  if (action.type === "ask" && action.expectedResponseType === "single_choice" && action.options) {
    const labels = getOptionLabels(action.topic, action.options);
    return {
      userId,
      conversationContext: { requiresSession: true, priority: "normal" },
      content: {
        type: "buttons",
        text: action.purpose,
        buttons: action.options.map((id, idx) => ({
          id,
          title: labels[idx] ?? id,
        })),
      },
    };
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

function getOptionLabels(topic: string, options: string[]): string[] {
  const labels: Record<string, string[]> = {
    nighttime_symptoms: ["None", "Mild", "Disturbed sleep", "Woke me up"],
    reliever_use: ["0 times", "1 time", "2 times", "3+ times"],
    activity_limitation: ["No limitation", "Yes, limited"],
  };
  return labels[topic] ?? options;
}

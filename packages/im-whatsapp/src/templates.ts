export interface WhatsAppTemplate {
  name: string;
  description: string;
  variables: string[];
  sampleText: string;
  maxBodyLength?: number;
}

export const WHATSAPP_TEMPLATES: Record<string, WhatsAppTemplate> = {
  welcome: {
    name: "carememory_welcome",
    description: "Welcome message with privacy policy link for new users.",
    variables: ["nickname"],
    sampleText:
      "Hi {{nickname}}, welcome to CareMemory. We help you keep a light record of your asthma between appointments. This is not a diagnosis tool. Reply AGREE to continue or read our privacy policy: https://carememory.app/privacy",
    maxBodyLength: 1024,
  },
  checkin_reminder: {
    name: "carememory_checkin_reminder",
    description: "Reminder that a check-in is pending.",
    variables: ["first_name"],
    sampleText:
      "Hi {{first_name}}, you have a pending CareMemory check-in. It only takes a minute. If you're having severe breathing problems, call 999 or follow your asthma action plan.",
    maxBodyLength: 1024,
  },
  brief_ready: {
    name: "carememory_brief_ready",
    description: "Notify the patient that a visit brief is ready.",
    variables: ["first_name", "link"],
    sampleText:
      "Hi {{first_name}}, your visit brief is ready: {{link}}. Please share this link with your healthcare team.",
    maxBodyLength: 1024,
  },
  safety_notice: {
    name: "carememory_safety_notice",
    description: "Standard safety notice after a reported concern.",
    variables: [],
    sampleText:
      "If you're having severe breathing problems, call 999 or follow your asthma action plan. Otherwise, contact your GP or call 111 if symptoms persist.",
    maxBodyLength: 1024,
  },
  stop_confirm: {
    name: "carememory_stop_confirm",
    description: "Confirm the user has paused messages and explain data deletion.",
    variables: [],
    sampleText:
      "We've paused your CareMemory reminders. Send START ASTHMA at any time to restart. Reply DELETE MY DATA to remove all your stored information.",
    maxBodyLength: 1024,
  },
  reactivation: {
    name: "carememory_reactivation",
    description: "Re-engage a user who replied outside the 24h session window.",
    variables: ["first_name"],
    sampleText:
      "Hi {{first_name}}, welcome back. Send START ASTHMA to continue recording, or HELP for options.",
    maxBodyLength: 1024,
  },
  plain_text: {
    name: "carememory_plain_text",
    description: "Generic fallback for free-form text outside the 24h window.",
    variables: ["body"],
    sampleText: "{{body}}",
    maxBodyLength: 1024,
  },
};

export function getTemplateNames(): string[] {
  return Object.keys(WHATSAPP_TEMPLATES);
}

export function getTemplate(name: string): WhatsAppTemplate | undefined {
  return WHATSAPP_TEMPLATES[name];
}

/**
 * Pick the most appropriate WhatsApp template for an outbound message.
 * Returns the template key; callers should still fall back to `plain_text`
 * if the chosen template has not yet been approved by Meta.
 */
export function selectTemplate(message: { content: { text: string }; conversationContext?: { priority?: string } }): string {
  const text = message.content.text;
  const priority = message.conversationContext?.priority;

  if (priority === "urgent" || /999|emergency|severe|struggling to breathe|call 999/i.test(text)) {
    return "safety_notice";
  }

  if (/visit brief|brief is ready/i.test(text)) {
    return "brief_ready";
  }

  if (/pending.*check-in|check-in.*pending/i.test(text)) {
    return "checkin_reminder";
  }

  if (/paused|STOP|restart/i.test(text)) {
    return "stop_confirm";
  }

  if (/welcome to CareMemory|AGREE|privacy policy/i.test(text)) {
    return "welcome";
  }

  if (/welcome back|continue recording/i.test(text)) {
    return "reactivation";
  }

  return "plain_text";
}

export function buildTemplateVariables(
  templateKey: string,
  message: { content: { text: string } },
  context: { nickname?: string | null; firstName?: string | null }
): Record<string, string> {
  const template = WHATSAPP_TEMPLATES[templateKey];
  if (!template) return { body: message.content.text.slice(0, 1024) };

  const firstName = context.firstName ?? context.nickname ?? "there";
  const variables: Record<string, string> = {};

  for (const key of template.variables) {
    if (key === "body") {
      variables[key] = message.content.text.slice(0, template.maxBodyLength ?? 1024);
    } else if (key === "nickname" || key === "first_name") {
      variables[key] = firstName.slice(0, 60);
    } else if (key === "link") {
      // Extract the first URL from the message text, if any.
      const match = message.content.text.match(/https?:\/\/[^\s]+/);
      variables[key] = match ? match[0] : "";
    } else {
      variables[key] = "";
    }
  }

  return variables;
}

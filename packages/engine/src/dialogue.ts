import type { OutboundMessage, PlatformCapability } from "@carememory/im-core";
import { DEFAULT_PLATFORM_CAPABILITIES } from "@carememory/im-core";
import type { PlannerOutput } from "./types.js";
import { styleText, type ConversationStyle } from "./dialogue-styles.js";
import {
  getLocale,
  translateOptionLabels,
  formatBriefReadyMessage,
  type DialogueLocale,
} from "./dialogue-locales/index.js";

export interface CycleContext {
  cycleType?: "TRIAL_7_DAY" | "PLAN_4_WEEK";
  cycleDay?: number;
  briefReady?: boolean;
  briefUrl?: string;
}

export interface TemplateContext {
  nickname?: string;
  firstName?: string;
  briefUrl?: string;
}

export interface TemplateResolver {
  resolve(
    message: OutboundMessage,
    context: TemplateContext
  ): { templateKey: string; templateVariables: Record<string, string> };
}

export interface RenderOptions {
  capability?: PlatformCapability;
  listActionButtonTitle?: string;
  style?: ConversationStyle;
  cycleContext?: CycleContext;
  locale?: string;
  /** When true and llmClient is provided, text messages are passed through an LLM polish step. */
  enableLlmPolish?: boolean;
  llmClient?: import("./llm.js").LLMClient;
  onLlmCall?: import("./perception.js").LlmAuditCallback;
  /** When true, L5 should render the message as a platform template if the capability supports it. */
  outOfSession?: boolean;
  templateResolver?: TemplateResolver;
  templateContext?: TemplateContext;
}

export async function renderMessage(
  userId: string,
  plannerOutput: PlannerOutput,
  options: RenderOptions = {}
): Promise<OutboundMessage> {
  const action = plannerOutput.nextAction;
  const capability = options.capability ?? DEFAULT_PLATFORM_CAPABILITIES.whatsapp;
  const locale = getLocale(options.locale);

  if (action.type === "safety_response") {
    // Safety responses bypass LLM polish to guarantee exact wording and fast path.
    return {
      userId,
      conversationContext: { requiresSession: true, priority: "urgent" },
      content: {
        type: "text",
        text: styleText(action.purpose, options.style ?? "v1", "safety", locale),
      },
    };
  }

  if (action.type === "end_session") {
    const closingText = resolveClosingText(action.purpose, locale, options.cycleContext);
    const polished = await polishIfEnabled(
      {
        userId,
        conversationContext: { requiresSession: true, priority: "normal" },
        content: {
          type: "text",
          text: styleText(closingText, options.style ?? "v1", "closing", locale),
        },
      },
      { intent: "closing", locale, llmClient: options.llmClient, onLlmCall: options.onLlmCall, enabled: options.enableLlmPolish }
    );
    return applyTemplateIfNeeded(polished, capability, options, locale);
  }

  if (action.type === "generate_brief") {
    const polished = await polishIfEnabled(
      {
        userId,
        conversationContext: { requiresSession: true, priority: "normal" },
        content: {
          type: "text",
          text: resolveBriefReadyText(action.purpose, locale, options.cycleContext?.briefUrl),
        },
      },
      { intent: "inform", locale, llmClient: options.llmClient, onLlmCall: options.onLlmCall, enabled: options.enableLlmPolish }
    );
    return applyTemplateIfNeeded(polished, capability, options, locale);
  }

  if (action.type === "ask" && action.expectedResponseType === "scale") {
    const rendered = renderScaleQuestion(userId, action.purpose, capability, options.style ?? "v1", locale);
    return applyTemplateIfNeeded(rendered, capability, options, locale);
  }

  if (action.type === "ask" && action.expectedResponseType === "single_choice" && action.options) {
    const rendered = renderSingleChoiceQuestion(
      userId,
      action.purpose,
      action.topic,
      action.options,
      capability,
      options.style ?? "v1",
      locale,
      options.listActionButtonTitle
    );
    return applyTemplateIfNeeded(rendered, capability, options, locale);
  }

  if (action.type === "ask" && action.expectedResponseType === "multi_select" && action.options) {
    const rendered = renderMultiSelectQuestion(
      userId,
      action.purpose,
      action.topic,
      action.options,
      capability,
      options.style ?? "v1",
      locale
    );
    return applyTemplateIfNeeded(rendered, capability, options, locale);
  }

  const fallback = await polishIfEnabled(
    {
      userId,
      conversationContext: { requiresSession: true, priority: "normal" },
      content: {
        type: "text",
        text: styleText(action.purpose, options.style ?? "v1", action.type === "ask" ? "question" : "inform", locale),
      },
    },
    {
      intent: action.type === "ask" ? "question" : "inform",
      locale,
      llmClient: options.llmClient,
      onLlmCall: options.onLlmCall,
      enabled: options.enableLlmPolish,
    }
  );
  return applyTemplateIfNeeded(fallback, capability, options, locale);
}

function renderScaleQuestion(
  userId: string,
  purpose: string,
  capability: PlatformCapability,
  style: ConversationStyle,
  locale: DialogueLocale
): OutboundMessage {
  const styledPurpose = styleText(purpose, style, "question", locale);
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
  locale: DialogueLocale,
  listActionButtonTitle = "Choose"
): OutboundMessage {
  const styledPurpose = styleText(purpose, style, "question", locale);
  const labels = translateOptionLabels(locale, topic, options);

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
  style: ConversationStyle,
  locale: DialogueLocale
): OutboundMessage {
  const styledPurpose = styleText(purpose, style, "question", locale);
  const labels = translateOptionLabels(locale, topic, options);
  const items = options.map((id, idx) => ({
    id,
    label: labels[idx] ?? id,
  }));

  const footer = locale.multiSelectFooter;

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

function truncate(text: string, maxLength: number): string {
  if (maxLength <= 0) return text;
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + "…";
}

function serializeContentToText(message: OutboundMessage): string {
  if (message.content.type === "text" || message.content.type === "template") {
    return message.content.text;
  }

  const items = message.content.buttons ?? message.content.list ?? [];
  const lines = items.map((item, idx) => `${idx + 1}. ${item.title} (reply ${item.id})`);

  if (lines.length === 0) {
    return message.content.text;
  }

  return `${message.content.text}\n\n${lines.join("\n")}`;
}

function applyTemplateIfNeeded(
  message: OutboundMessage,
  capability: PlatformCapability,
  options: RenderOptions,
  locale: DialogueLocale
): OutboundMessage {
  if (!options.outOfSession || !options.templateResolver || !capability.supportsTemplates) {
    return message;
  }
  if (message.content.type === "template") {
    return message;
  }

  const bodyText = truncateBody(serializeContentToText(message), capability.maxBodyLength);
  const textMessage: OutboundMessage = {
    ...message,
    content: { type: "text", text: bodyText },
  };
  const { templateKey, templateVariables } = options.templateResolver.resolve(textMessage, options.templateContext ?? {});

  return {
    ...message,
    conversationContext: { ...message.conversationContext, requiresSession: false },
    content: {
      type: "template",
      text: bodyText,
      templateKey,
      templateVariables,
    },
  };
}

function truncateBody(text: string, maxLength?: number): string {
  if (!maxLength || maxLength <= 0 || text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + "…";
}

function resolveClosingText(purpose: string, locale: DialogueLocale, cycleContext?: CycleContext): string {
  if (!cycleContext) return purpose;

  const { cycleType, cycleDay, briefReady } = cycleContext;

  if (cycleType === "PLAN_4_WEEK" && cycleDay !== undefined && cycleDay >= 28) {
    return locale.closingMessages.plan4WeekComplete;
  }

  if (cycleType === "TRIAL_7_DAY" && cycleDay !== undefined && cycleDay >= 7) {
    return briefReady
      ? locale.closingMessages.trial7DayCompleteWithBrief
      : locale.closingMessages.trial7DayComplete;
  }

  return purpose;
}

function resolveBriefReadyText(purpose: string, locale: DialogueLocale, briefUrl?: string): string {
  if (briefUrl) {
    return formatBriefReadyMessage(locale, briefUrl);
  }
  return purpose || locale.briefReadyTemplate.replace(/\{url\}/g, "");
}

interface PolishIfEnabledOptions {
  intent?: "safety" | "closing" | "question" | "inform";
  locale: DialogueLocale;
  llmClient?: import("./llm.js").LLMClient;
  onLlmCall?: import("./perception.js").LlmAuditCallback;
  enabled?: boolean;
}

async function polishIfEnabled(
  message: OutboundMessage,
  options: PolishIfEnabledOptions
): Promise<OutboundMessage> {
  if (!options.enabled || !options.llmClient || message.content.type !== "text") {
    return message;
  }

  const { polishMessage } = await import("./dialogue-llm-polish.js");
  const polishedText = await polishMessage(message.content.text, {
    llmClient: options.llmClient,
    onLlmCall: options.onLlmCall,
    locale: options.locale,
    intent: options.intent,
  });

  return {
    ...message,
    content: { ...message.content, text: polishedText },
  };
}

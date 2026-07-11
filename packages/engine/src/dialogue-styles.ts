import type { DialogueLocale } from "./dialogue-locales/index.js";

export type ConversationStyle = "v1" | "v2";

/**
 * Lightweight, rule-based style applier for outbound messages.
 *
 * - v1 is the default clinical-neutral tone.
 * - v2 is warmer, more concise, and uses contractions/encouraging phrasing.
 *
 * Safety-critical messages (high-risk safety_response) are only lightly restyled
 * so that the core safety instruction is never obscured.
 */
export function styleText(
  text: string,
  style: ConversationStyle,
  intent: "safety" | "closing" | "question" | "inform" = "inform",
  locale?: DialogueLocale
): string {
  if (style === "v1" || !text) return text;

  if (intent === "safety") {
    return styleSafetyText(text, locale);
  }

  if (intent === "closing") {
    return styleClosingText(text);
  }

  if (intent === "question") {
    return styleQuestionText(text);
  }

  return styleInformText(text);
}

function styleSafetyText(text: string, locale?: DialogueLocale): string {
  const empathy = locale?.safetyEmpathy;
  if (/^If you're having severe/i.test(text)) {
    return `${empathy?.struggling ?? "I'm sorry you're struggling."} ${text}`;
  }
  if (/^You reported a possible reaction/i.test(text)) {
    return `${empathy?.adverseEvent ?? "Thanks for flagging this."} ${text}`;
  }
  return text;
}

function styleClosingText(text: string): string {
  return (
    text
      .replace(/^Thank you for your updates\./i, "Thanks for the update — it really helps build your record.")
      .replace(/^All questions answered\./i, "All done — thanks for checking in.")
      .replace(/^Thank you for checking in\./i, "Thanks for checking in.")
      .replace(/Your Disease Card will be updated shortly\./i, "I'll update your Disease Card now.")
  );
}

function styleQuestionText(text: string): string {
  let styled = text
    .replace(/^Please tell me /i, "Could you let me know ")
    .replace(/^Please let me know /i, "Could you tell me ")
    .replace(/^How often /i, "How often ")
    .replace(/^Track /i, "Could you tell me about ")
    .replace(/^Check whether /i, "Have you noticed whether ");

  // Avoid robotic repeats of the same opening phrase across a session.
  const conversationalPrefixes = [
    "Quick question:",
    "One more thing:",
    "Could you let me know",
    "I'd like to check:",
  ];
  const prefix = conversationalPrefixes[Math.floor(Math.random() * conversationalPrefixes.length)];

  // Only prefix if the sentence is short and direct.
  if (!styled.includes(":") && styled.length < 80 && !/^Could you/i.test(styled)) {
    const lower = styled.charAt(0).toLowerCase() + styled.slice(1);
    styled = `${prefix} ${lower}`;
  }

  return styled;
}

function styleInformText(text: string): string {
  return (
    text
      .replace(/^We couldn't find an active care cycle\./i, "I couldn't find an active care cycle.")
      .replace(/^We've paused your CareMemory reminders\./i, "I've paused your reminders.")
  );
}

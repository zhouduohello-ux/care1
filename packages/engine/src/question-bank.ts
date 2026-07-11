/**
 * Shared question bank for L4 Planner and L5 Dialogue.
 *
 * This file is the single source of truth for check-in question metadata
 * (topic, purpose, response type, options, budget cost). Locale-specific
 * option labels live in `dialogue-locales/` and are kept in sync via tests.
 */

export interface QuestionDefinition {
  topic: string;
  purpose: string;
  expectedResponseType: "single_choice" | "scale" | "multi_select" | "text";
  options?: string[];
  budgetCost: number;
}

export const CHECKIN_QUESTIONS: readonly QuestionDefinition[] = [
  {
    topic: "nighttime_symptoms",
    purpose: "Track nighttime cough or wheeze over the past 2 days.",
    expectedResponseType: "single_choice",
    options: ["night_none", "night_mild", "night_disturbed", "night_woke_up"],
    budgetCost: 1,
  },
  {
    topic: "reliever_use",
    purpose: "Track how often the reliever inhaler was used.",
    expectedResponseType: "single_choice",
    options: ["reliever_0", "reliever_1", "reliever_2", "reliever_3_plus"],
    budgetCost: 1,
  },
  {
    topic: "activity_limitation",
    purpose: "Check whether asthma limited daily activities or exercise.",
    expectedResponseType: "single_choice",
    options: ["activity_no", "activity_yes"],
    budgetCost: 1,
  },
] as const;

export const EXCEPTION_QUESTIONS: readonly QuestionDefinition[] = [
  {
    topic: "exception_clarification",
    purpose:
      "Can you tell me more about what happened? When did it start and how severe was it?",
    expectedResponseType: "text",
    budgetCost: 1,
  },
  {
    topic: "exception_impact",
    purpose: "Did it affect your sleep, work, exercise, or daily activities?",
    expectedResponseType: "text",
    budgetCost: 1,
  },
  {
    topic: "exception_action",
    purpose: "Did you take your reliever inhaler or follow your asthma action plan? Did it help?",
    expectedResponseType: "text",
    budgetCost: 1,
  },
] as const;

export type CheckInTopic = (typeof CHECKIN_QUESTIONS)[number]["topic"];

export function getCheckInQuestion(topic: string): QuestionDefinition | undefined {
  return CHECKIN_QUESTIONS.find((q) => q.topic === topic);
}

export function getExceptionQuestion(index: number): QuestionDefinition | undefined {
  return EXCEPTION_QUESTIONS[index];
}

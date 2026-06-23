import type { PlannerInput, PlannerOutput, Observation } from "./types.js";
import type { LLMClient, LLMMessage } from "./llm.js";
import type { LlmAuditCallback } from "./perception.js";
import { loadDiseaseCorpus, searchCorpus } from "@carememory/rag";

const DISEASE_CORPUS = loadDiseaseCorpus("asthma");

const CHECKIN_QUESTIONS = [
  {
    topic: "nighttime_symptoms",
    purpose: "Track nighttime cough or wheeze over the past 2 days.",
    expectedResponseType: "single_choice" as const,
    options: ["night_none", "night_mild", "night_disturbed", "night_woke_up"],
    optionLabels: ["None", "Mild", "Disturbed sleep", "Woke me up"],
    budgetCost: 1,
  },
  {
    topic: "reliever_use",
    purpose: "Track how often the reliever inhaler was used.",
    expectedResponseType: "single_choice" as const,
    options: ["reliever_0", "reliever_1", "reliever_2", "reliever_3_plus"],
    optionLabels: ["0 times", "1 time", "2 times", "3+ times"],
    budgetCost: 1,
  },
  {
    topic: "activity_limitation",
    purpose: "Check whether asthma limited daily activities or exercise.",
    expectedResponseType: "single_choice" as const,
    options: ["activity_no", "activity_yes"],
    optionLabels: ["No limitation", "Yes, limited"],
    budgetCost: 1,
  },
];

const EXCEPTION_QUESTIONS = [
  {
    topic: "exception_clarification",
    purpose: "Can you tell me more about what happened? When did it start and how severe was it?",
    expectedResponseType: "text" as const,
    budgetCost: 1,
  },
  {
    topic: "exception_impact",
    purpose: "Did it affect your sleep, work, exercise, or daily activities?",
    expectedResponseType: "text" as const,
    budgetCost: 1,
  },
  {
    topic: "exception_action",
    purpose: "Did you take your reliever inhaler or follow your asthma action plan? Did it help?",
    expectedResponseType: "text" as const,
    budgetCost: 1,
  },
];

export async function plan(input: PlannerInput, llmClient?: LLMClient, onLlmCall?: LlmAuditCallback, allowLlm = true): Promise<PlannerOutput> {
  const { conversationContext, patientContext } = input;

  // Exception mode: clarify up to 3 questions, then close with safety guidance
  if (conversationContext.inExceptionMode) {
    const exceptionIndex = conversationContext.exceptionQuestionsAsked ?? 0;
    if (exceptionIndex >= EXCEPTION_QUESTIONS.length || conversationContext.budgetRemaining <= 0) {
      return endSession(
        "Thanks for sharing. If these symptoms persist or worsen, contact your GP or call 111. Call 999 if you're struggling to breathe."
      );
    }
    const q = EXCEPTION_QUESTIONS[exceptionIndex];
    return {
      reasoning: "Entered exception mode due to anomaly or safety flag. Asking clarifying question.",
      sessionObjective: "Clarify the reported concern and assess whether urgent care is needed.",
      nextAction: {
        type: "ask",
        topic: q.topic,
        purpose: q.purpose,
        expectedResponseType: q.expectedResponseType,
        budgetCost: q.budgetCost,
      },
      safetyFlag: "medium",
      updatePatientState: {},
    };
  }

  // Safety response takes priority
  if (patientContext.recentObservations.some((o) => o.category === "adverse_event")) {
    return safetyResponse("possible_adverse_event", "You reported a possible reaction. Please contact your GP or pharmacist, or call 111 if it feels serious.");
  }

  // End session if budget exhausted or objective likely complete
  if (conversationContext.budgetRemaining <= 0) {
    return endSession("All questions answered. Thank you for checking in.");
  }

  const askedTopics = new Set(patientContext.recentObservations.map((o) => o.concept));
  const nextQuestion = CHECKIN_QUESTIONS.find((q) => !askedTopics.has(q.topic));

  if (!nextQuestion) {
    return endSession("Thank you for your updates. Your Disease Card will be updated shortly.");
  }

  if (llmClient && allowLlm) {
    try {
      return await planWithLlm(input, askedTopics, nextQuestion, llmClient, onLlmCall);
    } catch {
      // Fall through to rule-based planner
    }
  }

  const retrieved = searchCorpus(
    DISEASE_CORPUS,
    `${patientContext.disease} ${conversationContext.currentIntent} ${nextQuestion.topic}`,
    { topK: 2 }
  );
  const knowledgeSnippet = retrieved
    .map((s) => `${s.title}: ${s.content.replace(/\n/g, " ").slice(0, 180)}`)
    .join(" | ");

  return {
    reasoning: `Cycle day ${patientContext.cycleDay}. Retrieved: ${knowledgeSnippet}. Asking ${nextQuestion.topic} to fill control assessment.`,
    sessionObjective: "Track asthma control dimensions over the last 48 hours.",
    nextAction: {
      type: "ask",
      topic: nextQuestion.topic,
      purpose: nextQuestion.purpose,
      expectedResponseType: nextQuestion.expectedResponseType,
      options: nextQuestion.options,
      budgetCost: nextQuestion.budgetCost,
    },
    safetyFlag: "none",
    updatePatientState: {},
  };
}

async function planWithLlm(
  input: PlannerInput,
  askedTopics: Set<string>,
  fallbackQuestion: (typeof CHECKIN_QUESTIONS)[number],
  llmClient: LLMClient,
  onLlmCall?: LlmAuditCallback
): Promise<PlannerOutput> {
  const style = input.conversationContext.conversationStyle ?? "v1";
  const styleInstruction =
    style === "v2"
      ? "Use a warm, concise, and encouraging tone. Keep questions short and action-oriented."
      : "Keep purpose concise and patient-friendly.";

  const systemPrompt = `You are the planning layer of CareMemory, a UK asthma follow-up assistant.
You must return ONLY valid JSON matching this schema:
{
  "reasoning": string,
  "sessionObjective": string,
  "nextAction": {
    "type": "ask" | "end_session",
    "topic": string,
    "purpose": string,
    "expectedResponseType": "single_choice" | "text",
    "options": string[] | undefined,
    "budgetCost": number
  },
  "safetyFlag": "none" | "low" | "medium" | "high",
  "updatePatientState": {}
}
Rules:
- Choose the next uncovered asthma control topic from: nighttime_symptoms, reliever_use, activity_limitation.
- If all topics are covered or budget is exhausted, use type "end_session".
- Do not diagnose or give treatment advice.
- ${styleInstruction}`;

  const userPrompt = `Disease: ${input.patientContext.disease}
Cycle day: ${input.patientContext.cycleDay}
Budget remaining: ${input.conversationContext.budgetRemaining}
Recent observations: ${JSON.stringify(input.patientContext.recentObservations)}
Already asked topics: ${JSON.stringify([...askedTopics])}
Current intent: ${input.conversationContext.currentIntent}`;

  const messages: LLMMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
  const content = await llmClient.complete(messages, { responseFormat: "json", temperature: 0.2 });

  if (onLlmCall) {
    await onLlmCall("planner", messages, content);
  }

  const parsed = JSON.parse(content) as PlannerOutput;

  // Validate that the LLM chose a known uncovered topic
  if (parsed.nextAction.type === "ask") {
    const question = CHECKIN_QUESTIONS.find((q) => q.topic === parsed.nextAction.topic);
    if (!question || askedTopics.has(parsed.nextAction.topic)) {
      throw new Error("LLM chose invalid or already asked topic");
    }
    return {
      ...parsed,
      nextAction: {
        ...parsed.nextAction,
        expectedResponseType: question.expectedResponseType,
        options: question.options,
        budgetCost: parsed.nextAction.budgetCost ?? question.budgetCost,
      },
    };
  }

  return parsed;
}

function safetyResponse(topic: string, message: string): PlannerOutput {
  return {
    reasoning: "High-priority safety response triggered.",
    sessionObjective: "Ensure user safety and direct to appropriate care.",
    nextAction: {
      type: "safety_response",
      topic,
      purpose: message,
      budgetCost: 0,
    },
    safetyFlag: "high",
    updatePatientState: { updateNarrative: true },
  };
}

function endSession(message: string): PlannerOutput {
  return {
    reasoning: "Budget exhausted or all topics covered.",
    sessionObjective: "Close check-in and confirm completion.",
    nextAction: {
      type: "end_session",
      topic: "closing",
      purpose: message,
      budgetCost: 0,
    },
    safetyFlag: "none",
    updatePatientState: { updateNarrative: true },
  };
}

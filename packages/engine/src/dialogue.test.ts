import { describe, it, expect } from "vitest";
import { renderMessage } from "./dialogue.js";
import type { PlannerOutput } from "./types.js";
import { DEFAULT_PLATFORM_CAPABILITIES, type PlatformCapability } from "@carememory/im-core";

function makePlannerOutput(partial: Partial<PlannerOutput["nextAction"]> & { type: PlannerOutput["nextAction"]["type"] }): PlannerOutput {
  return {
    reasoning: "test",
    sessionObjective: "test",
    nextAction: {
      type: partial.type,
      topic: partial.topic ?? "test",
      purpose: partial.purpose ?? "Test question?",
      expectedResponseType: partial.expectedResponseType,
      options: partial.options,
      budgetCost: partial.budgetCost ?? 1,
    },
    safetyFlag: "none",
    updatePatientState: {},
  };
}

const whatsappCapability: PlatformCapability = DEFAULT_PLATFORM_CAPABILITIES.whatsapp;
const lineCapability: PlatformCapability = DEFAULT_PLATFORM_CAPABILITIES.line;
const smsCapability: PlatformCapability = DEFAULT_PLATFORM_CAPABILITIES.sms;
const testCapability: PlatformCapability = DEFAULT_PLATFORM_CAPABILITIES.test;

const customCapability = (overrides: Partial<PlatformCapability>): PlatformCapability => ({
  ...whatsappCapability,
  ...overrides,
});

describe("renderMessage", () => {
  describe("safety_response", () => {
    it("renders as urgent text", () => {
      const output = makePlannerOutput({ type: "safety_response", purpose: "Call 999." });
      const message = renderMessage("user_1", output);

      expect(message.content.type).toBe("text");
      expect(message.content.text).toBe("Call 999.");
      expect(message.conversationContext.priority).toBe("urgent");
      expect(message.conversationContext.requiresSession).toBe(true);
    });
  });

  describe("end_session", () => {
    it("renders as normal text", () => {
      const output = makePlannerOutput({ type: "end_session", purpose: "Thank you." });
      const message = renderMessage("user_1", output);

      expect(message.content.type).toBe("text");
      expect(message.content.text).toBe("Thank you.");
      expect(message.conversationContext.priority).toBe("normal");
    });
  });

  describe("ask — single_choice", () => {
    it("renders 2 options as buttons", () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "activity_limitation",
        expectedResponseType: "single_choice",
        options: ["activity_no", "activity_yes"],
      });
      const message = renderMessage("user_1", output, { capability: whatsappCapability });

      expect(message.content.type).toBe("buttons");
      expect(message.content.buttons).toHaveLength(2);
      expect(message.content.buttons?.[0]).toEqual({ id: "activity_no", title: "No limitation" });
      expect(message.content.buttons?.[1]).toEqual({ id: "activity_yes", title: "Yes, limited" });
    });

    it("renders 4 options as list under WhatsApp (max 3 buttons)", () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "nighttime_symptoms",
        expectedResponseType: "single_choice",
        options: ["night_none", "night_mild", "night_disturbed", "night_woke_up"],
      });
      const message = renderMessage("user_1", output, { capability: whatsappCapability });

      expect(message.content.type).toBe("list");
      expect(message.content.list).toHaveLength(4);
      expect(message.content.list?.[0]).toEqual({ id: "night_none", title: "None" });
      expect(message.content.list?.[3]).toEqual({ id: "night_woke_up", title: "Woke me up" });
    });

    it("renders 4 options as buttons under LINE (max 4 buttons)", () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "nighttime_symptoms",
        expectedResponseType: "single_choice",
        options: ["night_none", "night_mild", "night_disturbed", "night_woke_up"],
      });
      const message = renderMessage("user_1", output, { capability: lineCapability });

      expect(message.content.type).toBe("buttons");
      expect(message.content.buttons).toHaveLength(4);
    });

    it("falls back to list when a button title exceeds the platform limit", () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "unknown_topic",
        expectedResponseType: "single_choice",
        options: ["this_is_long", "also_too_long"],
      });
      const capability = customCapability({ maxButtons: 3, buttonTitleMaxLength: 5 });
      const message = renderMessage("user_1", output, { capability });

      expect(message.content.type).toBe("list");
      expect(message.content.list).toHaveLength(2);
    });

    it("falls back to enumerated text when buttons and list are unavailable", () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "nighttime_symptoms",
        expectedResponseType: "single_choice",
        options: ["night_none", "night_mild", "night_disturbed", "night_woke_up"],
      });
      const message = renderMessage("user_1", output, { capability: smsCapability });

      expect(message.content.type).toBe("text");
      expect(message.content.text).toContain("None (reply night_none)");
      expect(message.content.text).toContain("Woke me up (reply night_woke_up)");
    });

    it("falls back to options IDs for unknown topics", () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "unknown_topic",
        expectedResponseType: "single_choice",
        options: ["opt_a", "opt_b"],
      });
      const message = renderMessage("user_1", output, { capability: whatsappCapability });

      expect(message.content.type).toBe("buttons");
      expect(message.content.buttons?.[0]).toEqual({ id: "opt_a", title: "opt_a" });
      expect(message.content.buttons?.[1]).toEqual({ id: "opt_b", title: "opt_b" });
    });

    it("falls back to list when any button title would exceed the platform limit", () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "unknown_topic",
        expectedResponseType: "single_choice",
        options: ["short", "this_option_is_too_long_for_a_button"],
      });
      const capability = customCapability({ maxButtons: 3, buttonTitleMaxLength: 10 });
      const message = renderMessage("user_1", output, { capability });

      expect(message.content.type).toBe("list");
      expect(message.content.list).toHaveLength(2);
      expect(message.content.list?.[1].title.length).toBeLessThanOrEqual(capability.listTitleMaxLength);
    });
  });

  describe("ask — scale", () => {
    it("renders scale as 5 buttons when supported", () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "severity",
        expectedResponseType: "scale",
      });
      const capability = customCapability({ maxButtons: 5 });
      const message = renderMessage("user_1", output, { capability });

      expect(message.content.type).toBe("buttons");
      expect(message.content.buttons).toHaveLength(5);
      expect(message.content.buttons?.[0]).toEqual({ id: "1", title: "1" });
    });

    it("renders scale as list when buttons are limited", () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "severity",
        expectedResponseType: "scale",
      });
      const capability = customCapability({ maxButtons: 3 });
      const message = renderMessage("user_1", output, { capability });

      expect(message.content.type).toBe("list");
      expect(message.content.list).toHaveLength(5);
    });
  });

  describe("ask — text", () => {
    it("renders text question", () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "exception_clarification",
        expectedResponseType: "text",
      });
      const message = renderMessage("user_1", output);

      expect(message.content.type).toBe("text");
      expect(message.content.text).toBe("Test question?");
    });
  });

  describe("inform / remind / generate_brief", () => {
    it.each([
      ["inform"],
      ["remind"],
      ["generate_brief"],
    ] as const)("renders %s as text fallback", (type) => {
      const output = makePlannerOutput({ type, purpose: "Heads up." });
      const message = renderMessage("user_1", output);

      expect(message.content.type).toBe("text");
      expect(message.content.text).toBe("Heads up.");
    });
  });

  describe("default capability", () => {
    it("uses WhatsApp capability when none is provided", () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "nighttime_symptoms",
        expectedResponseType: "single_choice",
        options: ["night_none", "night_mild", "night_disturbed", "night_woke_up"],
      });
      const message = renderMessage("user_1", output);

      expect(message.content.type).toBe("list");
    });
  });

  describe("truncation", () => {
    it("truncates list titles that exceed the limit", () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "unknown_topic",
        expectedResponseType: "single_choice",
        options: ["this_is_a_very_long_option_id"],
      });
      const capability = customCapability({ maxButtons: 0, listMaxRows: 10, listTitleMaxLength: 10 });
      const message = renderMessage("user_1", output, { capability });

      expect(message.content.type).toBe("list");
      expect(message.content.list?.[0].title.length).toBeLessThanOrEqual(10);
      expect(message.content.list?.[0].title.endsWith("…")).toBe(true);
    });
  });

  describe("conversation style", () => {
    it("v1 leaves text unchanged", () => {
      const output = makePlannerOutput({
        type: "end_session",
        purpose: "Thank you for your updates. Your Disease Card will be updated shortly.",
      });
      const message = renderMessage("user_1", output, { style: "v1" });

      expect(message.content.text).toBe("Thank you for your updates. Your Disease Card will be updated shortly.");
    });

    it("v2 restyles closing messages", () => {
      const output = makePlannerOutput({
        type: "end_session",
        purpose: "Thank you for your updates. Your Disease Card will be updated shortly.",
      });
      const message = renderMessage("user_1", output, { style: "v2" });

      expect(message.content.text).toContain("Thanks for the update");
      expect(message.content.text).toContain("I'll update your Disease Card now");
    });

    it("v2 restyles question prompts", () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "exception_clarification",
        expectedResponseType: "text",
        purpose: "Please tell me more about what happened.",
      });
      const message = renderMessage("user_1", output, { style: "v2" });

      expect(message.content.text).not.toContain("Please tell me");
      expect(message.content.text.toLowerCase()).toContain("could you");
    });

    it("v2 adds empathy to safety responses without removing safety instruction", () => {
      const output = makePlannerOutput({
        type: "safety_response",
        purpose: "If you're having severe breathing problems, call 999 or follow your asthma action plan.",
      });
      const message = renderMessage("user_1", output, { style: "v2" });

      expect(message.content.text).toContain("I'm sorry you're struggling");
      expect(message.content.text).toContain("call 999");
    });

    it("preserves safety instruction length dominance in v2 safety responses", () => {
      const output = makePlannerOutput({
        type: "safety_response",
        purpose: "You reported a possible reaction. Please contact your GP or pharmacist, or call 111 if it feels serious.",
      });
      const message = renderMessage("user_1", output, { style: "v2" });

      expect(message.content.text).toContain("Thanks for flagging this");
      expect(message.content.text).toContain("contact your GP");
    });
  });

  describe("cycle context closing messages", () => {
    it("uses default purpose when no cycle context is provided", () => {
      const output = makePlannerOutput({ type: "end_session", purpose: "Thanks for checking in." });
      const message = renderMessage("user_1", output);

      expect(message.content.text).toBe("Thanks for checking in.");
    });

    it("generates 4-week plan completion message", () => {
      const output = makePlannerOutput({ type: "end_session", purpose: "Thanks for checking in." });
      const message = renderMessage("user_1", output, {
        cycleContext: { cycleType: "PLAN_4_WEEK", cycleDay: 28, briefReady: true },
      });

      expect(message.content.text).toContain("end of your 4-week CareMemory plan");
      expect(message.content.text).toContain("CONTINUE");
    });

    it("generates 7-day trial completion message with Brief mention", () => {
      const output = makePlannerOutput({ type: "end_session", purpose: "Thanks for checking in." });
      const message = renderMessage("user_1", output, {
        cycleContext: { cycleType: "TRIAL_7_DAY", cycleDay: 7, briefReady: true },
      });

      expect(message.content.text).toContain("completed your 7-day trial");
      expect(message.content.text).toContain("Disease Card and Brief are ready");
    });

    it("uses default purpose before cycle end threshold", () => {
      const output = makePlannerOutput({ type: "end_session", purpose: "All questions answered." });
      const message = renderMessage("user_1", output, {
        cycleContext: { cycleType: "TRIAL_7_DAY", cycleDay: 3, briefReady: true },
      });

      expect(message.content.text).toContain("All questions answered.");
    });
  });
});

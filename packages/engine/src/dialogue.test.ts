import { describe, it, expect, vi } from "vitest";
import { renderMessage } from "./dialogue.js";
import type { PlannerOutput } from "./types.js";
import { DEFAULT_PLATFORM_CAPABILITIES, type PlatformCapability, type OutboundMessage } from "@carememory/im-core";
import type { LLMClient } from "./llm.js";

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

function mockLlm(polishedText: string): LLMClient {
  return {
    modelName: "mock-polish",
    complete: vi.fn().mockResolvedValue({
      content: polishedText,
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    }),
  };
}

describe("renderMessage", async () => {
  describe("safety_response", async () => {
    it("renders as urgent text", async () => {
      const output = makePlannerOutput({ type: "safety_response", purpose: "Call 999." });
      const message = await renderMessage("user_1", output);

      expect(message.content.type).toBe("text");
      expect(message.content.text).toBe("Call 999.");
      expect(message.conversationContext.priority).toBe("urgent");
      expect(message.conversationContext.requiresSession).toBe(true);
    });
  });

  describe("end_session", async () => {
    it("renders as normal text", async () => {
      const output = makePlannerOutput({ type: "end_session", purpose: "Thank you." });
      const message = await renderMessage("user_1", output);

      expect(message.content.type).toBe("text");
      expect(message.content.text).toBe("Thank you.");
      expect(message.conversationContext.priority).toBe("normal");
    });
  });

  describe("ask — single_choice", async () => {
    it("renders 2 options as buttons", async () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "activity_limitation",
        expectedResponseType: "single_choice",
        options: ["activity_no", "activity_yes"],
      });
      const message = await renderMessage("user_1", output, { capability: whatsappCapability });

      expect(message.content.type).toBe("buttons");
      expect(message.content.buttons).toHaveLength(2);
      expect(message.content.buttons?.[0]).toEqual({ id: "activity_no", title: "No limitation" });
      expect(message.content.buttons?.[1]).toEqual({ id: "activity_yes", title: "Yes, limited" });
    });

    it("renders 4 options as list under WhatsApp (max 3 buttons)", async () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "nighttime_symptoms",
        expectedResponseType: "single_choice",
        options: ["night_none", "night_mild", "night_disturbed", "night_woke_up"],
      });
      const message = await renderMessage("user_1", output, { capability: whatsappCapability });

      expect(message.content.type).toBe("list");
      expect(message.content.list).toHaveLength(4);
      expect(message.content.list?.[0]).toEqual({ id: "night_none", title: "None" });
      expect(message.content.list?.[3]).toEqual({ id: "night_woke_up", title: "Woke me up" });
    });

    it("renders 4 options as buttons under LINE (max 4 buttons)", async () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "nighttime_symptoms",
        expectedResponseType: "single_choice",
        options: ["night_none", "night_mild", "night_disturbed", "night_woke_up"],
      });
      const message = await renderMessage("user_1", output, { capability: lineCapability });

      expect(message.content.type).toBe("buttons");
      expect(message.content.buttons).toHaveLength(4);
    });

    it("falls back to list when a button title exceeds the platform limit", async () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "unknown_topic",
        expectedResponseType: "single_choice",
        options: ["this_is_long", "also_too_long"],
      });
      const capability = customCapability({ maxButtons: 3, buttonTitleMaxLength: 5 });
      const message = await renderMessage("user_1", output, { capability });

      expect(message.content.type).toBe("list");
      expect(message.content.list).toHaveLength(2);
    });

    it("falls back to enumerated text when buttons and list are unavailable", async () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "nighttime_symptoms",
        expectedResponseType: "single_choice",
        options: ["night_none", "night_mild", "night_disturbed", "night_woke_up"],
      });
      const message = await renderMessage("user_1", output, { capability: smsCapability });

      expect(message.content.type).toBe("text");
      expect(message.content.text).toContain("None (reply night_none)");
      expect(message.content.text).toContain("Woke me up (reply night_woke_up)");
    });

    it("falls back to options IDs for unknown topics", async () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "unknown_topic",
        expectedResponseType: "single_choice",
        options: ["opt_a", "opt_b"],
      });
      const message = await renderMessage("user_1", output, { capability: whatsappCapability });

      expect(message.content.type).toBe("buttons");
      expect(message.content.buttons?.[0]).toEqual({ id: "opt_a", title: "opt_a" });
      expect(message.content.buttons?.[1]).toEqual({ id: "opt_b", title: "opt_b" });
    });

    it("falls back to list when any button title would exceed the platform limit", async () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "unknown_topic",
        expectedResponseType: "single_choice",
        options: ["short", "this_option_is_too_long_for_a_button"],
      });
      const capability = customCapability({ maxButtons: 3, buttonTitleMaxLength: 10 });
      const message = await renderMessage("user_1", output, { capability });

      expect(message.content.type).toBe("list");
      expect(message.content.list).toHaveLength(2);
      expect(message.content.list?.[1].title.length).toBeLessThanOrEqual(capability.listTitleMaxLength);
    });
  });

  describe("ask — scale", async () => {
    it("renders scale as 5 buttons when supported", async () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "severity",
        expectedResponseType: "scale",
      });
      const capability = customCapability({ maxButtons: 5 });
      const message = await renderMessage("user_1", output, { capability });

      expect(message.content.type).toBe("buttons");
      expect(message.content.buttons).toHaveLength(5);
      expect(message.content.buttons?.[0]).toEqual({ id: "1", title: "1" });
    });

    it("renders scale as list when buttons are limited", async () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "severity",
        expectedResponseType: "scale",
      });
      const capability = customCapability({ maxButtons: 3 });
      const message = await renderMessage("user_1", output, { capability });

      expect(message.content.type).toBe("list");
      expect(message.content.list).toHaveLength(5);
    });
  });

  describe("ask — multi_select", async () => {
    it("renders multi_select as list when supported", async () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "unknown_topic",
        expectedResponseType: "multi_select",
        options: ["pollen", "dust", "exercise", "cold_air"],
      });
      const message = await renderMessage("user_1", output, { capability: whatsappCapability });

      expect(message.content.type).toBe("list");
      expect(message.content.list).toHaveLength(4);
      expect(message.content.text).toContain("Reply with all that apply");
    });

    it("renders multi_select as enumerated text when list is unavailable", async () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "unknown_topic",
        expectedResponseType: "multi_select",
        options: ["pollen", "dust", "exercise", "cold_air"],
      });
      const message = await renderMessage("user_1", output, { capability: smsCapability });

      expect(message.content.type).toBe("text");
      expect(message.content.text).toContain("Reply with all that apply");
      expect(message.content.text).toContain("pollen");
      expect(message.content.text).toContain("cold_air");
    });

    it("uses known labels for multi_select topics", async () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "activity_limitation",
        expectedResponseType: "multi_select",
        options: ["activity_no", "activity_yes"],
      });
      const message = await renderMessage("user_1", output, { capability: whatsappCapability });

      expect(message.content.type).toBe("list");
      expect(message.content.list?.[0].title).toBe("No limitation");
      expect(message.content.list?.[1].title).toBe("Yes, limited");
    });
  });

  describe("ask — text", async () => {
    it("renders text question", async () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "exception_clarification",
        expectedResponseType: "text",
      });
      const message = await renderMessage("user_1", output);

      expect(message.content.type).toBe("text");
      expect(message.content.text).toBe("Test question?");
    });
  });

  describe("inform / remind / generate_brief", async () => {
    it.each([
      ["inform"],
      ["remind"],
      ["generate_brief"],
    ] as const)("renders %s as text fallback", async (type) => {
      const output = makePlannerOutput({ type, purpose: "Heads up." });
      const message = await renderMessage("user_1", output);

      expect(message.content.type).toBe("text");
      expect(message.content.text).toBe("Heads up.");
    });
  });

  describe("default capability", async () => {
    it("uses WhatsApp capability when none is provided", async () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "nighttime_symptoms",
        expectedResponseType: "single_choice",
        options: ["night_none", "night_mild", "night_disturbed", "night_woke_up"],
      });
      const message = await renderMessage("user_1", output);

      expect(message.content.type).toBe("list");
    });
  });

  describe("truncation", async () => {
    it("truncates list titles that exceed the limit", async () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "unknown_topic",
        expectedResponseType: "single_choice",
        options: ["this_is_a_very_long_option_id"],
      });
      const capability = customCapability({ maxButtons: 0, listMaxRows: 10, listTitleMaxLength: 10 });
      const message = await renderMessage("user_1", output, { capability });

      expect(message.content.type).toBe("list");
      expect(message.content.list?.[0].title.length).toBeLessThanOrEqual(10);
      expect(message.content.list?.[0].title.endsWith("…")).toBe(true);
    });

    it("truncates template body to capability maxBodyLength", async () => {
      const longPurpose = "a".repeat(2000);
      const resolver = {
        resolve: vi.fn((message: OutboundMessage) => ({
          templateKey: "plain_text",
          templateVariables: { body: message.content.text },
        })),
      };
      const output = makePlannerOutput({ type: "end_session", purpose: longPurpose });
      const message = await renderMessage("user_1", output, {
        capability: customCapability({ maxBodyLength: 100, supportsTemplates: true }),
        outOfSession: true,
        templateResolver: resolver,
      });

      expect(message.content.type).toBe("template");
      expect(message.content.text.length).toBeLessThanOrEqual(100);
      expect(message.content.templateVariables?.body.length).toBeLessThanOrEqual(100);
    });
  });

  describe("conversation style", async () => {
    it("v1 leaves text unchanged", async () => {
      const output = makePlannerOutput({
        type: "end_session",
        purpose: "Thank you for your updates. Your Disease Card will be updated shortly.",
      });
      const message = await renderMessage("user_1", output, { style: "v1" });

      expect(message.content.text).toBe("Thank you for your updates. Your Disease Card will be updated shortly.");
    });

    it("v2 restyles closing messages", async () => {
      const output = makePlannerOutput({
        type: "end_session",
        purpose: "Thank you for your updates. Your Disease Card will be updated shortly.",
      });
      const message = await renderMessage("user_1", output, { style: "v2" });

      expect(message.content.text).toContain("Thanks for the update");
      expect(message.content.text).toContain("I'll update your Disease Card now");
    });

    it("v2 restyles question prompts", async () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "exception_clarification",
        expectedResponseType: "text",
        purpose: "Please tell me more about what happened.",
      });
      const message = await renderMessage("user_1", output, { style: "v2" });

      expect(message.content.text).not.toContain("Please tell me");
      expect(message.content.text.toLowerCase()).toContain("could you");
    });

    it("v2 adds empathy to safety responses without removing safety instruction", async () => {
      const output = makePlannerOutput({
        type: "safety_response",
        purpose: "If you're having severe breathing problems, call 999 or follow your asthma action plan.",
      });
      const message = await renderMessage("user_1", output, { style: "v2" });

      expect(message.content.text).toContain("I'm sorry you're struggling");
      expect(message.content.text).toContain("call 999");
    });

    it("preserves safety instruction length dominance in v2 safety responses", async () => {
      const output = makePlannerOutput({
        type: "safety_response",
        purpose: "You reported a possible reaction. Please contact your GP or pharmacist, or call 111 if it feels serious.",
      });
      const message = await renderMessage("user_1", output, { style: "v2" });

      expect(message.content.text).toContain("Thanks for flagging this");
      expect(message.content.text).toContain("contact your GP");
    });
  });

  describe("generate_brief", async () => {
    it("renders brief-ready message with URL when briefUrl is provided", async () => {
      const output = makePlannerOutput({
        type: "generate_brief",
        topic: "brief_ready",
        purpose: "Your visit brief is ready.",
      });
      const message = await renderMessage("user_1", output, {
        cycleContext: { briefUrl: "https://carememory.app/b/123?t=abc" },
      });

      expect(message.content.type).toBe("text");
      expect(message.content.text).toContain("https://carememory.app/b/123?t=abc");
      expect(message.content.text).toContain("Asthma Visit Brief");
    });

    it("falls back to purpose when briefUrl is missing", async () => {
      const output = makePlannerOutput({
        type: "generate_brief",
        topic: "brief_ready",
        purpose: "Your visit brief is ready.",
      });
      const message = await renderMessage("user_1", output);

      expect(message.content.text).toBe("Your visit brief is ready.");
    });
  });

  describe("cycle context closing messages", async () => {
    it("uses default purpose when no cycle context is provided", async () => {
      const output = makePlannerOutput({ type: "end_session", purpose: "Thanks for checking in." });
      const message = await renderMessage("user_1", output);

      expect(message.content.text).toBe("Thanks for checking in.");
    });

    it("generates 4-week plan completion message", async () => {
      const output = makePlannerOutput({ type: "end_session", purpose: "Thanks for checking in." });
      const message = await renderMessage("user_1", output, {
        cycleContext: { cycleType: "PLAN_4_WEEK", cycleDay: 28, briefReady: true },
      });

      expect(message.content.text).toContain("end of your 4-week CareMemory plan");
      expect(message.content.text).toContain("CONTINUE");
    });

    it("generates 7-day trial completion message with Brief mention", async () => {
      const output = makePlannerOutput({ type: "end_session", purpose: "Thanks for checking in." });
      const message = await renderMessage("user_1", output, {
        cycleContext: { cycleType: "TRIAL_7_DAY", cycleDay: 7, briefReady: true },
      });

      expect(message.content.text).toContain("completed your 7-day trial");
      expect(message.content.text).toContain("Disease Card and Brief are ready");
    });

    it("uses default purpose before cycle end threshold", async () => {
      const output = makePlannerOutput({ type: "end_session", purpose: "All questions answered." });
      const message = await renderMessage("user_1", output, {
        cycleContext: { cycleType: "TRIAL_7_DAY", cycleDay: 3, briefReady: true },
      });

      expect(message.content.text).toContain("All questions answered.");
    });
  });

  describe("locale support", async () => {
    it("uses Welsh (cy-GB) labels when locale is set", async () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "nighttime_symptoms",
        expectedResponseType: "single_choice",
        options: ["night_none", "night_mild", "night_disturbed", "night_woke_up"],
      });
      const message = await renderMessage("user_1", output, { capability: whatsappCapability, locale: "cy-GB" });

      expect(message.content.type).toBe("list");
      expect(message.content.list?.[0].title).toBe("Dim");
      expect(message.content.list?.[3].title).toBe("Deffroais i");
    });

    it("falls back to en-GB for unknown locale", async () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "nighttime_symptoms",
        expectedResponseType: "single_choice",
        options: ["night_none", "night_mild", "night_disturbed", "night_woke_up"],
      });
      const message = await renderMessage("user_1", output, { capability: whatsappCapability, locale: "xx-XX" });

      expect(message.content.list?.[0].title).toBe("None");
    });

    it("uses Welsh multi-select footer", async () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "unknown_topic",
        expectedResponseType: "multi_select",
        options: ["a", "b"],
      });
      const message = await renderMessage("user_1", output, { capability: whatsappCapability, locale: "cy-GB" });

      expect(message.content.text).toContain("Atebwch gyda'r hyn sy'n berthnasol.");
    });

    it("uses Welsh brief-ready template", async () => {
      const output = makePlannerOutput({
        type: "generate_brief",
        topic: "brief_ready",
        purpose: "Your visit brief is ready.",
      });
      const message = await renderMessage("user_1", output, {
        locale: "cy-GB",
        cycleContext: { briefUrl: "https://example.com/b/123" },
      });

      expect(message.content.text).toContain("Crynodeb Ymweliad Asthma");
      expect(message.content.text).toContain("https://example.com/b/123");
    });

    it("uses Welsh cycle closing message", async () => {
      const output = makePlannerOutput({ type: "end_session", purpose: "Thanks." });
      const message = await renderMessage("user_1", output, {
        locale: "cy-GB",
        cycleContext: { cycleType: "TRIAL_7_DAY", cycleDay: 7, briefReady: true },
      });

      expect(message.content.text).toContain("treial 7 diwrnod");
      expect(message.content.text).toContain("Cerdyn Clefyd");
    });
  });

  describe("out-of-session template conversion", async () => {
    const mockResolver = {
      resolve: vi.fn((message: OutboundMessage) => ({
        templateKey: "plain_text",
        templateVariables: { body: message.content.text },
      })),
    };

    it("converts text message to template when out of session and resolver provided", async () => {
      const output = makePlannerOutput({ type: "end_session", purpose: "Thanks for checking in." });
      const message = await renderMessage("user_1", output, {
        outOfSession: true,
        templateResolver: mockResolver,
      });

      expect(message.content.type).toBe("template");
      expect(message.content.templateKey).toBe("plain_text");
      expect(message.conversationContext.requiresSession).toBe(false);
    });

    it("serializes buttons into template body when out of session", async () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "activity_limitation",
        expectedResponseType: "single_choice",
        options: ["activity_no", "activity_yes"],
      });
      const message = await renderMessage("user_1", output, {
        capability: whatsappCapability,
        outOfSession: true,
        templateResolver: mockResolver,
      });

      expect(message.content.type).toBe("template");
      expect(message.content.text).toContain("No limitation (reply activity_no)");
      expect(message.content.text).toContain("Yes, limited (reply activity_yes)");
    });

    it("does not convert when outOfSession is false", async () => {
      mockResolver.resolve.mockClear();
      const output = makePlannerOutput({ type: "end_session", purpose: "Thanks." });
      const message = await renderMessage("user_1", output, {
        outOfSession: false,
        templateResolver: mockResolver,
      });

      expect(message.content.type).toBe("text");
      expect(mockResolver.resolve).not.toHaveBeenCalled();
    });

    it("does not convert when capability does not support templates", async () => {
      const output = makePlannerOutput({ type: "end_session", purpose: "Thanks." });
      const message = await renderMessage("user_1", output, {
        capability: lineCapability,
        outOfSession: true,
        templateResolver: mockResolver,
      });

      expect(message.content.type).toBe("text");
    });
  });

  describe("LLM polish", async () => {
    it("polishes text message when enabled and llmClient is provided", async () => {
      const output = makePlannerOutput({ type: "end_session", purpose: "Thank you for your updates." });
      const llmClient = mockLlm("Thanks so much for the update — it really helps.");
      const message = await renderMessage("user_1", output, {
        enableLlmPolish: true,
        llmClient,
      });

      expect(message.content.text).toBe("Thanks so much for the update — it really helps.");
      expect(llmClient.complete).toHaveBeenCalledTimes(1);
    });

    it("does not polish when disabled", async () => {
      const output = makePlannerOutput({ type: "end_session", purpose: "Thank you for your updates." });
      const llmClient = mockLlm("Polished text.");
      const message = await renderMessage("user_1", output, {
        enableLlmPolish: false,
        llmClient,
      });

      expect(message.content.text).toBe("Thank you for your updates.");
      expect(llmClient.complete).not.toHaveBeenCalled();
    });

    it("does not polish when llmClient is missing", async () => {
      const output = makePlannerOutput({ type: "end_session", purpose: "Thank you for your updates." });
      const message = await renderMessage("user_1", output, { enableLlmPolish: true });

      expect(message.content.text).toBe("Thank you for your updates.");
    });

    it("does not polish non-text content (buttons)", async () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "activity_limitation",
        expectedResponseType: "single_choice",
        options: ["activity_no", "activity_yes"],
      });
      const llmClient = mockLlm("Polished text.");
      const message = await renderMessage("user_1", output, {
        capability: whatsappCapability,
        enableLlmPolish: true,
        llmClient,
      });

      expect(message.content.type).toBe("buttons");
      expect(llmClient.complete).not.toHaveBeenCalled();
    });

    it("calls onLlmCall audit callback when polishing", async () => {
      const output = makePlannerOutput({ type: "end_session", purpose: "Thank you." });
      const llmClient = mockLlm("Thanks!");
      const onLlmCall = vi.fn();
      await renderMessage("user_1", output, {
        enableLlmPolish: true,
        llmClient,
        onLlmCall,
      });

      expect(onLlmCall).toHaveBeenCalledTimes(1);
      expect(onLlmCall).toHaveBeenCalledWith(
        "mock-polish",
        expect.any(Array),
        "Thanks!",
        { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
      );
    });
  });


  describe("render trace", async () => {
    it("emits trace with input/output/context", async () => {
      const output = makePlannerOutput({
        type: "ask",
        topic: "nighttime_symptoms",
        expectedResponseType: "single_choice",
        options: ["night_none", "night_mild", "night_disturbed", "night_woke_up"],
      });
      const onRenderTrace = vi.fn();
      await renderMessage("user_1", output, {
        capability: whatsappCapability,
        style: "v2",
        locale: "en-GB",
        cycleContext: { cycleType: "TRIAL_7_DAY", cycleDay: 3 },
        onRenderTrace,
      });

      expect(onRenderTrace).toHaveBeenCalledTimes(1);
      expect(onRenderTrace).toHaveBeenCalledWith({
        input: {
          actionType: "ask",
          topic: "nighttime_symptoms",
          expectedResponseType: "single_choice",
          optionCount: 4,
        },
        output: {
          contentType: "list",
          priority: "normal",
          requiresSession: true,
          templated: false,
          polished: false,
        },
        context: {
          style: "v2",
          locale: "en-GB",
          cycleType: "TRIAL_7_DAY",
          cycleDay: 3,
        },
      });
    });

    it("marks polished true when LLM polish runs", async () => {
      const output = makePlannerOutput({ type: "end_session", purpose: "Thank you." });
      const llmClient = mockLlm("Thanks!");
      const onRenderTrace = vi.fn();
      await renderMessage("user_1", output, {
        enableLlmPolish: true,
        llmClient,
        onRenderTrace,
      });

      expect(onRenderTrace).toHaveBeenCalledTimes(1);
      const trace = onRenderTrace.mock.calls[0][0];
      expect(trace.output.polished).toBe(true);
    });

    it("marks templated true when out-of-session template is applied", async () => {
      const output = makePlannerOutput({ type: "end_session", purpose: "Thanks." });
      const onRenderTrace = vi.fn();
      const resolver = {
        resolve: vi.fn((message: OutboundMessage) => ({
          templateKey: "plain_text",
          templateVariables: { body: message.content.text },
        })),
      };
      await renderMessage("user_1", output, {
        capability: whatsappCapability,
        outOfSession: true,
        templateResolver: resolver,
        onRenderTrace,
      });

      const trace = onRenderTrace.mock.calls[0][0];
      expect(trace.output.templated).toBe(true);
      expect(trace.output.requiresSession).toBe(false);
    });
  });
});

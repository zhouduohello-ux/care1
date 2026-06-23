import { describe, it, expect } from "vitest";
import { WHATSAPP_TEMPLATES, selectTemplate, buildTemplateVariables, getTemplateNames } from "./templates.js";
import type { OutboundMessage } from "@carememory/im-core";

function makeMessage(text: string, priority: "normal" | "urgent" = "normal"): OutboundMessage {
  return {
    userId: "447123456789",
    conversationContext: { requiresSession: true, priority },
    content: { type: "text", text },
  };
}

describe("WhatsApp templates", () => {
  it("exposes all MVP template keys", () => {
    const names = getTemplateNames();
    expect(names).toContain("welcome");
    expect(names).toContain("checkin_reminder");
    expect(names).toContain("brief_ready");
    expect(names).toContain("safety_notice");
    expect(names).toContain("stop_confirm");
    expect(names).toContain("reactivation");
    expect(names).toContain("plain_text");
  });

  it("selects safety_notice for urgent priority", () => {
    const template = selectTemplate(makeMessage("Please review your symptoms", "urgent"));
    expect(template).toBe("safety_notice");
  });

  it("selects brief_ready for brief messages", () => {
    const template = selectTemplate(makeMessage("Your visit brief is ready: http://localhost/b/123"));
    expect(template).toBe("brief_ready");
  });

  it("selects checkin_reminder for reminder messages", () => {
    const template = selectTemplate(makeMessage("You have a pending check-in. It only takes a minute."));
    expect(template).toBe("checkin_reminder");
  });

  it("selects stop_confirm for stop/pause messages", () => {
    const template = selectTemplate(makeMessage("We've paused your CareMemory reminders."));
    expect(template).toBe("stop_confirm");
  });

  it("selects welcome for welcome messages", () => {
    const template = selectTemplate(makeMessage("Welcome to CareMemory. Reply AGREE to continue."));
    expect(template).toBe("welcome");
  });

  it("falls back to plain_text for generic messages", () => {
    const template = selectTemplate(makeMessage("Thanks for your reply."));
    expect(template).toBe("plain_text");
  });

  it("builds variables for plain_text template", () => {
    const variables = buildTemplateVariables("plain_text", makeMessage("Hello world"), { nickname: "Alex" });
    expect(variables.body).toBe("Hello world");
  });

  it("builds variables for welcome template", () => {
    const variables = buildTemplateVariables("welcome", makeMessage("Welcome"), { nickname: "Alex" });
    expect(variables.nickname).toBe("Alex");
  });

  it("respects max body length when building plain_text variables", () => {
    const longText = "a".repeat(2000);
    const variables = buildTemplateVariables("plain_text", makeMessage(longText), {});
    expect(variables.body.length).toBeLessThanOrEqual(1024);
  });
});

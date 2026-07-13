import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendSafetyAlert, type SafetyAlertPayload } from "./safety-alert.js";

const basePayload: SafetyAlertPayload = {
  eventType: "safety_alert_blocked",
  timestamp: "2026-07-13T05:58:00.000Z",
  userId: "user_1",
  dbUserId: "db_user_1",
  cycleId: "cycle_1",
  checkInId: "checkin_1",
  traceId: "trace_1",
  riskLevel: "high",
  blockReason: "Prohibited diagnostic language",
  checkedMessageCount: 1,
  checkedMessageTexts: ["You should increase your inhaler dose."],
  environment: "test",
};

describe("sendSafetyAlert", () => {
  const originalEnv = process.env;
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SAFETY_ALERT_WEBHOOK_URL;
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("logs a warning even when no webhook URL is configured", async () => {
    await sendSafetyAlert(basePayload);

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[safety-alert] Blocked outbound message",
      expect.objectContaining({
        userId: "user_1",
        riskLevel: "high",
        blockReason: "Prohibited diagnostic language",
        checkedMessageCount: 1,
        traceId: "trace_1",
      })
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("POSTs to SAFETY_ALERT_WEBHOOK_URL when configured", async () => {
    process.env.SAFETY_ALERT_WEBHOOK_URL = "https://hooks.example.com/safety";

    await sendSafetyAlert(basePayload);

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://hooks.example.com/safety",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(basePayload),
      })
    );
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[safety-alert] Blocked outbound message",
      expect.any(Object)
    );
  });

  it("does not throw when the webhook request fails", async () => {
    process.env.SAFETY_ALERT_WEBHOOK_URL = "https://hooks.example.com/safety";
    fetchSpy.mockRejectedValue(new Error("network error"));

    await expect(sendSafetyAlert(basePayload)).resolves.toBeUndefined();

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      "[safety-alert] Failed to deliver webhook",
      expect.objectContaining({ error: "network error" })
    );
  });
});

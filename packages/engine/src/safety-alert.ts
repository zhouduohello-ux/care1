export interface SafetyAlertPayload {
  eventType: "safety_alert_blocked";
  timestamp: string;
  userId: string;
  dbUserId?: string;
  cycleId?: string;
  checkInId?: string;
  traceId?: string;
  riskLevel: string;
  blockReason?: string;
  checkedMessageCount: number;
  checkedMessageTexts: string[];
  environment?: string;
}

/**
 * Emit a structured alert when L6 blocks an outbound message.
 *
 * Behavior:
 * - Always logs a warning to the console so the event is visible in logs/Sentry.
 * - If `SAFETY_ALERT_WEBHOOK_URL` is configured, POSTs the payload to that URL.
 * - Webhook failures are swallowed and logged; they must not break the user flow.
 */
export async function sendSafetyAlert(payload: SafetyAlertPayload): Promise<void> {
  const url = process.env.SAFETY_ALERT_WEBHOOK_URL;

  console.warn("[safety-alert] Blocked outbound message", {
    userId: payload.userId,
    riskLevel: payload.riskLevel,
    blockReason: payload.blockReason,
    checkedMessageCount: payload.checkedMessageCount,
    traceId: payload.traceId,
  });

  if (!url) {
    return;
  }

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.warn("[safety-alert] Failed to deliver webhook", {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

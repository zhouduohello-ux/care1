# L6 Safety & Compliance Layer Specification

> Version: 1.0  
> Scope: outbound message safety checking, addendum injection, audit, and risk escalation.  
> Disease: asthma (MVP); designed to be disease-agnostic where noted.

## 1. Position in the six-layer engine

```
L1 Perception → L2 Memory → L3 RAG → L4 Planner → L5 Dialogue → L6 Safety → Dispatch
```

L6 is the **last gate before a message is dispatched** to the patient. It must:

1. Block outbound messages that contain prohibited diagnostic/treatment language.
2. Append required safety addendums when medical/asthma-related content is detected.
3. Grade each batch with a risk level (`none` | `low` | `medium` | `high`).
4. Persist a `safety_check` audit event for every batch.
5. Act on elevated outbound risk by aborting the batch when `approved=true` + `riskLevel=high`.

## 2. Current implementation

### 2.1 Core checker: `packages/engine/src/safety.ts`

- `safetyCheck(message, disease = "asthma"): SafetyResult`
- Combines:
  - Hard-coded regex patterns for common asthma diagnostic/treatment phrases.
  - RAG-loaded prohibited phrases from `safety-rules.md` → `Must never say`.
  - RAG-loaded required addendums from `safety-rules.md` → `Must always say`.
- Content classification decides which addendums are appended:
  - Asthma-related keywords → emergency addendum (e.g. 999).
  - Medical/health keywords → medical disclaimer.
  - Neutral content → no addendums.

### 2.2 Wrapper, risk action, and LLM classifier: `packages/engine/src/engine.ts`

- `safetyWrapWithSummary(userId, messages, disease?)` — pure function; returns wrapped messages + aggregated `SafetyResult`.
- `applySafetyAction(messages, summary)` — aborts the entire batch and replaces it with a safe fallback when `approved=true` + `riskLevel=high`.
- `createSafetyWrapper(context, userId, cycleId?, disease?, dbUserId?, allowLlm?)` — async closure that:
  - Calls `safetyWrapWithSummary` (rule-based).
  - Calls `applySafetyAction`.
  - If `allowLlm` is true, the rule-based result is `approved`, and a safety-layer LLM client is configured, calls `llmSafetyCheckAsync()` from `safety-llm.ts`.
  - Falls back to the rule-based result if the LLM classifier errors or returns non-JSON.
  - Persists a `safety_check` Event via `saveSafetyCheckEvent` when `dbUserId` is known.
- All outbound batches in `processInboundInternal`, `finalizeCheckInSession`, and `handleCheckInTrigger` route through the wrapper.

### 2.5 LLM semantic classifier: `packages/engine/src/safety-llm.ts`

- `llmSafetyCheckAsync(input, llmClient)` — sends the outbound batch plus disease context and RAG safety rules to an LLM.
- Expects JSON output: `{ approved: boolean, riskLevel: "none" | "low" | "medium" | "high", blockReason?: string }`.
- Non-JSON or malformed responses are treated as unsafe (approved=false, riskLevel=high) to fail closed.

### 2.3 RAG rules: `packages/rag/src/safety-rules.ts`

- Parses `documents/<disease>/safety-rules.md` sections:
  - `Must never say` → `prohibitedPhrases`
  - `Must always say` → `requiredAddendums`
  - `Escalation triggers` → `escalationTriggers` (consumed by L1 Perception)
- Exported as `loadSafetyRules(disease)` from `@carememory/rag`.

### 2.4 Audit event: `packages/engine/src/memory.ts`

- `saveSafetyCheckEvent(prisma, dbUserId, summary, checkedMessages, traceId?, cycleId?, checkInId?)`
- Writes `EventType.safety_check` with payload:
  - `approved`, `riskLevel`, `blockReason`, `requiredAddendums`
  - `checkedMessageCount`, `checkedTexts`
- Skips persistence when `dbUserId` is missing (pre-authentication flows).

## 3. Input / output contract

### 3.1 Input

| Field | Type | Description |
|-------|------|-------------|
| `messages` | `OutboundMessage[]` | Messages produced by L5 Dialogue or system fallback. |
| `disease` | `string` | Disease key (default `"asthma"`). Used to load disease-specific RAG rules. |
| `dbUserId` | `string?` | Database `User.id`; required for audit event FK. |
| `cycleId` / `checkInId` / `traceId` | `string?` | Optional audit context. |

### 3.2 Output: `SafetyResult`

```typescript
interface SafetyResult {
  approved: boolean;
  rewrittenMessage?: string;      // reserved for future rewrite path
  requiredAddendums: string[];    // addendums that were appended
  riskLevel: "none" | "low" | "medium" | "high";
  blockReason?: string;
}
```

## 4. Decision matrix

| `approved` | `riskLevel` | Behaviour |
|------------|-------------|-----------|
| `false` | `high` | Replace blocked message(s) with safe fallback; append audit event. |
| `true` | `none` | Pass through unchanged. |
| `true` | `low` | Pass through with addendums if applicable. |
| `true` | `medium` | Pass through with addendums; currently no extra action. |
| `true` | `high` | **Abort the whole batch** via `applySafetyAction` and return a safe fallback. Triggered by the LLM semantic classifier when it flags paraphrased unsafe advice. |

## 5. Known gaps and planned work

### 5.1 Outbound risk action (P1 — safety critical) ✅ Done

`summary.riskLevel` is now consumed by `applySafetyAction()`. If the LLM classifier returns `approved=true` + `riskLevel=high`, the batch is aborted and replaced with a safe fallback.

`medium` risk no longer passes through silently: `createSafetyWrapper()` increments `CheckIn.mediumRiskCount` and writes the updated count into the `safety_check` audit event. This gives operations a per-check-in concern counter for future escalation rules.

### 5.2 LLM-based semantic safety classifier (P2) ✅ Done

`safety-llm.ts` provides `llmSafetyCheckAsync()`. It is invoked by `createSafetyWrapper()` when `allowLlm` is true and a safety-layer LLM client is available. The prompt includes disease context and RAG safety rules; output is JSON `{approved, riskLevel, blockReason}`. LLM failures and malformed responses fall back to the rule-based result (fail-open on error, fail-closed on non-JSON).

**Future tuning**:
- A/B test classifier vs. rule-only to measure block rate and false-positive rate.
- ✅ Cache classifier results per message text to reduce LLM cost. Implemented in `packages/engine/src/safety-llm.ts` with an in-memory TTL cache keyed by message texts + disease + RAG rules. Configurable via `SAFETY_LLM_CACHE_TTL_MS` and `SAFETY_LLM_CACHE_MAX_ENTRIES`.

### 5.3 Non-text content safety (P2) ✅ Done

`safetyCheck` now scans `buttons` titles, `list` row titles/descriptions, and `templateVariables` in addition to the main body text. Addendum classification also considers these fields.

### 5.4 Per-disease safety rules verification (P2) ✅ Done

`packages/rag/src/safety-rules.test.ts` verifies:

- `loadSafetyRules("asthma")` returns non-empty rules.
- `loadSafetyRules("unknown-disease")` returns empty rules (case-insensitive).

`packages/engine/src/safety.test.ts` verifies that for an unknown disease the checker still applies fallback emergency + medical disclaimers and still blocks hard-coded prohibited patterns.

### 5.5 Safety metrics and alerting (P3) ✅ Done

`/admin/metrics` now exposes:

- `safetyChecksTotal`
- `safetyBlocksTotal`
- `safetyBlocks24h`
- `safetyHighRisk24h`

Blocked-message alerting is implemented in `packages/engine/src/safety-alert.ts`:

- `createSafetyWrapper()` calls `sendSafetyAlert()` whenever a batch is blocked (`approved=false`, `riskLevel=high`).
- The alert always logs a structured warning.
- If `SAFETY_ALERT_WEBHOOK_URL` is configured, the payload is POSTed to that URL; webhook failures are swallowed so they cannot break the user flow.

## 6. Tests

| Test file | Coverage |
|-----------|----------|
| `packages/rag/src/safety-rules.test.ts` | Per-disease rule loading, empty fallback for unsupported diseases. |
| `packages/engine/src/safety-alert.test.ts` | Webhook alerting: logs always, POSTs when configured, swallows failures. |
| `packages/engine/src/safety.test.ts` | Regex blocks, RAG phrase blocks, addendum classification, neutral content, button/list scanning, `applySafetyAction` batch abort, unknown-disease fallback. |
| `packages/engine/src/safety-llm.test.ts` | LLM approval, LLM blocking, malformed/non-JSON responses. |
| `packages/engine/src/memory.test.ts` | `saveSafetyCheckEvent` payload and skip-on-missing-user behaviour. |
| `packages/engine/src/engine.integration.test.ts` | End-to-end flow including safety wrap + audit persistence. |
| `apps/api/src/routes/admin.test.ts` | Safety metrics in `/admin/metrics`. |

## 7. Related files

- `packages/engine/src/safety.ts`
- `packages/engine/src/safety-llm.ts`
- `packages/engine/src/engine.ts`
- `packages/engine/src/memory.ts`
- `packages/rag/src/safety-rules.ts`
- `packages/rag/documents/asthma/safety-rules.md`
- `docs/func-spec.md` §3.6, §12.3
- `docs/open-boundaries.md`

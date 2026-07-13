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
5. (Future) Act on `medium`/`high` outbound risk by escalating to operators or aborting the check-in.

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

### 2.2 Wrapper: `packages/engine/src/engine.ts`

- `safetyWrapWithSummary(userId, messages, disease?)` — pure function; returns wrapped messages + aggregated `SafetyResult`.
- `createSafetyWrapper(context, userId, cycleId?, disease?, dbUserId?)` — async closure that:
  - Calls `safetyWrapWithSummary`.
  - Persists a `safety_check` Event via `saveSafetyCheckEvent` when `dbUserId` is known.
- All outbound batches in `processInboundInternal`, `finalizeCheckInSession`, and `handleCheckInTrigger` route through the wrapper.

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

| `approved` | `riskLevel` | Current behaviour | Planned behaviour |
|------------|-------------|-------------------|-------------------|
| `false` | `high` | Replace message with safe fallback; append audit event. | Same. Optionally notify operator/webhook. |
| `true` | `none` | Pass through unchanged. | Same. |
| `true` | `low` | Pass through with addendums if applicable. | Same. |
| `true` | `medium` | Pass through with addendums if applicable. | Consider marking check-in for review / increment safety counter. |
| `true` | `high` | **Not produced today** because `approved=true` implies no prohibited phrase. | If future LLM-based classification yields `approved=true` + `high`, abort batch and escalate. |

## 5. Known gaps and planned work

### 5.1 Outbound risk action (P1 — safety critical)

**Gap**: `summary.riskLevel` from L6 is returned in the trace but never read by `engine.ts` to influence behaviour. Only `approved=false` blocks a message.

**Plan**:
- After calling `safetyWrapWithSummary` / `createSafetyWrapper`, inspect `summary.riskLevel`.
- If outbound risk is `high` and `approved=true` (future LLM classifier), abort the batch and send a safe fallback.
- If outbound risk is `medium`, increment a per-check-in `safetyConcernCount` and, after N occurrences, end the session with a standard safety notice.
- Expose safety metrics in admin/metrics.

### 5.2 LLM-based semantic safety classifier (P2)

**Gap**: Current checker is regex + exact-phrase based. It cannot catch paraphrased dangerous advice.

**Plan**:
- Add optional LLM classifier behind quota/flag.
- Input: raw L5 output + RAG safety rules.
- Output: `approved`, `riskLevel`, `blockReason`.
- Fall back to rule-based when quota exceeded or LLM unavailable.

### 5.3 Non-text content safety (P2)

**Gap**: Only `message.content.text` is checked. Buttons, lists, and templates are not inspected.

**Plan**:
- Extend `safetyCheck` to iterate over interactive elements (button text, list titles, template bodies).
- Prohibit dangerous text in any interactive element.

### 5.4 Per-disease safety rules verification (P2)

**Gap**: Only asthma rules exist and are tested.

**Plan**:
- Add disease-specific safety test suites.
- Verify `loadSafetyRules` returns empty/fallback for unsupported diseases.

### 5.5 Safety metrics and alerting (P3)

**Gap**: No dedicated safety dashboard metrics.

**Plan**:
- Add admin/metrics counters: `safety_checks_total`, `safety_blocks_total`, `safety_high_risk_total`.
- Add webhook/notification hook for blocked messages.

## 6. Tests

| Test file | Coverage |
|-----------|----------|
| `packages/engine/src/safety.test.ts` | Regex blocks, RAG phrase blocks, addendum classification, neutral content. |
| `packages/engine/src/memory.test.ts` | `saveSafetyCheckEvent` payload and skip-on-missing-user behaviour. |
| `packages/engine/src/engine.integration.test.ts` | End-to-end flow including safety wrap + audit persistence. |

## 7. Related files

- `packages/engine/src/safety.ts`
- `packages/engine/src/engine.ts`
- `packages/engine/src/memory.ts`
- `packages/rag/src/safety-rules.ts`
- `packages/rag/documents/asthma/safety-rules.md`
- `docs/func-spec.md` §3.6, §12.3
- `docs/open-boundaries.md`

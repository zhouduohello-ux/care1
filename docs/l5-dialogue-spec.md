# CareMemory L5 对话层（Dialogue Layer）规格文档

> **文档编号**：SPEC-L5-001  
> **版本**：v1.17
> **分支**：`feat/l5-dialogue-optimization`  
> **对应架构层**：L5 Dialogue  
> **上游**：L4 Planner | **下游**：L6 Safety、IM Adapter（WhatsApp）  
> **最后更新**：2026-07-11

---

## 1. 设计目标

L5 对话层负责把 L4 规划层产生的**结构化决策**（`PlannerOutput`）转换成**平台无关的出站消息**（`OutboundMessage`）。

核心原则：

1. **与平台解耦**：L5 不知道 WhatsApp、LINE 或 SMS 的具体 payload 格式。
2. **与 LLM 解耦**：默认使用规则渲染；可选接入 LLM 润色，但不得改变 `PlannerOutput` 的语义。
3. **可追踪**：所有渲染决策必须能通过 `PlannerOutput.nextAction` 反推。
4. **最小侵入**：L5 不改变患者状态、不直接写数据库，只生成消息对象。

---

## 2. 接口契约

### 2.1 输入：`PlannerOutput`

来源：`packages/engine/src/types.ts`

```ts
export interface PlannerOutput {
  reasoning: string;                 // 规划理由，仅用于 trace，不展示给用户
  sessionObjective: string;          // 本轮会话目标
  nextAction: {
    type: "ask" | "inform" | "remind" | "safety_response" | "generate_brief" | "end_session";
    topic: string;                   // 问题/动作主题，用于按钮 ID 映射
    purpose: string;                 // 意图文本，通常直接作为展示文本
    expectedResponseType?: "single_choice" | "scale" | "multi_select" | "text";
    options?: string[];              // 单选/多选选项 ID 列表
    budgetCost: number;              // 本轮消耗的 check-in 预算
  };
  alternativeActions?: PlannerOutput["nextAction"][]; // 候选动作（当前 L5 未使用）
  safetyFlag: "none" | "low" | "medium" | "high";
  updatePatientState: {
    newObservations?: Observation[];
    updateNarrative?: boolean;
    addOpenIssue?: string;
    resolveOpenIssue?: string;
  };
}
```

### 2.2 输出：`OutboundMessage`

来源：`packages/im-core/src/index.ts`

```ts
export interface OutboundMessage {
  userId: string;
  platform?: Platform;
  idempotencyKey?: string;           // 由 engine L2 生成，L5 不处理
  conversationContext: {
    requiresSession: boolean;        // 是否需要会话窗口（几乎始终 true）
    priority: "normal" | "urgent";   // L5 根据 action.type 设置
  };
  content: {
    type: "text" | "buttons" | "list" | "template";
    text: string;
    buttons?: Array<{ id: string; title: string }>;
    list?: Array<{ id: string; title: string; description?: string }>;
    templateKey?: string;              // 平台无关的模板 key，由具体 IM adapter 映射为真实模板名
    templateVariables?: Record<string, string>;
  };
}
```

### 2.3 L5 渲染追踪：`DialogueTrace`

```ts
export interface DialogueTrace {
  input: {
    actionType: PlannerOutput["nextAction"]["type"];
    topic: string;
    expectedResponseType?: string;
    optionCount?: number;
  };
  output: {
    contentType: OutboundMessage["content"]["type"];
    priority: "normal" | "urgent";
    requiresSession: boolean;
    templated: boolean;
    polished: boolean;
  };
  context: {
    style: string;
    locale: string;
    cycleType?: string;
    cycleDay?: number;
  };
}
```

`renderMessage` 支持通过 `RenderOptions.onRenderTrace` 回调输出 `DialogueTrace`；`processInbound` 将其写入 `EngineTrace.dialogue`，用于问题排查与可观测性。

---

## 3. L4 → L5 消息类型与处理矩阵

### 3.1 L4 实际会抛给 L5 的类型

根据 `packages/engine/src/planner.ts` 当前实现，L4 只会生成以下 3 种 `nextAction.type`：

| L4 输出类型 | 触发场景 | 附带字段 |
|---|---|---|
| `ask` | 正常 check-in，询问下一个未覆盖的控制问题 | `topic`, `purpose`, `expectedResponseType`, `options`, `budgetCost` |
| `ask` | 异常模式（exception mode）下的澄清问题 | `topic="exception_clarification"`, `expectedResponseType="text"`, 无 `options` |
| `end_session` | 问题全部问完 / 预算耗尽 / 异常模式结束 | `purpose` 为结束语 |
| `safety_response` | 近期观测包含 `adverse_event` 类别 | `purpose` 为安全提示 |

> **注意**：`PlannerOutput` 的 TypeScript 类型还声明了 `inform`、`remind`、`generate_brief`，但当前 `planner.ts` 的实现**永远不会**产生这 3 种类型。L5 把它们作为兜底按纯文本处理即可。

### 3.2 L5 处理矩阵

| L4 `type` | L4 `expectedResponseType` | L5 处理动作 | 输出 `content.type` | `priority` | 当前状态 |
|---|---|---|---|---|---|
| `safety_response` | 任意 | 直接展示 `purpose`，不做交互包装 | `text` | `urgent` | ✅ 已实现 |
| `end_session` | 任意 | 直接展示 `purpose` 作为结束语 | `text` | `normal` | ✅ 已实现 |
| `ask` | `single_choice` + `options` | 将 `options` 映射为可读按钮标题 | `buttons` | `normal` | ✅ 已实现 |
| `ask` | `text` | 直接展示 `purpose` 作为开放式问题 | `text` | `normal` | ✅ 已实现 |
| `ask` | `scale` | 渲染 1–5 分按钮（平台不支持时降级为 list） | `buttons` / `list` | `normal` | ✅ 已实现 |
| `ask` | `multi_select` | 渲染 list 或枚举文本，附带 "Reply with all that apply" | `list` / `text` | `normal` | ✅ 已实现 |
| `inform` / `remind` / `generate_brief` | 任意 | 兜底为纯文本 | `text` | `normal` | ⚠️ 兜底 |

### 3.3 单选按钮的标签映射

当前硬编码映射（`packages/engine/src/dialogue.ts`）：

| `topic` | `options` | 渲染标题 |
|---|---|---|
| `nighttime_symptoms` | `["night_none", "night_mild", "night_disturbed", "night_woke_up"]` | `["None", "Mild", "Disturbed sleep", "Woke me up"]` |
| `reliever_use` | `["reliever_0", "reliever_1", "reliever_2", "reliever_3_plus"]` | `["0 times", "1 time", "2 times", "3+ times"]` |
| `activity_limitation` | `["activity_no", "activity_yes"]` | `["No limitation", "Yes, limited"]` |

> **设计债**：标签映射与 `packages/engine/src/planner.ts` 中的 `CHECKIN_QUESTIONS` 存在重复定义。未来应统一到一个共享的 question bank。

### 3.4 L5 的通用处理职责

无论收到哪种类型，L5 都必须完成：

1. **设置 `conversationContext`**
   - `requiresSession: true`（几乎所有消息都需要在 24h 会话窗口内发送）
   - `priority: "urgent"` 仅对 `safety_response`，其余为 `"normal"`
2. **选项 ID → 可读标题映射**
   - 已知 topic 使用硬编码标签表
   - 未知 topic 回退到 `options` 原始 ID
3. **保持平台无关**
   - L5 只生成 `OutboundMessage`，不生成 WhatsApp payload
   - WhatsApp 适配由 `packages/im-whatsapp/src/index.ts` 负责
4. **不修改患者状态**
   - L5 不写数据库、不更新 check-in 预算、不产生 observation
   - 预算扣减在引擎主流程中 L5 之后执行

### 3.5 L5 边界治理

1. **输入校验**：`renderMessage` 首先调用 `validatePlannerOutput()`，缺少 `nextAction.type` / `purpose` 时抛出明确错误。
2. **错误兜底**：`engine.ts` 的 `processInbound` 将 `renderMessage` 包在 `try/catch` 中；渲染失败时回退到安全文本，避免患者无回复。
3. **L6 边界**：所有 L5 输出仍必须经过 `safetyWrapWithSummary()`；`safety_response` 跳过 LLM 润色，保证安全提示原文不变。
4. **状态不可变**：L5 不修改患者状态、不写数据库、不扣减预算。

### 3.6 不经过 L5 的场景

以下场景由引擎上层直接处理，不会调用 L4 / L5：

| 场景 | 处理方式 |
|---|---|
| 高风险安全标记（L1 已识别 high risk） | 引擎主流程直接返回急救消息 |
| 系统命令（STOP / DELETE MY DATA / EXPORT MY DATA / HELP 等） | 引擎主流程直接构造回复 |
| onboarding 流程 | `packages/engine/src/onboarding.ts` 直接生成消息 |
| 迟到回答 / 跨 cycle 回复 | 引擎主流程直接构造确认消息 |

### 3.6 流程速查图

```
L4 Planner 输出
    │
    ├──► safety_response ──────► L5: urgent 文本 ──────► L6 安全校验 ──────► 发送
    │
    ├──► ask (single_choice) ──► L5: 按钮消息 ─────────► L6 安全校验 ──────► 发送
    │
    ├──► ask (text) ───────────► L5: 普通文本 ─────────► L6 安全校验 ──────► 发送
    │
    └──► end_session ──────────► L5: 结束语文本 ───────► L6 安全校验 ──────► 发送
                                                              │
                                                              ▼
                                                    引擎：更新 DiseaseCard / Brief / 下次 check-in
```

---

## 4. L5 在引擎主流程中的位置

### 4.1 用户入站消息路径

```
InboundMessage
    │
    ▼
L1 Perception ──► 提取 observation + intent + safety/anomaly
    │
    ▼
L2 Memory ──► 写入 Event / Observation
    │
    ▼
L6 Safety（fast path）───► high risk? 直接安全响应
    │
    ▼
L4 Planner ──► PlannerOutput
    │
    ▼
L5 Dialogue ──► renderMessage(userId, plannerOutput, { capability, style }) ──► OutboundMessage
    │
    ▼
L6 Safety ──► 最终校验 + 追加急救/免责声明
    │
    ▼
L2 Memory ──► 保存 outbound_message Event（带 idempotencyKey）
    │
    ▼
IM Adapter dispatch ──► 发送
```

### 4.2 定时 check-in 触发路径

```
Scheduler / BullMQ trigger
    │
    ▼
engine.handleCheckInTrigger(context, cycleId)
    │
    ▼
L4 Planner ──► PlannerOutput
    │
    ▼
L5 Dialogue ──► OutboundMessage
    │
    ▼
L6 Safety + L2 Memory + dispatch
```

### 4.4 L5 Turn Manager（pending question 轮次管理）

`packages/engine/src/turn-manager.ts` 负责维护当前 check-in 的**待回答问题**，并在用户答非所问时进行重提示。

状态持久化：

| 字段 | 位置 | 用途 |
|---|---|---|
| `pendingQuestion` | `CheckIn.pendingQuestion`（Json） | 当前待回答的问题 |
| `repromptCount` | `CheckIn.repromptCount`（Int） | 已连续重提示次数 |
| `turn_reprompt` | `Event` 表 | 每次重提示的审计日志，含 topic / count / reason |

流程：

1. L4 Planner 生成 `ask` action 后，`pendingQuestionFromPlannerOutput()` 提取问题，engine 调用 `setPendingQuestion()` 写入 `CheckIn.pendingQuestion` 并重置 `repromptCount = 0`。
2. 用户下次回复时，engine 在 L4 Planner 之前调用 `getTurnState()` 读取待问问题与已重提示次数。
3. `isAnswerToPendingQuestion()` 判断用户是否回答了该问题。匹配逻辑分层：
   - 按钮 / list reply：必须精确匹配选项 ID；
   - `text`：任何文本都视为回答；
   - `single_choice`：先匹配选项 ID，再匹配 `dialogue-locales` 中的 `optionSynonyms`（如 "woke me up" → `night_woke_up`）；
   - `scale`：先匹配 1–5 数字，再匹配 `scaleWordMap`（如 "severe" → 5）；
   - `multi_select`：按逗号 / "and" / 空格分词，每个 token 匹配选项 ID 或同义词；
   - 系统意图 `question` / `help` / `stop` / `continue_cycle` / `initiate` / `correction` 不视为回答；
   - perception 已提取到同 `topic` 的 observation 时也视为回答。
4. 若规则匹配失败且未超限：
   - 可选调用轻量 LLM `isAnswerRelevantWithLlm()` 做自然语言相关性判断；若 LLM 认为回答有效，记录 `subjective/{topic}` observation 并继续 L4 Planner，不再重提示。
   - 若 LLM 也认为未回答，或未配置 LLM，则 `buildRepromptMessage()` 渲染重提示（第 1 次前缀 “I didn't catch that.”，第 2 次 “Just to confirm:”），并调用 `recordReprompt()` 更新 `CheckIn` 与写入 `turn_reprompt` Event。
   - 若超过 `MAX_REPROMPTS`（由 `PENDING_QUESTION_MAX_REPROMPTS` 环境变量配置，默认 2 次），系统放弃追问：记录一条 `subjective/{topic}/no_answer` observation，清空 `pendingQuestion`，让 L4 Planner 继续下一题。
5. 若已回答：正常进入 L4 Planner，出站后根据新的 PlannerOutput 更新 `CheckIn.pendingQuestion`。

#### 4.4.1 Pending question 24h 静默超时

除了用户答非所问时的主动重提示，系统还通过调度任务对**长时间未回答的 pending question** 做静默超时处理，避免 check-in 无限期挂起。

| 字段 | 位置 | 用途 |
|---|---|---|
| `sentAt` | `CheckIn.sentAt` | 问题实际发出的时间 |
| `status` | `CheckIn.status` | 仅处理 `SENT` 状态的 check-in |
| `pendingQuestion` | `CheckIn.pendingQuestion` | 非空才需要超时 |

流程（由 `apps/api/src/services/scheduler.ts` 的 `scan-expired-pending` job 执行，默认每 60s 扫描一次）：

1. 计算截止时间 `deadline = now - PENDING_QUESTION_TIMEOUT_MS`（默认 24h）。
2. 查询所有 `status === "SENT"`、`sentAt <= deadline` 且 `pendingQuestion` 不为空的 `CheckIn`。
3. 对每个命中记录：
   - 创建一条 `category="subjective"`、`concept={topic}`、`value="no_answer"` 的 `Observation`，作为该问题无回答的正式记录；
   - 将 `CheckIn.status` 更新为 `"MISSED"` 并清空 `pendingQuestion` / `repromptCount`；
   - 写入 `state_updated` Event，payload 标注 `reason: "pending_question_expired"`、`topic`、`timeoutMs`。
4. 不发送任何消息给患者；该 check-in 视为已结束，下一次 `scan-checkins` 会为该 cycle 生成新的 check-in。

设计要点：

- **静默**：24h 后未回复即自动放弃，不打扰用户。这与 `scan-reminders` 的主动提醒是独立流程（reminder 在 24h 内发送一次，timeout 在 24h 后执行）。
- **幂等**：扫描基于 DB 状态，同一记录只会被处理一次；清空 `pendingQuestion` 后再次扫描不会重复命中。
- **可观测**：通过 `Observation` + `state_updated` Event 完整记录超时原因，便于后续分析 dropout。

#### 4.4.2 Pending question 12h gentle nudge

在 24h 静默超时之前，系统会在 12h 时发送一次 gentle nudge，提升回复率同时避免打扰。

状态持久化：

| 字段 | 位置 | 用途 |
|---|---|---|
| `nudgeSentAt` | `CheckIn.nudgeSentAt` | 记录 nudge 已发送，避免重复 |
| `nudge_sent` | `Event` 表 | 每次 nudge 的审计日志，含 topic / nudgeAfterMs |

流程（由 `apps/api/src/services/scheduler.ts` 的 `scan-pending-nudge` job 执行，默认每 60s 扫描一次）：

1. 计算截止时间 `deadline = now - PENDING_QUESTION_NUDGE_AFTER_MS`（默认 12h）。
2. 查询所有 `status === "SENT"`、`sentAt <= deadline`、`nudgeSentAt` 为空且 `pendingQuestion` 非空的 `CheckIn`。
3. 对每个命中记录：
   - 发送 gentle nudge 文本消息；
   - 更新 `CheckIn.nudgeSentAt = now`；
   - 写入 `nudge_sent` Event，payload 含 `topic`、`nudgeAfterMs`。
4. 若用户已回复，pendingQuestion 会被清空，`scan-pending-nudge` 不再命中。

#### 4.4.3 时间可配置化

nudge 与 timeout 的默认时间可通过环境变量调整（单位毫秒）：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PENDING_QUESTION_NUDGE_AFTER_MS` | `43200000`（12h） | 发出 check-in 后多久发送 gentle nudge |
| `PENDING_QUESTION_TIMEOUT_MS` | `86400000`（24h） | 发出 check-in 后多久未回复则记录 `no_answer` |
| `PENDING_QUESTION_MAX_REPROMPTS` | `2` | 答非所问时最多重提示几次，之后记录 `no_answer` 并跳过该问题 |

`apps/api/src/services/scheduler.ts` 提供 `getNudgeAfterMs()` 与 `getPendingTimeoutMs()` 读取环境变量；`packages/engine/src/turn-manager.ts` 提供 `getMaxReprompts()`；`processPendingNudges` / `processExpiredPendingQuestions` / 重提示流程均支持参数覆盖，便于测试与本地测试工具。

### 4.5 代码调用点

- **用户入站**：`packages/engine/src/engine.ts`（L4 Planner 之前）
- **定时触发**：`packages/engine/src/engine.ts:handleCheckInTrigger`（保存 outbound 后更新 `CheckIn.pendingQuestion`）

---

## 5. L5 → WhatsApp Adapter 转换细节

L5 输出的 `OutboundMessage` 由 `packages/im-whatsapp/src/index.ts` 中的 `WhatsAppAdapter.buildPayload()` 转换为 Meta Graph API payload。

### 5.1 消息类型映射

| `OutboundMessage.content.type` | WhatsApp payload `type` | 结构说明 |
|---|---|---|
| `text` | `text` | `{ text: { body: message.content.text } }` |
| `buttons` | `interactive` + `button` | body text + 最多 3 个回复按钮 |
| `list` | `interactive` + `list` | body text + 一个列表选择器 |
| `template` | `template` | 引用预审批模板名 + 变量 |

### 5.2 `buttons` 转换示例

```ts
// L5 输出
{
  content: {
    type: "buttons",
    text: "Track nighttime cough or wheeze over the past 2 days.",
    buttons: [
      { id: "night_none", title: "None" },
      { id: "night_mild", title: "Mild" },
      { id: "night_disturbed", title: "Disturbed sleep" },
      { id: "night_woke_up", title: "Woke me up" }
    ]
  }
}

// WhatsApp Adapter 输出
{
  messaging_product: "whatsapp",
  recipient_type: "individual",
  to: "<phone>",
  type: "interactive",
  interactive: {
    type: "button",
    body: { text: "Track nighttime cough or wheeze over the past 2 days." },
    action: {
      buttons: [
        { type: "reply", reply: { id: "night_none", title: "None" } },
        ...
      ]
    }
  }
}
```

> **WhatsApp 限制**：button 类型每条消息最多 3 个按钮。当前 `nighttime_symptoms` 和 `reliever_use` 都有 4 个选项，会直接触发 Meta API 错误。这是已知缺陷，见第 7 节优化项 L5-OPT-001。

### 5.3 `template` 转换

`OutboundMessage` 支持 `templateKey` / `templateVariables`。`templateKey` 是平台无关的抽象 key（如 `"plain_text"`、`"welcome"`），由 `IM Adapter` 根据平台映射到真实模板名（WhatsApp 下为 `carememory_plain_text`、`carememory_welcome` 等）。L5 现在可以通过 `RenderOptions.templateResolver` 在 24h 会话窗口外直接生成 `content.type === "template"` 消息；`RenderOptions.outOfSession` 由外层根据 `user.sessionWindowExpiresAt` 计算后传入。

当 `outOfSession === true`、平台 `capability.supportsTemplates === true` 且提供了 `templateResolver` 时，L5 会把渲染后的文本（含 buttons/list 的序列化选项）按 `capability.maxBodyLength` 截断后交给 resolver，resolver 返回平台无关的模板 key 与变量。当前 `apps/api/src/lib/template-resolver.ts` 使用 `packages/im-whatsapp/src/templates.ts` 的 `selectTemplate` / `buildTemplateVariables` 实现 WhatsApp 模板选择。

dispatch 层保留兜底：如果收到的消息 `content.type !== "template"` 且窗口已关闭，仍会在发送前做一次模板转换。

模板列表：

| 模板 key | 用途 | 变量 |
|---|---|---|
| `welcome` | 新用户欢迎 | `nickname` |
| `checkin_reminder` | 提醒 pending check-in | `first_name` |
| `brief_ready` | Brief 已生成 | `first_name`, `link` |
| `safety_notice` | 安全提示 | 无 |
| `stop_confirm` | 暂停确认 | 无 |
| `reactivation` | 窗口外重新激活 | `first_name` |
| `plain_text` | 通用自由文本 fallback | `body` |

---

## 6. 当前实现清单

| 项目 | 状态 | 文件/位置 |
|---|---|---|
| 文本消息渲染 | ✅ 已实现 | `packages/engine/src/dialogue.ts:45-52` |
| 按钮消息渲染 | ✅ 已实现 | `packages/engine/src/dialogue.ts:29-43` |
| 单选标签映射 | ✅ 已实现 | `packages/engine/src/dialogue.ts:55-62` |
| 安全响应渲染 | ✅ 已实现 | `packages/engine/src/dialogue.ts:7-16` |
| 结束会话渲染 | ✅ 已实现 | `packages/engine/src/dialogue.ts:18-27` |
| 量表（scale）渲染 | ✅ 已实现 | `packages/engine/src/dialogue.ts` |
| 列表（list）渲染 | ✅ 已实现（作为按钮超限自动降级） | `packages/engine/src/dialogue.ts` |
| 周期结束提示生成 | ✅ 已实现（`cycleContext` 驱动） | `packages/engine/src/dialogue.ts` |
| 按钮标题超长自动降级 | ✅ 已实现 | `packages/engine/src/dialogue.ts` |
| 平台 capability 抽象 | ✅ 已实现 | `packages/im-core/src/index.ts` |
| Brief 链接消息生成 | ✅ 已实现（`generate_brief` + `briefUrl`） | `packages/engine/src/dialogue.ts` |
| 多选（multi_select）渲染 | ✅ 已实现 | `packages/engine/src/dialogue.ts` |
| 多语言支持（locale） | ✅ 已实现（en-GB / cy-GB） | `packages/engine/src/dialogue-locales/` |
| 模板消息生成 | ✅ 已实现（通过可选 `TemplateResolver` + `outOfSession`） | `packages/engine/src/dialogue.ts` |
| TurnManager / pending question 轮次管理 | ✅ 已实现 | `packages/engine/src/turn-manager.ts` |
| LLM 润色 | ✅ 已实现（含内存缓存、320 字符硬上限、`safety_response` 默认跳过） | `packages/engine/src/dialogue-llm-polish.ts` |
| A/B 对话风格应用 | ✅ 已实现（规则化 v1/v2） | `packages/engine/src/dialogue-styles.ts` |
| 平台无关模板 key 抽象 | ✅ 已实现 | `packages/im-core/src/index.ts` |
| 消息体长度截断 | ✅ 已实现（按 `PlatformCapability.maxBodyLength`） | `packages/engine/src/dialogue.ts` |
| L5 渲染追踪 | ✅ 已实现（`DialogueTrace` + `EngineTrace.dialogue`） | `packages/engine/src/types.ts`、`packages/engine/src/dialogue.ts` |
| L5 输入校验 / 错误兜底 | ✅ 已实现 | `packages/engine/src/dialogue.ts`、`packages/engine/src/engine.ts` |
| Question bank 统一 | ✅ 已实现 | `packages/engine/src/question-bank.ts` |

---

## 7. 已知限制与技术债

| ID | 描述 | 影响 | 建议修复 |
|---|---|---|---|
| L5-DEBT-001 | 按钮标签映射与 `planner.ts` 中 `CHECKIN_QUESTIONS` 重复定义 | 修改问题文案需改两处 | ✅ 已解决：新建 `packages/engine/src/question-bank.ts`，`planner.ts` 从中引用；标签仍由 `dialogue-locales` 按 locale 维护 |
| L5-DEBT-002 | `nighttime_symptoms` 和 `reliever_use` 各有 4 个选项，但 WhatsApp button 上限为 3 | 已自动降级为 `list`，E2E 已验证 | ✅ 已解决：L5 根据 `PlatformCapability.maxButtons` 自动降级为 `list`；新增 `four-option-list-fallback.json` E2E scenario 覆盖 |
| L5-DEBT-003 | L5 不使用 `conversationStyle` | A/B 实验的对话风格差异未落地 | ✅ 已解决：通过 `dialogue-styles.ts` + `renderMessage({ style })` 实现规则化 v1/v2；LLM polish 作为可选叠加 |
| L5-DEBT-004 | `generate_brief` action 被降级为普通文本 / engine.ts 直接突变 closing 文案 | 破坏 L5 单一职责 | 已解决：周期结束提示由 `cycleContext` 驱动；Brief 链接由 `generate_brief` + `briefUrl` 生成 |
| L5-DEBT-005 | 没有单元测试覆盖 `dialogue.ts` | 回归风险 | 补充 `packages/engine/src/dialogue.test.ts` |

---

## 8. 优化 backlog

以下优化项已在当前分支实现并验证，从 backlog 移除；相关实现位置见第 6 节“当前实现清单”。

| 原 ID | 内容 | 状态 |
|---|---|---|
| L5-OPT-001 | 4 选项按钮超限自动降级为 `list` | ✅ 已实现 |
| L5-OPT-002 | `scale` 量表渲染 | ✅ 已实现 |
| L5-OPT-003 | `multi_select` 多选渲染（list / 枚举文本） | ✅ 已实现 |
| L5-OPT-004 | `list` 类型直接输出 | ✅ 已实现 |
| L5-OPT-005 | 多语言 locale 渲染 | ✅ 已实现 |
| L5-OPT-006 | A/B 对话风格应用 | ✅ 已实现 |
| L5-OPT-007 | 可选 LLM 润色 | ✅ 已实现 |
| L5-OPT-008 | 模板消息生成 | ✅ 已实现 |

### L5-FOLLOW-001 `handleCheckInTrigger` L5 渲染错误兜底
- **目标**：定时触发路径也具备安全回退，避免调度消息丢失。
- **方案**：参照 `processInbound`，将 `handleCheckInTrigger` 中的 `renderMessage` 包在 `try/catch` 中。
- **状态**：✅ 已实现。实现位置：`packages/engine/src/engine.ts`。

### L5-FOLLOW-002 统一 question bank
- **目标**：消除 `planner.ts` 与 `dialogue.ts` 中问题标签的重复定义。
- **方案**：新建 `packages/engine/src/question-bank.ts`，集中管理问题文案、选项 ID 与可读标签，供 L4/L5 共同消费。
- **状态**：✅ 已实现。`planner.ts` 已引用 `question-bank.ts` 中的 `CHECKIN_QUESTIONS`。

### L5-FOLLOW-003 4 选项 list 降级端到端验证
- **目标**：在真实 E2E scenario 中验证 4 选项问题能正确以 list 形式发送并被回复。
- **方案**：在 scenario JSON 中加入 4 选项单选问题（如 `nighttime_symptoms`），断言最终消息类型为 `list`。
- **状态**：✅ 已实现。新增 `tests/scenarios/four-option-list-fallback.json` 与 `pnpm test:e2e:four-option-list`。

### L5-FOLLOW-004 Turn Manager 超限后 no_answer 对 Planner 可见
- **目标**：当用户连续 MAX_REPROMPTS 次未回答待问问题时，系统记录 `no_answer` observation 并继续下一题，而不是反复询问同一题。
- **方案**：将 `processInbound` 中 `recentObservations` 的获取移到 Turn Manager 逻辑之后，使 Turn Manager 写入的 `no_answer`（以及 LLM fallback 接受的答案）能被 L4 Planner 看到。
- **状态**：✅ 已实现。实现位置：`packages/engine/src/engine.ts`；E2E 覆盖：`tests/scenarios/turn-manager-max-reprompts.json`。

### L5-FOLLOW-005 Pending question 24h 静默超时
- **目标**：避免 pending question 长期悬而未决，导致 cycle 无法推进；同时在用户未回复时不发送打扰消息。
- **方案**：在 scheduler 新增 `scan-expired-pending` job，每 60s 扫描一次 `status="SENT"`、`sentAt <= now - 24h` 且 `pendingQuestion` 非空的 check-in；超时后记录 `subjective/{topic}=no_answer` observation，将 check-in 置为 `MISSED`，清空 pending，并写入 `state_updated` Event。
- **状态**：✅ 已实现。实现位置：`apps/api/src/services/scheduler.ts`；E2E 覆盖 `tests/scenarios/pending-question-timeout.json`。

### L5-FOLLOW-006 Pending question 12h gentle nudge
- **目标**：在 24h 超时前增加一次轻提醒，提升回复率。
- **方案**：在 scheduler 新增 `scan-pending-nudge` job，发送 gentle nudge 文本并更新 `CheckIn.nudgeSentAt`。
- **状态**：✅ 已实现。实现位置：`apps/api/src/services/scheduler.ts`；E2E 覆盖 `tests/scenarios/turn-manager-timeline.json`。

### L5-FOLLOW-007 Nudge / timeout 时间可配置化
- **目标**：让运营可以根据用户反馈调整 nudge 与 timeout 时间，无需改代码。
- **方案**：在 `apps/api/src/services/scheduler.ts` 中通过 `getNudgeAfterMs()` / `getPendingTimeoutMs()` 读取环境变量 `PENDING_QUESTION_NUDGE_AFTER_MS` / `PENDING_QUESTION_TIMEOUT_MS`，带默认值与非法值回退。
- **状态**：✅ 已实现。实现位置：`apps/api/src/services/scheduler.ts`；文档见 `.env.example` 与 `AGENTS.md` §7.6。

### L5-FOLLOW-008 Nudge 审计日志
- **目标**：使 turn manager 的每个关键动作都有 Event 审计记录。
- **方案**：`EventType` 新增 `nudge_sent`；`processPendingNudges` 发送 nudge 后写入 `nudge_sent` Event，payload 包含 `topic` 与 `nudgeAfterMs`。
- **状态**：✅ 已实现。实现位置：`packages/db/prisma/schema.prisma`、`apps/api/src/services/scheduler.ts`。

### L5-FOLLOW-009 MAX_REPROMPTS 可配置化
- **目标**：让运营可以调整答非所问时的重提示上限，无需改代码。
- **方案**：在 `packages/engine/src/turn-manager.ts` 中通过 `getMaxReprompts()` 读取环境变量 `PENDING_QUESTION_MAX_REPROMPTS`，默认 2 次，带非法值回退；`packages/engine/src/engine.ts` 使用 `getMaxReprompts()` 替代硬编码常量。
- **状态**：✅ 已实现。实现位置：`packages/engine/src/turn-manager.ts`、`packages/engine/src/engine.ts`；文档见 `.env.example` 与 `AGENTS.md` §7.6。

### L5-FOLLOW-010 Turn Manager 澄清请求处理
- **目标**：当用户请求澄清待回答问题时，系统解释问题并列出可选回复，且不将澄清请求计为一次答非所问的重提示。
- **方案**：在 `packages/engine/src/turn-manager.ts` 中新增 `looksLikeClarificationRequest()` 识别常见澄清短语（如 "What do you mean?" / "I don't understand" / "Can you explain?" 等），并通过 `buildClarificationMessage()` 生成解释消息；`packages/engine/src/engine.ts` 在重提示逻辑之前判断澄清意图，命中时发送解释消息且不增加 `repromptCount`。
- **状态**：✅ 已实现。实现位置：`packages/engine/src/turn-manager.ts`、`packages/engine/src/engine.ts`；单元测试：`packages/engine/src/turn-manager.test.ts`；E2E 覆盖：`tests/scenarios/turn-manager-clarification.json`。

### L5-FOLLOW-012 Turn Manager 返回上一题处理
- **目标**：当用户希望返回并修改上一题答案时，系统能够从问题历史中提取上一题并重新询问。
- **方案**：在 `CheckIn` 模型新增 `questionHistory` 字段；`setPendingQuestion()` 在设置新 pending question 前将当前 pending question 追加到历史；`packages/engine/src/turn-manager.ts` 新增 `looksLikeGoBackRequest()` 识别返回短语（如 "go back" / "previous question" / "I want to change my answer" 等），`goBackToPreviousQuestion()` 从历史尾部弹出上一题并设为 pending，`buildPreviousQuestionMessage()` 渲染 "Going back:" 前缀的重新提问消息；`packages/engine/src/engine.ts` 在跳过判断之后、重提示之前处理返回意图。
- **状态**：✅ 已实现。实现位置：`packages/db/prisma/schema.prisma`、`packages/engine/src/turn-manager.ts`、`packages/engine/src/engine.ts`；单元测试：`packages/engine/src/turn-manager.test.ts`；E2E 覆盖：`tests/scenarios/turn-manager-go-back.json`。

---

## 9. 测试策略

### 9.1 单元测试（建议新增 `packages/engine/src/dialogue.test.ts`）

覆盖场景：

| 用例 | 输入 | 期望输出 |
|---|---|---|
| safety_response | `type: "safety_response"` | `content.type === "text"`, `priority: "urgent"` |
| end_session | `type: "end_session"` | `content.type === "text"`, `priority: "normal"` |
| ask_single_choice | `type: "ask"`, `expectedResponseType: "single_choice"`, 4 options | `content.type === "buttons"`, 4 个按钮且标题正确 |
| ask_text | `type: "ask"`, `expectedResponseType: "text"` | `content.type === "text"` |
| unknown_topic_labels | topic 不在映射表中 | 按钮标题回退到 options ID |
| invalid_options_count | options > 3 | 抛出明确错误或自动降级为 list |

### 9.2 集成测试

- 端到端 scenario 验证按钮消息能被 WhatsApp Adapter 正确转换。
- 验证 4 选项问题在实际（或模拟）WhatsApp payload 中不超限。

---

## 10. 变更日志

| 日期 | 版本 | 变更内容 | 作者 |
|---|---|---|---|---|


| 2026-07-11 | v1.17 | Turn Manager 文档同步 v2：记录 `PENDING_QUESTION_MAX_REPROMPTS` 可配置化，补充 L5-FOLLOW-009 | AI Agent |
| 2026-07-11 | v1.16 | Turn Manager 文档同步：新增 12h gentle nudge、nudge_sent 审计日志、nudge/timeout 时间可配置化说明；补充 L5-FOLLOW-004 至 L5-FOLLOW-008 | AI Agent |
| 2026-07-11 | v1.15 | Turn Manager / Planner 协同修复：将 `recentObservations` 获取移到 Turn Manager 之后，使 `no_answer` observation 对 Planner 可见；新增 `turn-manager-max-reprompts` E2E scenario 验证超限后跳到下一题；新增 pending question 24h 静默超时流程说明，记录 `scan-expired-pending` scheduler job、超时 observation/state_updated Event 语义；补充 L5-FOLLOW-004/005 实现状态 | AI Agent |
| 2026-07-11 | v1.14 | L5 边界治理与可观测性：新增 `DialogueTrace` 与 `EngineTrace.dialogue`，`renderMessage` 支持 `onRenderTrace` 回调；增加 `validatePlannerOutput` 输入校验；`processInbound` 对 L5 渲染错误做安全兜底回退 | AI Agent |
| 2026-07-11 | v1.13 | L5 润色层加固：LLM polish 增加内存缓存（5 min TTL）、320 字符输出硬上限、`safety_response` 默认跳过 polish；`OutboundMessage` 模板字段从 `templateName` 改为平台无关 `templateKey`；`PlatformCapability` 新增 `maxBodyLength`，L5 按能力截断模板 body | AI Agent |
| 2026-07-11 | v1.12 | TurnManager 智能答案检测：`dialogue-locales` 新增 `optionSynonyms` / `scaleWordMap`，支持同义词、scale 文字、自然语言多选匹配；新增 `isAnswerRelevantWithLlm()` 作为 LLM fallback | AI Agent |
| 2026-07-11 | v1.11 | TurnManager 加固：`CheckIn` 新增 `pendingQuestion` / `repromptCount`，引入 `MAX_REPROMPTS=2`、重提示文案按次数变化、超限 fallback 到 `no_answer` observation，新增 `turn_reprompt` Event 类型 | AI Agent |
| 2026-07-11 | v1.10 | 实现 TurnManager / pending question 轮次管理：`packages/engine/src/turn-manager.ts` 负责提取、读取、匹配与重提示待回答问题；`saveOutboundMessages` 持久化 `_pendingQuestion` 到 Event | AI Agent |
| 2026-07-11 | v1.9 | 实现 24h 窗口外 template 消息生成：`RenderOptions` 新增 `outOfSession` / `templateResolver` / `templateContext`，L5 自动序列化 buttons/list 并生成模板消息；`EngineContext` 支持注入 `TemplateResolver` | AI Agent |
| 2026-07-11 | v1.8 | 实现可选 LLM 润色层，`renderMessage` 支持 `enableLlmPolish` / `llmClient` / `onLlmCall`，新增 `packages/engine/src/dialogue-llm-polish.ts` 与单元测试 | AI Agent |
| 2026-07-11 | v1.7 | 实现多语言 locale 基础设施，支持 `en-GB` / `cy-GB`，`renderMessage` 新增 `locale` 参数 | AI Agent |
| 2026-07-11 | v1.6 | 实现 `multi_select` 多选渲染（list / 枚举文本 + "Reply with all that apply"） | AI Agent |
| 2026-07-11 | v1.5 | 实现 `generate_brief` 消息渲染，check-in 结束后自动发送带 Brief 链接的 follow-up 消息 | AI Agent |
| 2026-07-11 | v1.4 | 将周期结束提示从 `engine.ts` 迁移到 L5，新增 `CycleContext` 驱动 `end_session` 文案，消除消息突变 | AI Agent |
| 2026-07-11 | v1.3 | 实现 A/B conversationStyle 规则化应用（v1/v2），`renderMessage` 支持 `style` 参数，新增 style 相关单元测试 | AI Agent |
| 2026-07-11 | v1.2 | 实现 PlatformCapability 抽象、4 选项自动降级 list、scale 量表渲染、按钮标题超长降级、新增 dialogue 单元测试 | AI Agent |
| 2026-07-11 | v1.1 | 补充 L4 实际输出类型、L5 通用职责、不经过 L5 的场景及流程速查图 | AI Agent |
| 2026-07-11 | v1.0 | 初稿：梳理 L5 接口、渲染矩阵、Adapter 映射、已知债务与优化 backlog | AI Agent |

---

## 11. 相关文档与代码

- 六层架构：`docs/sixlayers.html`
- 技术规格：`docs/tech-spec.md` §8 AI-native 引擎实现
- L5 实现：`packages/engine/src/dialogue.ts`
- L4 实现：`packages/engine/src/planner.ts`
- 类型定义：`packages/engine/src/types.ts`、`packages/im-core/src/index.ts`
- WhatsApp Adapter：`packages/im-whatsapp/src/index.ts`
- WhatsApp 模板：`packages/im-whatsapp/src/templates.ts`

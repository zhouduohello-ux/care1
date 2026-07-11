# CareMemory L5 对话层（Dialogue Layer）规格文档

> **文档编号**：SPEC-L5-001  
> **版本**：v1.3  
> **分支**：`feat/l5-dialogue-optimization`  
> **对应架构层**：L5 Dialogue  
> **上游**：L4 Planner | **下游**：L6 Safety、IM Adapter（WhatsApp）  
> **最后更新**：2026-07-11

---

## 1. 设计目标

L5 对话层负责把 L4 规划层产生的**结构化决策**（`PlannerOutput`）转换成**平台无关的出站消息**（`OutboundMessage`）。

核心原则：

1. **与平台解耦**：L5 不知道 WhatsApp、LINE 或 SMS 的具体 payload 格式。
2. **与 LLM 解耦**：MVP 中 L5 为纯规则渲染；未来可选接入 LLM 润色，但不得改变 `PlannerOutput` 的语义。
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
    templateName?: string;
    templateVariables?: Record<string, string>;
  };
}
```

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
| `ask` | `multi_select` | 渲染 list 或分步交互 | `list`（建议） | `normal` | ❌ 未实现 |
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

### 3.5 不经过 L5 的场景

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

### 4.3 代码调用点

- **用户入站**：`packages/engine/src/engine.ts:672`
  ```ts
  const outbound = renderMessage(userId, plannerOutput);
  ```
- **定时触发**：`packages/engine/src/engine.ts:876`
  ```ts
  const outbound = renderMessage(cycle.user.phoneNumber, plannerOutput);
  ```

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

虽然 `OutboundMessage` 支持 `templateName` / `templateVariables`，但当前 L5 **不会主动生成 `template` 类型消息**。模板选择逻辑在 `packages/im-whatsapp/src/templates.ts` 中，目前由 dispatch 层在 24h 会话窗口外时调用，不属于 L5 职责。

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
| 按钮标题超长自动降级 | ✅ 已实现 | `packages/engine/src/dialogue.ts` |
| 平台 capability 抽象 | ✅ 已实现 | `packages/im-core/src/index.ts` |
| 模板消息生成 | ❌ 未实现 | 当前由 dispatch 层负责 |
| 多语言支持 | ❌ 未实现 | 规划项 L5-OPT-005 |
| A/B 对话风格应用 | ✅ 已实现（规则化 v1/v2） | `packages/engine/src/dialogue-styles.ts` |
| LLM 润色 | ❌ 未实现 | 规划项 L5-OPT-007 |

---

## 7. 已知限制与技术债

| ID | 描述 | 影响 | 建议修复 |
|---|---|---|---|
| L5-DEBT-001 | 按钮标签映射与 `planner.ts` 中 `CHECKIN_QUESTIONS` 重复定义 | 修改问题文案需改两处 | 抽离到共享 question bank（如 `packages/engine/src/question-bank.ts`） |
| L5-DEBT-002 | `nighttime_symptoms` 和 `reliever_use` 各有 4 个选项，但 WhatsApp button 上限为 3 | 已自动降级为 `list`，但仍需端到端验证 | L5 已根据 `PlatformCapability.maxButtons` 自动降级；保留债务以提醒验证实际 WhatsApp payload |
| L5-DEBT-003 | L5 不使用 `conversationStyle` | A/B 实验的对话风格差异未落地 | 已通过 `dialogue-styles.ts` + `renderMessage({ style })` 实现规则化 v1/v2；未来可叠加 LLM polish |
| L5-DEBT-004 | `generate_brief` action 被降级为普通文本 | 无法直接附带 Brief 链接 | 结合 `webBaseUrl` 生成带 token 的链接消息 |
| L5-DEBT-005 | 没有单元测试覆盖 `dialogue.ts` | 回归风险 | 补充 `packages/engine/src/dialogue.test.ts` |

---

## 8. 优化 backlog

### L5-OPT-001 修复 4 选项按钮超限问题
- **目标**：确保所有单选问题在 WhatsApp 下可正常发送。
- **方案 A**：选项 > 3 时自动改用 `list` 类型。
- **方案 B**：拆分为两个连续问题（如先问“是否有症状”，再问程度）。
- **验收**：`packages/im-whatsapp/src/index.test.ts` 增加 4 选项 payload 测试。

### L5-OPT-002 支持 scale 量表渲染
- **目标**：当 `expectedResponseType === "scale"` 时渲染 1–5 分按钮。
- **方案**：生成 5 个按钮 `[1, 2, 3, 4, 5]`，两端加文字标签（如 1 = Mild, 5 = Severe）。

### L5-OPT-003 支持 multi_select 渲染
- **目标**：当 `expectedResponseType === "multi_select"` 时渲染 WhatsApp list 多选。
- **注意**：WhatsApp Cloud API 本身不原生支持多选，需要分两步：先 list 单选，再确认“还有吗”。

### L5-OPT-004 支持 list 类型输出
- **目标**：L5 可以直接输出 `content.type === "list"`。
- **场景**：选项 > 3 时的自动降级；复杂触发因素选择。

### L5-OPT-005 多语言渲染
- **目标**：根据 `user.locale` 输出对应语言。
- **方案**：维护 `packages/engine/src/dialogue-locales/` 下的文案映射表；默认 fallback 到 `en-GB`。

### L5-OPT-006 应用 A/B 对话风格
- **目标**：`conversationStyle === "v2"` 时使用更温暖、简短的措辞。
- **方案**：
  - 保守：仅对系统结束语/欢迎语做风格模板替换。
  - 激进：调用 LLM 在 L5 做 final polish（受配额限制）。

### L5-OPT-007 可选 LLM 润色
- **目标**：在保持语义不变的前提下，让机器消息更自然。
- **约束**：
  - 必须后接 L6 Safety 校验。
  - 必须记录 LLM 调用事件。
  - 配额耗尽时自动 fallback 到规则文本。

### L5-OPT-008 支持模板消息生成
- **目标**：L5 能够直接输出 `content.type === "template"`，供 dispatch 在 24h 窗口外使用。
- **依赖**：需要知道当前是否处于 24h 窗口外，该信息应通过 `conversationContext` 或外层判断传入。

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

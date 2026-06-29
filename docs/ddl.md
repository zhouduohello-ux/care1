# CareMemory DDL：L2 患者记忆层数据模型

> **版本**：v0.2  
> **日期**：2026-06-26  
> **依据文档**：PRD `docs/PRD.md` §6.2–6.5 / func-spec `docs/func-spec.md` §5 / tech-spec `docs/tech-spec.md` §5 / decisions `docs/decisions.md` D5, D7, D8  
> **实际实现**：`packages/db/prisma/schema.prisma`

---

## 架构总览

L2 患者记忆层采用**三层混合模型**（Decisions D5）：

```
Event Log（不可变事实来源）
    ↓ 规则/LLM 提取
Observations（半结构化观察记录）
    ↓ 聚合 + LLM 生成
Narrative Summaries / Disease Card / Brief（上游消费）
```

---

## 表：`users`

**func-spec §5.1 / tech-spec §5.1**

患者主体，由 onboarding 流程创建（engine.ts:159-165）。MVP 通过 WhatsApp 电话号码唯一识别。

| 字段 | 类型 | 文档依据 | 说明 |
|------|------|---------|------|
| `id` | `cuid` | — | 内部主键 |
| `phoneNumber` | `String @unique` | func-spec §5.1 `phoneNumber` | WhatsApp 绑定的电话号码，作为用户唯一标识（PRD §6.5） |
| `waId` | `String? @unique` | tech-spec §7.1 `channelId` | WhatsApp Business API 的 WA ID，用于消息路由 |
| `locale` | `String @default("en-GB")` | func-spec §5.1 `locale` | 语言区域，决定模板语言和显示格式 |
| `timezone` | `String @default("Europe/London")` | func-spec §5.1 `timezone` | 用户时区，影响 check-in 发送时间（func-spec §12.1） |
| `nickname` | `String?` | PRD §4.1 | onboarding 时用户可选的昵称 |
| `age` | `Int?` | open-boundaries B18 | onboarding 年龄验证，<18 拒绝使用 |
| `medications` | `Json?` | PRD §6.2 / open-boundaries B2 | 用药基线：`{ baseline: [{ name, type, schedule }] }` |
| `nextVisitAt` | `DateTime?` | PRD §4.1 | 下次复诊日期（可选） |
| `lastInboundAt` | `DateTime?` | — | 最后一次用户消息时间，用于会话窗口检测 |
| `sessionWindowExpiresAt` | `DateTime?` | tech-spec §7.4 | WhatsApp 24h 会话窗口过期时间 |
| `consentGiven` | `Boolean @default(false)` | func-spec §5.1 `consentGiven` | 用户是否同意隐私条款 |
| `consentAt` | `DateTime?` | func-spec §5.1 `consentAt` | 同意时间 |
| `consentVersion` | `String @default("v1")` | func-spec §5.1 `consentVersion` | 同意的隐私版本号 |
| `deletedAt` | `DateTime?` | PRD §6.5 / GDPR | 软删除标记（GDPR 被遗忘权） |

**关联文档**：
- func-spec §5.1 User interface
- PRD §4.1 Day 0 用户旅程
- PRD §6.5 用户管理（删除账户）
- open-boundaries B18 年龄验证
- decisions D5 三层混合模型

---

## 表：`cycles`

**func-spec §5.1 / PRD §3.2**

记录周期。MVP 支持 7天试用（TRIAL_7_DAY）和 4 周计划（PLAN_4_WEEK）。

| 字段 | 类型 | 文档依据 | 说明 |
|------|------|---------|------|
| `id` | `cuid` | — | 内部主键 |
| `userId` | `String` | func-spec §5.1 `userId` | 关联 User |
| `disease` | `String @default("asthma")` | func-spec §5.1 `disease` | 疾病 profile 标识，MVP 为 "asthma" |
| `type` | `TRIAL_7_DAY | PLAN_4_WEEK` | func-spec §5.1 `type` | 周期类型（PRD §3.2） |
| `status` | `ONBOARDING | ACTIVE | COMPLETED | CANCELLED` | func-spec §5.1 `status` | onboading → active → completed / cancelled |
| `startedAt` | `DateTime @default(now())` | func-spec §5.1 `startedAt` | 周期开始时间 |
| `endedAt` | `DateTime?` | func-spec §5.1 `endedAt` | 周期结束时间（COMPLETED 或 CANCELLED 时设置） |
| `nextCheckinAt` | `DateTime?` | func-spec §5.1 `nextCheckinAt` | 下次 check-in 调度时间，由 scheduler 设置 |

**关联文档**：
- PRD §3.2 记录周期（7天试用 / 4周计划 / 真实复诊周期）
- func-spec §5.1 Cycle interface
- PRD §4.5 转化（7天→4周计划）

---

## 表：`check_ins`

**func-spec §5.1 / func-spec §6.3 / decisions D6, D7**

每次主动 check-in 会话。Planner 在 check-in 中设定 session objective，每答一题重新规划（decisions D6）。常规预算 3 题，异常可覆盖（decisions D7）。

| 字段 | 类型 | 文档依据 | 说明 |
|------|------|---------|------|
| `id` | `cuid` | — | 内部主键 |
| `cycleId` | `String` | func-spec §5.1 `cycleId` | 所属周期 |
| `scheduledAt` | `DateTime` | func-spec §5.1 `scheduledAt` | 计划发送时间（由 scheduler 设定） |
| `sentAt` | `DateTime?` | func-spec §5.1 `sentAt` | 实际发送时间 |
| `completedAt` | `DateTime?` | func-spec §5.1 `completedAt` | 完成时间（所有问题答完或异常结束） |
| `status` | `SCHEDULED | SENT | COMPLETED | MISSED | EXCEPTION` | func-spec §5.1 `status` | check-in 生命周期状态 |
| `sessionObjective` | `String?` | func-spec §5.1 `sessionObjective` / decisions D6 | Planner 设定的本次会话目标 |
| `questionsAsked` | `Int @default(0)` | decisions D6 | 本次已问问题数 |
| `budgetRemaining` | `Int @default(3)` | decisions D7 | 剩余问题预算，默认 3 题 |
| `inExceptionMode` | `Boolean @default(false)` | func-spec §12.3 | 是否进入异常模式 |
| `exceptionQuestionsAsked` | `Int @default(0)` | func-spec §12.3 | 异常模式下已追问次数 |
| `reminderSentAt` | `DateTime?` | func-spec §7.4 | 24h 提醒模板发送时间 |

**关联文档**：
- decisions D6 Session Objective + Per-turn Re-planning
- decisions D7 3 题预算 + 异常覆盖
- func-spec §6.3 Session Objective + Per-turn Re-planning
- func-spec §12.3 异常流程
- func-spec §7.4 轮次管理（提醒/超时）

---

## 表：`events` — **核心资产：不可变事件日志**

**func-spec §5.1 / decisions D5**

系统唯一的**事实来源**，不可变，用于审计、调试和状态恢复。所有入站消息、出站消息、LLM 调用、状态变更都记录在此。

| 字段 | 类型 | 文档依据 | 说明 |
|------|------|---------|------|
| `id` | `cuid` | func-spec §5.1 `eventId` | 内部主键 |
| `userId` | `String` | func-spec §5.1 `userId` | 关联 User |
| `cycleId` | `String?` | func-spec §5.1 `cycleId` | 关联 Cycle（可能为空，如未开始周期时） |
| `checkInId` | `String?` | — | 关联 CheckIn |
| `timestamp` | `DateTime @default(now())` | func-spec §5.1 `timestamp` | 事件发生时间 |
| `type` | `EventType`（见下方） | func-spec §5.1 `type` | 事件类型 |
| `payload` | `Json` | func-spec §5.1 `payload` | 事件数据体 |
| `platformMessageId` | `String?` | func-spec §5.1 `platformMessageId` | 平台消息 ID，用于入站去重（engine.ts 幂等性） |
| `traceId` | `String?` | — | 追踪 ID，关联 LLM 调用链 |
| `idempotencyKey` | `String? @unique` | tech-spec §8 / open-boundaries B15 | 出站消息幂等性 key，防止重复发送 |
| `llmModel` | `String?` | — | LLM 调用时的模型名 |
| `llmInput` | `Json?` | — | LLM 调用时的 prompt（审计） |
| `llmOutput` | `Json?` | — | LLM 调用时的 response（审计） |
| `tokenUsage` | `Json?` | — | LLM token 用量: `{ prompt, completion, total }` |

**EventType 枚举**（`schema.prisma:104-115`）：

| 值 | 说明 |
|----|------|
| `inbound_message` | 用户入站消息 |
| `outbound_message` | 系统出站消息 |
| `observation_extracted` | 从消息中提取 observation |
| `state_updated` | 系统状态变更 |
| `llm_call` | LLM API 调用（含审计日志） |
| `safety_check` | 安全层校验记录 |
| `checkin_scheduled` | Check-in 被调度 |
| `checkin_sent` | Check-in 消息已发送 |
| `checkin_completed` | Check-in 已完成 |
| `user_action` | 用户主动操作（如 DELETE MY DATA） |

**关联文档**：
- decisions D5：Event Log 是唯一事实来源，不可变，用于审计
- func-spec §5.1 Event interface
- tech-spec §5.1 / tech-spec §8 崩溃恢复
- tech-spec §6.3 LLM 调用日志保留 12 个月
- open-boundaries B15 崩溃恢复
- PRD §9 合规红线：可审计

---

## 表：`observations`

**func-spec §5.1 / func-spec §5.2 / decisions D5**

从 Event 中由规则或 LLM 提取的半结构化观察记录。Observation 是 Disease Card 和 Brief 的原始数据来源。

| 字段 | 类型 | 文档依据 | 说明 |
|------|------|---------|------|
| `id` | `cuid` | func-spec §5.1 `observationId` | 内部主键 |
| `userId` | `String` | func-spec §5.1 `userId` | 关联 User |
| `cycleId` | `String` | func-spec §5.1 `cycleId` | 关联 Cycle |
| `eventId` | `String` | func-spec §5.1 `sourceEventId` | 来源 Event（追溯原始消息） |
| `timestamp` | `DateTime @default(now())` | func-spec §5.1 `timestamp` | 观察发生时间 |
| `category` | `ObservationCategory`（见下方） | func-spec §5.1 `category` | 观察类别 |
| `concept` | `String` | func-spec §5.1 `concept` | 自然语言或标准医学概念，如 `"nighttime_symptoms"`、`"reliever_use"` |
| `value` | `Json` | func-spec §5.1 `value` | 观察值：量表值、选项、文本等 |
| `attributes` | `Json?` | func-spec §5.1 `attributes` / func-spec §5.2 | 额外属性：`{ frequency, severity, duration }` |
| `confidence` | `Float @default(1.0)` | func-spec §5.1 `confidence` | 置信度 |
| `extractedBy` | `String @default("rule")` | func-spec §5.1 `extractedBy` | 提取方式：`"rule"` 或 `"llm"` |
| `supersededById` | `String?` | open-boundaries B4 / engine.ts | 被哪个新 observation 替代（用户修正历史） |
| `superseded` | `Boolean @default(false)` | open-boundaries B4 | 是否已被替代 |

**ObservationCategory 枚举**（`schema.prisma:143-153`）：

| 值 | 说明 | 示例（func-spec §5.2） |
|----|------|----------------------|
| `symptom` | 症状 | nighttime_cough, breathlessness |
| `medication` | 用药 | reliever_use, controller_adherence |
| `trigger` | 诱因/暴露 | pollen, dust, exercise |
| `function` | 功能/活动 | activity_limitation |
| `adverse_event` | 不良反应 | rash, swelling, side_effect |
| `subjective` | 主观感受 | feeling_worse, free_text_response |
| `question` | 患者想问医生的问题 | open_question |
| `system_intent` | 系统命令意图 | start_asthma, consent_given |
| `profile` | 用户画像 | age, nickname |

**关联文档**：
- decisions D5：Observations 是 LLM/规则从事件中提取的半结构化记录
- func-spec §5.1 Observation interface
- func-spec §5.2 Observation 示例
- open-boundaries B4 用户修正历史（superseded 机制）
- PRD §6.2 采集内容维度

---

## 表：`narrative_summaries`

**func-spec §5.1 / decisions D5**

LLM 生成的自然语言摘要，分三级粒度。

| 字段 | 类型 | 文档依据 | 说明 |
|------|------|---------|------|
| `id` | `cuid` | func-spec §5.1 `summaryId` | 内部主键 |
| `userId` | `String` | func-spec §5.1 `userId` | 关联 User |
| `cycleId` | `String?` | func-spec §5.1 `cycleId` | 关联 Cycle（可为空，如 longitudinal 摘要） |
| `scope` | `session | cycle | longitudinal` | func-spec §5.1 `scope` | 摘要粒度 |
| `generatedAt` | `DateTime @default(now())` | func-spec §5.1 `generatedAt` | 生成时间 |
| `content` | `String` | func-spec §5.1 `content` | LLM 生成的叙事内容 |
| `keyObservationIds` | `String[]` | func-spec §5.1 `keyObservations` | 引用的 Observation IDs |
| `model` | `String?` | — | 生成摘要使用的 LLM 模型名 |

**关联文档**：
- decisions D5：Narrative Summaries 是 LLM 生成的自然语言摘要，分三级
- func-spec §5.1 NarrativeSummary interface
- tech-spec §6.1：Narrative Summary 推荐使用 GPT-4o-mini

---

## 表：`disease_cards`

**func-spec §9 / PRD §6.3**

患者的长期疾病肖像，持续更新，患者主看。

| 字段 | 类型 | 文档依据 | 说明 |
|------|------|---------|------|
| `id` | `cuid` | — | 内部主键 |
| `userId` | `String` | — | 关联 User |
| `cycleId` | `String?` | — | 关联 Cycle |
| `disease` | `String` | — | 疾病 profile 标识 |
| `version` | `Int @default(1)` | func-spec §5.1 `version` | 版本号，每次更新 +1 |
| `generatedAt` | `DateTime @default(now())` | func-spec §5.1 `generatedAt` | 生成时间 |
| `modules` | `Json` | func-spec §9.2 | 模块化卡片内容：headline, control_status, symptom_trend... |
| `rawSummary` | `String` | — | 底层原始摘要文本 |
| `model` | `String?` | — | 生成使用的 LLM 模型 |
| `accessToken` | `String? @unique` | open-boundaries B8 / func-spec §15.1 | 访问令牌，用于 Web 页面授权 |
| `expiresAt` | `DateTime?` | open-boundaries B8 | 令牌过期时间 |

**模块清单**（func-spec §9.2）：

| 模块 | MVP 7天版本 | 4周+版本 |
|------|-------------|---------|
| Summary | 一句话摘要 | 长期趋势摘要 |
| Control Status | 控制状态标签 | 历史趋势 |
| Symptom Trend | 症状趋势 | 跨周期洞察 |
| Adherence | 简单计数 | 趋势与模式 |
| Adverse Events | 列表 | 时间线 |
| Subjective Changes | 文本摘要 | 趋势 |
| Trigger/Exposure Pattern | 频率统计 | 关联分析 |
| Open Questions | 列表 | 按紧迫性排序 |
| Safety Notice | 固定显示 | 固定显示 |

**关联文档**：
- decisions D12：Disease Card 是核心资产，Brief 是其 visit-prep 导出
- decisions D13：不做临床量表推断
- func-spec §9 Disease Card 规范
- PRD §6.3 Disease Card
- open-boundaries B8 访问控制

---

## 表：`briefs`

**func-spec §10 / decisions D12**

从 Disease Card 截取并编排生成的一页式复诊摘要，医生主看。

| 字段 | 类型 | 文档依据 | 说明 |
|------|------|---------|------|
| `id` | `cuid` | — | 内部主键 |
| `cycleId` | `String @unique` | func-spec §5.1 `cycleId` | 每个 cycle 最多一个 Brief |
| `diseaseCardId` | `String?` | func-spec §5.1 `diseaseCardId` | 来源 Disease Card |
| `webUrl` | `String` | — | Web 页面 URL |
| `pdfUrl` | `String?` | — | PDF 下载 URL |
| `accessToken` | `String @unique` | func-spec §5.1 `accessToken` | 安全令牌，7天有效 |
| `expiresAt` | `DateTime` | func-spec §5.1 `expiresAt` | 令牌过期时间 |
| `generatedAt` | `DateTime @default(now())` | func-spec §5.1 `generatedAt` | 生成时间 |

**关联文档**：
- decisions D12：Brief 是 Disease Card 的 visit-prep 导出，医生主看
- func-spec §10 Brief 生成规范
- PRD §4.4 / §6.4

---

## 数据更新流程

```
用户输入
    ↓
L1 感知层  ──►  Event（inbound_message）
    ↓
提取 Observation  ──►  Event（observation_extracted）
    ↓
写入 Observation 表
    ↓
L4 Planner  ──►  Event（llm_call）
    ↓
L5 Dialogue  ──►  Event（outbound_message）
    ↓
L6 Safety  ──►  Event（safety_check）
    ↓
异步更新 Narrative Summary（future）
    ↓
周期结束 → 更新 Disease Card
    ↓
用户请求 → 生成 Brief
```

**数据流来源**：
- func-spec §5.3 数据更新流程
- decisions D5 三层混合模型
- PRD §5.1 六层引擎

---

## 索引策略

| 表 | 索引 | 用途 |
|----|------|------|
| `users` | `phoneNumber` | 按电话号码查找用户（engine.ts 入站处理） |
| `cycles` | `userId`, `(status, nextCheckinAt)` | 按用户查活跃周期；调度器查待发送 check-in |
| `check_ins` | `cycleId`, `(status, scheduledAt)` | 按周期查 check-in；调度器查待发送/提醒 |
| `events` | `(userId, timestamp)`, `(cycleId, timestamp)`, `(type, timestamp)`, `platformMessageId` | 审计追踪；去重 |
| `observations` | `(userId, cycleId)`, `(category, concept)`, `timestamp`, `supersededById` | 按周期聚合；按类别查询；用户修正 |
| `narrative_summaries` | `(userId, cycleId)`, `(scope, generatedAt)` | 按范围查最新摘要 |
| `disease_cards` | `userId`, `cycleId`, `accessToken` | 访问控制 |
| `briefs` | `accessToken` | 安全令牌查询 |

---

## 与六层引擎的对应关系

| 引擎层 | 读哪些表 | 写哪些表 |
|--------|---------|---------|
| L1 感知层 | — | Event（inbound_message + observation_extracted）|
| L2 记忆层 | 所有表 | Observation, NarrativeSummary |
| L3 策略库 | RAG Corpus（不在数据库内） | — |
| L4 Planner | Observation, CheckIn | Event（llm_call）, CheckIn |
| L5 对话层 | — | Event（outbound_message）|
| L6 安全层 | — | Event（safety_check）|
| Disease Card | Observation, NarrativeSummary | DiseaseCard, Brief |

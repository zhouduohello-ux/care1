# CareMemory Functional Specification

> **版本**：v0.2 — AI-native 架构草案  
> **日期**：2026-06-15  
> **对应 PRD**：`docs/PRD.md`  
> **对应 Tech Spec**：`docs/tech-spec.md`  
> **范围**：英国 × 哮喘 × WhatsApp，架构支持多病种/多平台

---

## 1. 文档说明

本文档定义 CareMemory MVP 的**具体功能行为、数据模型、架构接口和边界处理**。开发团队应以本文档为基准实现功能、编写测试和验收。

与 v0.1 的关键变化：
- 从硬编码问卷升级为 AI-native 六层决策引擎；
- Disease Card 成为核心资产，Brief 是其 visit-prep 导出；
- 引入 RAG Corpus 作为疾病管理策略库；
- 引入 IM Adapter 兼容未来多平台；
- 明确 3 题预算、异常覆盖、24 小时窗口等规则。

---

## 2. 架构总览

### 2.1 六层引擎

```
┌─────────────────────────────────────────────────────────────┐
│  L6 安全/合规层 (Safety & Compliance)                         │
│  - 校验 LLM 输出                                              │
│  - 拦截越界医疗建议                                           │
│  - 追加急救/安全提示                                          │
├─────────────────────────────────────────────────────────────┤
│  L5 对话层 (Dialogue)                                         │
│  - 把 Planner 意图渲染为平台消息                               │
│  - 管理轮次、交互形态、24h 窗口                                │
├─────────────────────────────────────────────────────────────┤
│  L4 规划层 (Planner)                                          │
│  - 决定当前推进哪个疾病片段                                    │
│  - Session Objective + Per-turn Re-planning                   │
├─────────────────────────────────────────────────────────────┤
│  L3 策略库层 (RAG Corpus)                                     │
│  - Medical KB / Care Strategy / Conversation Patterns         │
│  - Safety Rules                                               │
├─────────────────────────────────────────────────────────────┤
│  L2 患者记忆层 (Patient Memory)                               │
│  - Event Log / Observations / Narrative Summaries             │
│  - Disease Card                                               │
├─────────────────────────────────────────────────────────────┤
│  L1 感知层 (Perception)                                       │
│  - 解析用户输入                                               │
│  - 提取信号、意图、异常                                        │
├─────────────────────────────────────────────────────────────┤
│  IM Adapter (WhatsApp / LINE / ...)                           │
│  - 平台 webhook 接入                                          │
│  - 平台无关消息模型转换                                        │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 关键设计原则

1. **引擎与平台解耦**：引擎只处理平台无关的事件和消息。
2. **引擎与疾病解耦**：引擎通过 Disease Profile + RAG Corpus 加载疾病特定知识。
3. **LLM 运行时推理 + 验证器把关**：Planner 和 Dialogue 由 LLM 驱动，但所有输出经过安全/合规校验。
4. **患者记忆是核心资产**：Event log 是唯一事实来源，Disease Card 是持续更新的疾病肖像。

---

## 3. 分层引擎详细设计

### 3.1 L1 感知层

**输入**：原始用户消息（平台无关格式）+ 当前会话上下文

**输出**：
```typescript
interface PerceptionResult {
  messageId: string;
  timestamp: Date;
  intent: {
    primary: "answer" | "initiate" | "adverse_event" | "help" | "stop" | ...;
    confidence: number;
  };
  extractedObservations: Observation[];  // 见 5.2
  anomalies: Anomaly[];                  // 异常标记
  safetyFlags: SafetyFlag[];             // 安全标记
  rawText: string;
}
```

**关键行为**：
- 按钮回复直接映射为 observation；
- 自由文本由 LLM + RAG 提取 observation；
- 检测 STOP / HELP / DELETE MY DATA 等系统指令；
- 标记与管理规则不一致、异常反馈、不良反应等。

### 3.2 L2 患者记忆层

见第 5 节。

### 3.3 L3 策略库层（RAG Corpus）

见第 4 节。

### 3.4 L4 规划层（Planner）

见第 6 节。

### 3.5 L5 对话层

见第 7 节。

### 3.6 L6 安全/合规层

**输入**：待发送消息 + patient context + 疾病类型

**输出**：
```typescript
interface SafetyResult {
  approved: boolean;
  rewrittenMessage?: string;      // 如需改写
  requiredAddendums: string[];    // 必须追加的安全提示
  riskLevel: "none" | "low" | "medium" | "high";
  blockReason?: string;
}
```

**关键规则**：
- 禁止输出诊断结论（如「你哮喘发作了」）；
- 禁止输出治疗建议（如「你应该加药」）；
- 高风险信号必须追加标准急救提示；
- 所有 outbound 医学相关内容必须附带免责声明或指向 Disease Card；
- 哮喘相关内容默认附带：「If you're having severe breathing problems, call 999 or follow your asthma action plan.」

---

## 4. RAG Corpus 设计

### 4.1 Corpus 分层

| Corpus | 内容 | 检索触发 | 维护方式 |
|--------|------|----------|----------|
| **Medical Knowledge Base** | 疾病管理知识、症状识别、安全边界 | 感知层理解输入 / 生成解释 | 内部整理 + 外部权威来源引用 |
| **Care Strategy Library** | 疾病随访策略、该探查什么、不同信号下如何决策 | Planner 决策 | 产品 + 医学顾问共同维护 |
| **Conversation Pattern Library** | 高质量问题、追问、回复示例 | 对话层生成消息 | 产品团队维护，LLM 辅助扩写 |
| **Safety Rules** | 禁止表述、必须提示、风险场景 | 安全/合规层校验 | 医学顾问 + 法务审核 |

### 4.2 Disease Profile

每个疾病对应一个 RAG 文档包，不是 JSON 配置：

```
diseases/
  asthma/
    medical-overview.md
    care-strategy.md
    conversation-patterns.md
    safety-rules.md
  ibd/
    ...
```

### 4.3 检索路由

- 感知层根据用户输入语义检索 Medical KB；
- Planner 根据患者状态检索 Care Strategy Library；
- 对话层根据意图检索 Conversation Patterns；
- 安全层根据输出内容检索 Safety Rules。

---

## 5. 患者记忆层数据模型

### 5.1 核心实体

```typescript
// 用户
interface User {
  userId: string;
  phoneNumber: string;
  platformId?: string;          // 如 WhatsApp ID
  locale: string;               // 默认 en-GB
  timezone: string;             // 默认 Europe/London
  consentGiven: boolean;
  consentAt?: Date;
  consentVersion: string;
  createdAt: Date;
}

// 记录周期（7 天试用或 4 周计划）
interface Cycle {
  cycleId: string;
  userId: string;
  disease: string;              // 本周期对应的疾病 profile，默认 asthma
  type: "trial_7_day" | "plan_4_week";
  status: "onboarding" | "active" | "completed" | "cancelled";
  startedAt: Date;
  endedAt?: Date;
  nextCheckinAt?: Date;
}

// 每次检查点 / 会话
interface CheckIn {
  checkInId: string;
  cycleId: string;
  scheduledAt: Date;
  sentAt?: Date;
  completedAt?: Date;
  status: "scheduled" | "sent" | "completed" | "missed" | "exception";
  sessionObjective?: string;
}

// 不可变事件日志
interface Event {
  eventId: string;
  userId: string;
  cycleId: string;
  timestamp: Date;
  type: "inbound_message" | "outbound_message" | "observation_extracted" | "state_updated" | "llm_call" | "safety_check";
  payload: any;
  platformMessageId?: string;  // 用于去重
}

// 观察记录（半结构化）
interface Observation {
  observationId: string;
  userId: string;
  cycleId: string;
  timestamp: Date;
  sourceEventId: string;
  category: "symptom" | "medication" | "trigger" | "function" | "adverse_event" | "subjective" | "question" | ...;
  concept: string;              // 自然语言或标准医学概念
  value: any;                   // 量表值、选项、文本等
  attributes: Record<string, any>; // severity, frequency, duration, etc.
  confidence: number;
  extractedBy: "rule" | "llm";
}

// 叙事摘要（LLM 生成）
interface NarrativeSummary {
  summaryId: string;
  userId: string;
  cycleId: string;
  scope: "session" | "cycle" | "longitudinal";
  generatedAt: Date;
  content: string;              // LLM 生成的自然语言摘要
  keyObservations: string[];    // 引用的 observation IDs
}

// 疾病卡片
interface DiseaseCard {
  cardId: string;
  userId: string;
  disease: string;
  generatedAt: Date;
  version: number;
  modules: DiseaseCardModule[]; // 见 9.2
}

// Brief
interface Brief {
  briefId: string;
  cycleId: string;
  diseaseCardId?: string;
  accessToken: string;
  expiresAt: Date;
  generatedAt: Date;
}
```

### 5.2 Observation 示例

```json
{
  "observationId": "obs_123",
  "category": "symptom",
  "concept": "nighttime_cough",
  "value": "mild",
  "attributes": {
    "frequency": "2_nights",
    "sleepImpact": false
  },
  "confidence": 1.0,
  "extractedBy": "rule"
}
```

### 5.3 数据更新流程

1. 用户输入 → L1 提取 Observation；
2. Observation 写入 Event Log；
3. 异步触发 Narrative Summary 更新；
4. 周期结束时触发 Disease Card 更新；
5. 所有更新保留版本历史。

---

## 6. Planner 设计

### 6.1 输入

```typescript
interface PlannerInput {
  patientContext: {
    disease: string;
    cycleId: string;
    cycleDay: number;
    narrativeSummary: string;
    recentObservations: Observation[];
    openIssues: string[];
    upcomingVisitDays?: number;
  };
  conversationContext: {
    currentIntent: string;
    intentStack: string[];
    questionsAskedThisSession: number;
    budgetRemaining: number;
    lastUserMessage?: string;
    inExceptionMode: boolean;
  };
  temporalContext: {
    localTime: string;
    season?: string;
    dayOfWeek: string;
  };
  retrievedKnowledge: {
    careStrategy: string[];
    medicalKb: string[];
    patterns: string[];
  };
}
```

### 6.2 输出

```typescript
interface PlannerOutput {
  reasoning: string;
  sessionObjective: string;
  nextAction: {
    type: "ask" | "inform" | "remind" | "safety_response" | "generate_brief" | "end_session";
    topic: string;
    purpose: string;
    expectedResponseType?: "single_choice" | "scale" | "multi_select" | "text";
    options?: string[];
    budgetCost: number;
  };
  alternativeActions?: PlannerOutput["nextAction"][];
  safetyFlag: "none" | "low" | "medium" | "high";
  updatePatientState: {
    newObservations?: Observation[];
    updateNarrative?: boolean;
    addOpenIssue?: string;
    resolveOpenIssue?: string;
  };
}
```

### 6.3 Session Objective + Per-turn Re-planning

- check-in 开始时，Planner 设定 session objective；
- 每收到一个回答后重新调用 Planner；
- Planner 可继续原 objective、更新 objective、或进入 exception mode；
- objective 变更必须显式记录。

### 6.4 预算管理

- 常规 check-in：最多 3 个问题；
- 异常覆盖条件：
  - 与管理规则不一致的回答
  - 异常反馈（如严重症状）
  - 不良反应报告
  - 复合信号冲突
  - 患者主动求助
- 异常模式下最多追加 2–3 个问题；
- 安全响应最高优先级，可清空当天 budget。

---

## 7. 对话层设计

### 7.1 输入

PlannerOutput + conversation history + platform capabilities。

### 7.2 输出

```typescript
interface OutboundMessage {
  userId: string;
  conversationContext: {
    requiresSession: boolean;
    priority: "normal" | "urgent";
  };
  content: {
    type: "text" | "buttons" | "list" | "template";
    text: string;
    buttons?: Array<{ id: string; title: string }>; // WhatsApp max 3, title ≤20 chars
    list?: Array<{ id: string; title: string; description?: string }>; // max 10
    templateKey?: string;      // 24h 外使用，平台无关 key，由 IM adapter 映射为真实模板名
    templateVariables?: Record<string, string>;
  };
}
```

### 7.3 渲染策略

- LLM 根据意图生成自然语言消息；
- Formatter 校验平台限制；
- 24h 会话窗口内使用自由生成消息；
- 24h 外使用预审批模板。

### 7.4 轮次管理

- 记录当前 pending question ID 和期望回答类型；
- 用户回答不匹配时，最多澄清 1 次，然后接受自由文本；
- 用户 24h 内未回复，发送提醒模板；
- 用户 24h 外回复，开启新会话但保留历史上下文。

---

## 8. IM 适配层

### 8.1 平台无关消息模型

见 7.2 和 3.1 中的 InboundMessage / OutboundMessage。

### 8.2 Adapter 职责

- 入站：平台 webhook → InboundMessage；
- 出站：OutboundMessage → 平台 API payload；
- 会话窗口检测；
- 模板管理；
- 消息去重（基于 platform message ID）。

### 8.3 WhatsApp 适配器（MVP）

- 支持 text、interactive buttons、interactive list；
- 支持 24h 内自由消息；
- 预准备模板：welcome、reminder、brief_ready、stop_confirm。

### 8.4 未来扩展

- LINE Adapter：rich menu、quick reply、flex message；
- SMS Adapter：纯文本；
- 新平台只需新增 Adapter，引擎不变。

---

## 9. Disease Card 规范

### 9.1 定位

- 患者的长期疾病肖像，持续更新；
- 不是临床诊断工具，不输出临床量表分数；
- 聚焦患者报告的行为、感受、事件和模式。

### 9.2 信息架构（模块化模板 + LLM 生成内容）

| 模块 | 内容 | MVP 7 天版本 | 4 周+ 版本 |
|------|------|-------------|-----------|
| **Headline** | 一句话总结当前状态 | 7 天摘要 | 长期趋势摘要 |
| **Control/Status** | 控制/状态标签 | 基于 7 天数据 | 基于 1–3 个月数据 |
| **Adherence** | 用药/行动计划依从性 | 简单计数 | 趋势与模式 |
| **Symptom-Treatment Relationship** | 治疗与症状的关联 | 初步观察 | 跨周期洞察 |
| **Adverse Events** | 不良反应/异常事件 | 列表 | 时间线 |
| **Subjective Changes** | 患者主观感受变化 | 文本摘要 | 趋势 |
| **Trigger/Exposure Pattern** | 诱因/暴露模式 | 频率统计 | 关联分析 |
| **Open Questions** | 患者关注的问题 | 列表 | 按紧迫性排序 |
| **Safety Notice** | 安全提示 | 固定显示 | 固定显示 |

### 9.3 指标计算原则

- 参考临床框架（如 GINA 哮喘控制维度），但不输出临床分数；
- 输出 CareMemory 指标：Well controlled / Needs attention / Unstable；
- 趋势优先于绝对值；
- 数据稀疏时显示置信度提示；
- 仅当问题本身为量表时展示量表值。

### 9.4 生成频率

- 每次 check-in 后增量更新 headline 和近期模块；
- 周期结束时（7 天 / 4 周）完整刷新；
- 复诊前基于 Disease Card 生成 Brief。

---

## 10. Brief 生成规范

### 10.1 触发条件

- 7 天试用期结束时；
- 4 周计划结束时；
- 复诊前（用户设定或默认）；
- 用户主动请求。

### 10.2 内容结构

一页式摘要，从 Disease Card 截取并编排：

1. **标题**：Asthma Visit Brief — {患者昵称}
2. **周期**：{开始日期} – {结束日期}
3. **摘要 headline**：一句话状态
4. **关键信号**：
   - 症状趋势
   - 用药/依从性
   - 不良反应/异常事件
5. **患者关注的问题清单**
6. **事件时间线**：医学意义事件，非每日记录
7. **免责声明**：
   > This summary is based on patient-reported information only. It is not a diagnosis or medical advice. Please refer to the patient’s clinical records for treatment decisions.

### 10.3 生成方式

- 由 LLM 从 Disease Card + 医学知识生成；
- 使用 Brief 模板约束排版；
- 经过安全/合规层校验。

---

## 11. Onboarding 流程

### 11.1 入口方式

1. 落地页 CTA：`https://wa.me/{phone}?text=START+ASTHMA`
2. 直接发送关键词：`START ASTHMA`

### 11.2 流程

| 步骤 | 触发 | 系统行为 | 用户输入 |
|------|------|----------|----------|
| 1 | 收到 `START ASTHMA` | 发送欢迎语 + 边界说明 + 隐私政策链接 | 无 |
| 2 | 用户同意 | 记录 consent，创建 User 和 Cycle | AGREE |
| 3 | 同意完成后 | 询问昵称（可选） | 文本或跳过 |
| 4 | 收到昵称 | 询问下次复诊日期（可选） | 日期或跳过 |
| 5 | 收到日期 | 询问时区（默认 Europe/London） | 确认 |
| 6 | 完成 | 发送第一个 check-in 预告，进入 ACTIVE | 无 |

### 11.3 欢迎语必须包含

- 自我介绍；
- 不是诊断工具；
- 数据用途；
- 隐私政策链接；
- 需同意才能继续；
- 急救边界提示。

---

## 12. Check-in 流程

### 12.1 调度规则

- 首个 check-in 在 onboarding 完成后 24 小时内发送；
- 后续间隔约 48 小时；
- 7 天试用周期计划 4 次 check-in；
- 发送时间：用户本地时间 10:00–11:00；
- 用户 24h 内未回复，发送一次提醒模板。

### 12.2 正常流程

1. Planner 设定 session objective；
2. 对话层发送第 1 题；
3. 用户回答 → 感知层提取 observation；
4. Planner 重新评估，发送第 2 题；
5. 重复直到 budget 用完或 objective 达成；
6. 发送确认和感谢。

### 12.3 异常流程

1. 感知层标记 anomaly；
2. 安全层判断风险等级；
3. 高风险：立即安全响应，结束 check-in；
4. 中低风险：Planner 进入 exception mode，追加 2–3 个澄清问题；
5. 澄清后：返回原路径或结束。

---

## 13. 异常处理流程

### 13.1 异常检测来源

- 用户主动报告严重症状；
- 用户回答与历史模式冲突；
- 用户回答与疾病管理规则不一致；
- 复合信号冲突；
- 患者主动求助。

### 13.2 处理原则

- 安全优先；
- 不无限追问；
- 必要时建议就医或拨打急救电话；
- 所有异常处理记录入 Event Log。

---

## 14. 安全与合规层

### 14.1 禁止输出

- 诊断结论；
- 治疗建议；
- 用药调整建议；
- 对患者是否需要急救的判断。

### 14.2 必须追加的提示

- 哮喘相关内容默认附带急救提示；
- 任何 medical summary 底部附带免责声明；
- 用户报告严重症状时，必须建议联系医生或拨打 999。

### 14.3 审计

- 保留所有 LLM 调用输入/输出；
- 保留 Planner 决策；
- 保留安全层校验结果；
- 保留数据访问日志。

---

## 15. Web / PWA 页面

### 15.1 Disease Card 页面

- 路径：`/c/{cardId}?t={accessToken}`
- 移动端优先；
- 模块化卡片布局；
- 显示数据来源和置信度提示；
- 提供「下载 PDF」「分享 Brief」入口。

### 15.2 Brief 页面

- 路径：`/b/{briefId}?t={accessToken}`
- 移动端优先；
- 一页式布局；
- 下载 PDF 按钮；
- 删除此 Brief 按钮。

### 15.3 记录查看页面

- 路径：`/records?t={userToken}`
- 显示历史 check-in 和 observation；
- 支持用户补充或修正记录。

---

## 16. API 接口

### 16.1 Webhook 接收

```
POST /webhooks/:platform
Content-Type: application/json
X-Hub-Signature-256: sha256=...
```

### 16.2 内部引擎 API

```
POST /engine/perceive
POST /engine/plan
POST /engine/dialogue
POST /engine/safety-check
```

### 16.3 页面与下载

```
GET /c/{cardId}?t={accessToken}
GET /b/{briefId}?t={accessToken}
GET /b/{briefId}/pdf?t={accessToken}
GET /records?t={userToken}
```

### 16.4 内部运营 API

```
GET /admin/metrics
GET /admin/cycles?status=&limit=&offset=
GET /admin/feedbacks
```

---

## 17. 验收标准

### 17.1 Onboarding 验收

- [ ] 用户发送 `START ASTHMA` 后收到欢迎语和隐私链接；
- [ ] 未同意用户不会收到 check-in；
- [ ] 同意完成后创建 Cycle 并记录 `consentAt`。

### 17.2 Check-in 验收

- [ ] 7 天内发送 4 次 check-in，间隔约 48 小时；
- [ ] 每次常规 check-in 最多 3 个问题；
- [ ] 异常信号触发 budget 覆盖；
- [ ] 用户回答后正确保存 observation；
- [ ] 未完成的 check-in 发送一次提醒。

### 17.3 Disease Card 验收

- [ ] 每次 check-in 后 Disease Card 可更新；
- [ ] 7 天后展示早期 Disease Card；
- [ ] 不输出未直接询问的临床量表分数；
- [ ] 包含安全提示和免责声明。

### 17.4 Brief 验收

- [ ] Day 7 完成后 2 分钟内生成 Web Brief；
- [ ] Brief 内容来自 Disease Card；
- [ ] PDF 下载文件内容与 Web 页面一致；
- [ ] 过期或错误的 accessToken 无法访问 Brief。

### 17.5 合规验收

- [ ] 所有 outbound 消息不包含诊断或治疗建议；
- [ ] 哮喘相关消息包含急救提示；
- [ ] 用户可删除账户和数据；
- [ ] 医生端 Brief 包含免责声明。

---

## 18. 附录

### 18.1 参考文档

- `docs/PRD.md` — 产品需求文档
- `docs/tech-spec.md` — 技术规格文档
- `docs/decisions.md` — 设计决策记录
- `docs/local-testing-tool.md` — 本地测试工具设计

### 18.2 变更记录

| 版本 | 日期 | 变更内容 |
|------|------|----------|
| 0.1  | 2026-06-15 | 初始版本，定义 MVP 功能规格 |
| 0.2  | 2026-06-15 | 升级为 AI-native 架构，引入六层引擎、RAG Corpus、Disease Card、IM Adapter |

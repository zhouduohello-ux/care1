# CareMemory Technical Specification

> **版本**：v0.2 — AI-native 架构草案  
> **日期**：2026-06-15  
> **对应 PRD**：`docs/PRD.md`  
> **对应 Func Spec**：`docs/func-spec.md`  
> **目标**：英国 × 哮喘 × WhatsApp 最小可行产品，架构支持多病种/多平台

---

## 1. 技术目标

1. 在 2–4 周内构建可运行的 WhatsApp-first 原型。
2. 支持患者通过 WhatsApp 完成 7 天试用记录周期。
3. 构建 AI-native 六层决策引擎：感知 → 记忆 → 策略（RAG）→ 规划 → 对话 → 安全。
4. 生成持续更新的 **Disease Card** 及其复诊前导出形态 **Brief**。
5. 满足 UK GDPR 数据最小化、安全传输、可审计要求。
6. 架构可扩展至未来病种（IBD、糖尿病/高血压）和 IM 平台（LINE、SMS）。

---

## 2. 技术约束

- **IM 平台**：必须使用 WhatsApp Business API / Meta Cloud API，不使用个人账号做自动化。
- **LLM 使用**：所有 LLM 输出必须经过安全/合规校验；保留输入输出日志用于审计。
- **数据驻留**：健康数据建议存储在英国或欧洲经济区（EEA），满足 GDPR 要求。
- **无诊断逻辑**：系统不能包含判断病情严重程度的算法或 AI 诊断输出；不能从非量表回答推断临床量表分数。
- **医生端不通过 WhatsApp 接收临床数据**：Brief 通过 Web 链接 / PDF / Email 传递。
- **MVP 最小化**：优先选择托管服务，减少自建基础设施。

---

## 3. 推荐技术栈

> 以下技术选型为 **MVP 推荐方案**，团队可根据实际经验和合规要求调整。

| 层级 | 推荐技术 | 备选方案 |
|------|----------|----------|
| 后端运行时 | Node.js 22 LTS + TypeScript | Python 3.12 + FastAPI, Go |
| Web 框架 | Fastify 5.x | Express 4.x, NestJS |
| 数据库 | PostgreSQL 16 | MySQL 8, PlanetScale |
| ORM | Prisma 6.x | Drizzle, TypeORM |
| 缓存 / 任务队列 | Redis 7 + BullMQ | RabbitMQ, AWS SQS |
| IM 接入 | Meta WhatsApp Business API | Twilio WhatsApp API |
| Web 前端 | Next.js 15 (App Router) + React + Tailwind CSS | Astro + React |
| PDF 生成 | Playwright + Tailwind + HTML 模板 | Puppeteer, WeasyPrint |
| **LLM 推理** | **OpenAI GPT-4o / Anthropic Claude 3.5 Sonnet** | Azure OpenAI, Google Gemini |
| **RAG / 向量检索** | **Pinecone / Weaviate / pgvector** | Chroma, Qdrant |
| **LLM 可观测性** | **Langfuse / Helicone** | LangSmith, Weights & Biases |
| 邮件 | Resend / SendGrid | AWS SES |
| 部署平台 | Railway / Render / Fly.io | AWS, GCP, Vercel |
| 文件存储 | AWS S3 (eu-west) / Cloudflare R2 | MinIO |
| 监控与日志 | Sentry + Logtail / Datadog | Grafana Stack |

### 3.1 选型理由

- **Node.js + TypeScript**：团队生态丰富，前后端可复用类型，适合快速迭代。
- **PostgreSQL + Prisma**：关系模型适合结构化健康记录，Prisma 迁移和类型安全便于维护。
- **pgvector**：若选择 PostgreSQL 作为向量库，可减少基础设施复杂度；数据量增大后可迁移到专用向量库。
- **Fastify**：性能优于 Express，内置 JSON Schema 验证，适合 Webhook 场景。
- **Next.js**：一套代码同时服务 Web Disease Card / Brief 页面和后台 API（若部署在一起），SEO 与 PDF 渲染友好。
- **Playwright**：PDF 渲染一致性好，支持现代 CSS，便于与 Next.js 页面集成。
- **BullMQ**：定时 check-in 任务、narrative summary 更新、Disease Card 刷新等任务可靠调度。
- **OpenAI / Anthropic**：推理能力强，适合 Planner、信号提取、Disease Card 生成；建议不同场景使用不同模型（如轻量感知用 GPT-4o-mini，复杂规划用 GPT-4o/Claude）。
- **Langfuse**：追踪 LLM 调用、成本、延迟、安全校验结果，满足合规审计需求。

---

## 4. 系统架构

### 4.1 高层架构图

```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│   Patient       │◄────►│  WhatsApp        │◄────►│  Meta Cloud API │
│  (Mobile)       │      │  Messenger       │      │                 │
└─────────────────┘      └──────────────────┘      └────────┬────────┘
                                                            │
                                                            ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CareMemory Backend                                   │
│                                                                                │
│  ┌──────────────┐  ┌──────────────────────────────────────────────────────┐  │
│  │ IM Adapter   │  │ AI-native Engine (六层)                               │  │
│  │              │  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌───────────┐  │  │
│  │ - inbound    │  │  │ L1      │ │ L2      │ │ L3      │ │ L4        │  │  │
│  │ - outbound   │  │  │Perception│ │Memory   │ │RAG      │ │Planner    │  │  │
│  │ - 24h window │  │  └────┬────┘ └────┬────┘ └────┬────┘ └─────┬─────┘  │  │
│  │ - templates  │  │       │           │           │            │        │  │
│  └──────┬───────┘  │       └───────────┴───────────┴────────────┘        │  │
│         │          │                         │                           │  │
│         │          │  ┌─────────┐ ┌─────────┐                            │  │
│         │          │  │ L5      │ │ L6      │                            │  │
│         │          │  │Dialogue │ │Safety   │                            │  │
│         │          │  └────┬────┘ └────┬────┘                            │  │
│         │          └───────┼───────────┼──────────────────────────────────┘  │
│         │                  │           │                                      │
│         └──────────────────┘           │                                      │
│                                        ▼                                      │
│  ┌─────────────────────────────────────────────────────────────────────────┐  │
│  │                         RAG Corpus                                       │  │
│  │  Medical KB │ Care Strategy │ Conversation Patterns │ Safety Rules        │  │
│  └─────────────────────────────────────────────────────────────────────────┘  │
│                                                                                │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
  ┌──────────┐              ┌──────────────┐             ┌──────────────┐
  │PostgreSQL│              │ Redis        │             │ Object Store │
  │(records) │              │ (jobs/cache) │             │ (PDF/files)  │
  └──────────┘              └──────────────┘             └──────────────┘
                                    │
                                    ▼
                   ┌─────────────────────────────┐
                   │  Web Disease Card / Brief   │
                   │      (Next.js / PDF)        │
                   └─────────────────────────────┘
```

### 4.2 核心模块

| 模块 | 职责 |
|------|------|
| `im-adapter` | 平台无关的入站/出站消息转换；管理 24h 会话窗口、模板、去重 |
| `perception` (L1) | 解析用户输入，提取 observation、意图、异常、安全标记 |
| `patient-memory` (L2) | 维护 Event Log、Observations、Narrative Summaries、Disease Card |
| `rag-corpus` (L3) | 管理 Medical KB、Care Strategy、Conversation Patterns、Safety Rules |
| `planner` (L4) | 基于患者状态和策略库，决定下一步动作；Session Objective + Per-turn Re-planning |
| `dialogue` (L5) | 把 Planner 意图渲染为平台消息；管理轮次、交互形态 |
| `safety` (L6) | 校验所有 LLM 输出，拦截越界表述，追加安全提示 |
| `disease-card-builder` | 从 patient memory 生成/更新 Disease Card |
| `brief-builder` | 从 Disease Card 截取并编排生成 Web Brief 和 PDF |
| `check-in-scheduler` | 调度主动 check-in、提醒、总结更新任务 |
| `user-service` | 用户注册、同意、账户删除 |
| `admin-api` | 内部运营数据查询、LLM 调用审计 |

---

## 5. 数据模型

### 5.1 核心实体

```prisma
// 用户表
model User {
  id            String    @id @default(cuid())
  phoneNumber   String    @unique
  waId          String?   @unique // WhatsApp ID（平台相关字段）
  locale        String    @default("en-GB")
  timezone      String    @default("Europe/London")
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  consentGiven  Boolean   @default(false)
  consentAt     DateTime?
  consentVersion String  @default("v1")
  cycles        Cycle[]
  diseaseCards  DiseaseCard[]
}

// 记录周期（7 天试用或 4 周计划）
model Cycle {
  id            String      @id @default(cuid())
  userId        String
  user          User        @relation(fields: [userId], references: [id])
  disease       String      @default("asthma")
  type          CycleType   // TRIAL_7_DAY | PLAN_4_WEEK
  status        CycleStatus // ONBOARDING | ACTIVE | COMPLETED | CANCELLED
  startedAt     DateTime
  endedAt       DateTime?
  nextCheckinAt DateTime?
  checkIns      CheckIn[]
  brief         Brief?
}

// 每次检查点 / 会话
model CheckIn {
  id            String        @id @default(cuid())
  cycleId       String
  cycle         Cycle         @relation(fields: [cycleId], references: [id])
  scheduledAt   DateTime
  sentAt        DateTime?
  completedAt   DateTime?
  status        CheckInStatus // SCHEDULED | SENT | COMPLETED | MISSED | EXCEPTION
  sessionObjective String?    // 本次会话目标
  events        Event[]
}

// 不可变事件日志
model Event {
  id            String    @id @default(cuid())
  checkInId     String?
  checkIn       CheckIn?  @relation(fields: [checkInId], references: [id])
  userId        String
  timestamp     DateTime  @default(now())
  type          EventType // inbound_message | outbound_message | observation_extracted | state_updated | llm_call | safety_check
  payload       Json
  platformMessageId String? // 用于去重
}

// 观察记录（半结构化）
model Observation {
  id            String    @id @default(cuid())
  userId        String
  cycleId       String
  eventId       String
  timestamp     DateTime  @default(now())
  category      String    // symptom | medication | trigger | function | adverse_event | subjective | question | ...
  concept       String    // 自然语言或标准医学概念
  value         Json      // 量表值、选项、文本等
  attributes    Json?     // severity, frequency, duration 等
  confidence    Float     @default(1.0)
  extractedBy   String    // rule | llm
}

// 叙事摘要（LLM 生成）
model NarrativeSummary {
  id            String    @id @default(cuid())
  userId        String
  cycleId       String?
  scope         String    // session | cycle | longitudinal
  generatedAt   DateTime  @default(now())
  content       String
  keyObservationIds String[]
  model         String?   // 生成模型，用于审计
}

// 疾病卡片
model DiseaseCard {
  id            String    @id @default(cuid())
  userId        String
  user          User      @relation(fields: [userId], references: [id])
  disease       String
  version       Int       @default(1)
  generatedAt   DateTime  @default(now())
  modules       Json      // DiseaseCardModule[]
  rawSummary    String    // LLM 生成的完整摘要
  model         String?   // 生成模型
}

// Brief
model Brief {
  id            String   @id @default(cuid())
  cycleId       String   @unique
  cycle         Cycle    @relation(fields: [cycleId], references: [id])
  diseaseCardId String?
  webUrl        String
  pdfUrl        String?
  accessToken   String   @unique
  expiresAt     DateTime
  generatedAt   DateTime @default(now())
}
```

### 5.2 数据保留策略

- 用户可一键删除账户和所有数据（GDPR 被遗忘权）。
- 未激活超过 90 天的试用数据自动匿名化或删除。
- LLM 调用日志保留至少 12 个月用于合规审计。
- 所有删除操作记录审计日志。

---

## 6. LLM / RAG 基础设施

### 6.1 LLM 使用场景与模型选择

| 场景 | 推荐模型 | 说明 |
|------|----------|------|
| 感知层：自由文本 observation 提取 | GPT-4o-mini / Claude 3 Haiku | 成本低、速度快 |
| Planner：决定下一步动作 | GPT-4o / Claude 3.5 Sonnet | 需要强推理能力 |
| 对话层：消息生成 | GPT-4o-mini / GPT-4o | 平衡成本与质量 |
| Disease Card / Brief 生成 | GPT-4o / Claude 3.5 Sonnet | 需要长上下文和医学表达谨慎 |
| 安全校验 | 专用规则 + LLM judge（GPT-4o-mini） | 双层校验 |
| Narrative Summary 更新 | GPT-4o-mini | 周期性任务，可控成本 |

### 6.2 RAG Pipeline

```
Corpus 文档 ──► 分块 ──► Embedding ──► 向量数据库
                                      ▲
用户输入 / 患者状态 ──► 查询向量化 ──┘
                                      │
                                      ▼
                              检索 Top-K 片段
                                      │
                                      ▼
                         注入 LLM Prompt 做推理
```

**Corpus 管理：**
- 文档使用 Markdown，按疾病组织目录；
- 分块策略：按标题/主题分块，保留上下文；
- 每个 chunk 标注来源（文件名、版本、疾病）；
- 医学顾问审核后发布新版本。

### 6.3 LLM 可观测性

- 使用 Langfuse / Helicone 记录：
  - prompt、completion、token 用量、成本；
  - latency、错误率；
  - 与 patient/user 的关联（用于审计）。
- 所有 LLM 调用 trace 保留 12 个月。

---

## 7. IM 接入设计

### 7.1 平台无关消息模型

```typescript
// 入站消息
interface InboundMessage {
  platform: "whatsapp" | "line" | "sms";
  channelId: string;      // 平台用户 ID
  userId: string;         // CareMemory 用户 ID
  messageId: string;      // 平台消息 ID，去重用
  timestamp: Date;
  content: {
    type: "text" | "button_reply" | "list_reply" | "image";
    text?: string;
    buttonId?: string;
    rawPayload: any;
  };
}

// 出站消息
interface OutboundMessage {
  userId: string;
  conversationContext: {
    requiresSession: boolean;
    priority: "normal" | "urgent";
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

### 7.2 Webhook 流程

```
Meta Cloud API ──POST──► /webhooks/:platform
    │
    ▼
Signature 验证 (X-Hub-Signature-256)
    │
    ▼
解析为 InboundMessage
    │
    ▼
去重（基于 platform message id）
    │
    ▼
调用 Engine.handleInbound(message)
    │
    ▼
生成 OutboundMessage
    │
    ▼
Adapter 转换为平台 API payload 并发送
```

### 7.3 24 小时会话窗口

| 场景 | 处理 |
|------|------|
| 窗口内用户回复 | 可发送自由生成消息 |
| 窗口内未回复 | 发送一次提醒模板；仍无回复则标记 missed |
| 窗口外主动 check-in | 使用预审批模板 |
| 窗口外用户主动回复 | 开启新会话，保留历史上下文 |

### 7.4 WhatsApp 适配器（MVP）

- 支持 text、interactive buttons、interactive list；
- 预准备模板：welcome、reminder、brief_ready、safety_notice、stop_confirm。

---

## 8. AI-native 引擎实现

### 8.1 请求流

```
InboundMessage
    │
    ▼
L1 Perception ──► 提取 Observation + Intent + Anomaly + SafetyFlag
    │
    ▼
L2 Patient Memory ──► 写入 Event + Observation；更新 Narrative Summary
    │
    ▼
L6 Safety（快速路径）───► 高风险？直接 Safety Response
    │
    ▼
L3 RAG Corpus ──► 检索 Care Strategy / Medical KB / Patterns
    │
    ▼
L4 Planner ──► 输出 Next Action + Session Objective
    │
    ▼
L5 Dialogue ──► 生成 OutboundMessage
    │
    ▼
L6 Safety ──► 最终校验 + 追加安全提示
    │
    ▼
IM Adapter ──► 发送
```

### 8.2 异步任务

- Narrative Summary 更新：check-in 完成后异步触发；
- Disease Card 增量更新：每次 check-in 后刷新 headline 和近期模块；
- Disease Card 完整刷新：周期结束时（7 天 / 4 周）触发，也可按需触发；
- Brief 生成：周期结束或复诊前触发；
- 所有任务使用 BullMQ，支持重试和死信队列。

---

## 9. Web / PWA 与 PDF

### 9.1 Disease Card 页面

- 路径：`/c/{cardId}?token={accessToken}`
- 移动端优先；
- 模块化卡片布局，每个 module 独立渲染；
- 显示数据来源、置信度提示、免责声明；
- 提供「下载 PDF」「分享 Brief」入口。

### 9.2 Brief 页面

- 路径：`/b/{briefId}?token={accessToken}`
- 从 Disease Card 截取并编排；
- 一页式布局，适配打印；
- 下载 PDF 按钮。

### 9.3 PDF 生成

- 复用 Web 页面，通过 Playwright 无头渲染；
- A4 尺寸；
- 生成后上传对象存储，保留 30 天或用户删除时清理。

---

## 10. 部署与基础设施

### 10.1 推荐 MVP 部署

| 组件 | 推荐服务 |
|------|----------|
| 后端 API | Railway / Render / Fly.io |
| Web Disease Card / Brief | Vercel（Next.js）或同一后端服务 |
| 数据库 | Railway PostgreSQL 或 Supabase（EU 区域） |
| 向量数据库 | pgvector（同一 PostgreSQL）或 Pinecone |
| Redis | Upstash Redis（EU 区域） |
| 对象存储 | Cloudflare R2 或 AWS S3 eu-west |
| LLM API | OpenAI / Anthropic |
| LLM 可观测性 | Langfuse Cloud 或自托管 |
| 域名 | 独立二级域名，如 `app.carememory.app` |
| SSL | Let's Encrypt 或托管平台自动提供 |

### 10.2 环境变量

```bash
# Meta WhatsApp
WHATSAPP_PHONE_NUMBER_ID=
WHATSAPP_BUSINESS_ACCOUNT_ID=
WHATSAPP_ACCESS_TOKEN=
WHATSAPP_WEBHOOK_VERIFY_TOKEN=
WHATSAPP_APP_SECRET=

# Database
DATABASE_URL=

# Vector Database (if separate)
VECTOR_DB_URL=

# Redis
REDIS_URL=

# LLM
OPENAI_API_KEY=
# Optional: for OpenAI-compatible endpoints (Azure, vLLM, Ollama, etc.)
OPENAI_BASE_URL=
DEFAULT_PLANNER_MODEL=gpt-4o-mini
DEFAULT_DIALOGUE_MODEL=gpt-4o-mini
DEFAULT_PERCEPTION_MODEL=gpt-4o-mini
DEFAULT_SAFETY_MODEL=gpt-4o-mini
LLM_DAILY_LIMIT_USER=50
LLM_FALLBACK_MODEL=gpt-4o-mini

# LLM Observability
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_BASE_URL=

# Storage
S3_ENDPOINT=
S3_BUCKET=
S3_ACCESS_KEY=
S3_SECRET_KEY=

# App
APP_BASE_URL=https://app.carememory.app
ENCRYPTION_KEY=
JWT_SECRET=

# Optional: Email
RESEND_API_KEY=
```

---

## 11. 安全与合规

### 11.1 数据安全

- 传输中：TLS 1.3。
- 静态：PostgreSQL 全盘加密 + S3 服务端加密。
- 敏感字段（如想问医生的问题）可选额外应用层加密。
- Webhook 签名验证，防止伪造消息。

### 11.2 AI 安全

- 所有 LLM 输出经过 L6 Safety 校验；
- 禁止输出诊断、治疗、用药调整建议；
- 高风险输入触发标准安全提示；
- 保留完整 prompt、completion、安全校验结果用于审计。

### 11.3 合规清单

- [ ] 隐私政策页面（UK GDPR 合规）
- [ ] 用户明确同意记录健康数据
- [ ] 支持数据导出和删除
- [ ] 不将健康数据用于广告或模型训练
- [ ] 医生端 Brief 包含免责声明
- [ ] LLM 调用日志保留并支持审计

### 11.4 内容安全

- 所有 outbound 消息模板需通过 Meta 审核；
- 哮喘相关回复必须包含急救提示兜底；
- 不生成任何诊断性或治疗建议性语言。

---

## 12. 开发环境

### 12.1 本地启动

```bash
# 1. 安装依赖
pnpm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env

# 3. 启动 PostgreSQL 和 Redis（Docker）
docker compose up -d

# 4. 数据库迁移
pnpm db:migrate

# 5. 启动开发服务器
pnpm dev
```

### 12.2 目录结构

```
CareMemory/
├── apps/
│   ├── api/                 # Fastify 后端：Webhook、引擎、API
│   └── web/                 # Next.js：Disease Card / Brief 页面 + PDF
├── packages/
│   ├── db/                  # Prisma schema、迁移脚本
│   ├── engine/              # 六层 AI 引擎核心（perception, memory, planner, dialogue, safety）
│   ├── rag-corpus/          # RAG Corpus 文档、索引、检索接口
│   ├── im-core/             # 平台无关消息模型、IM Adapter 接口
│   ├── im-whatsapp/         # WhatsApp Adapter（MVP）
│   ├── disease-card/        # Disease Card 生成与模板
│   └── brief-templates/     # Brief HTML/PDF 模板
├── infra/
│   └── docker-compose.yml   # 本地 PostgreSQL + Redis + (可选 pgvector)
├── tests/
└── docs/
```

---

## 13. 测试策略

### 13.1 单元测试

- Planner 决策逻辑（给定输入应输出合理 action）；
- Safety 层规则校验；
- Observation 提取规则；
- Disease Card / Brief 生成逻辑。

### 13.2 集成测试

- Meta Webhook 签名验证与解析；
- 完整 check-in 流程（模拟多轮问答）；
- RAG 检索准确性；
- 数据库读写和迁移；
- PDF 生成流程。

### 13.3 端到端测试

- 使用本地测试工具（`/dev/test-tool`）模拟完整 7 天用户旅程；
- 验证 Disease Card 可访问且内容正确；
- 验证 Brief 页面可访问且包含预期内容；
- 生产环境 E2E 可使用少量测试手机号。

### 13.4 合规测试

- 验证诊断性/治疗性词汇被过滤；
- 验证用户删除账户后数据不可恢复；
- 验证 LLM 输出包含必要安全提示；
- 验证 24h 外只能发送模板消息。

---

## 14. 性能与扩展

### 14.1 MVP 容量目标

- 支持 1,000 名同时试用用户。
- 每日 check-in 消息 < 10,000 条。
- Disease Card / PDF 生成 QPS < 10。
- LLM 调用延迟：Planner < 2s，Dialogue < 1s。

### 14.2 未来扩展点

- `im-core` + 新 Adapter 接入 LINE / SMS；
- `rag-corpus` 新增 disease profile（IBD、糖尿病/高血压）；
- `disease-card` 支持更多模块和可视化；
- `safety` 层支持多病种安全规则；
- 接入外部医学知识库（NHS、NICE）。

---

## 15. 待决策事项

| 事项 | 建议 | 决策者 |
|------|------|--------|
| 后端语言 | Node.js + TypeScript | 团队 |
| LLM 提供商 | OpenAI + Anthropic（双供应商） | 团队 |
| 向量数据库 | pgvector（MVP）→ Pinecone（规模扩大） | 团队 |
| 部署平台 | Railway / Render | 团队 |
| 数据库托管 | Railway PostgreSQL EU | 团队 |
| 是否接入 Email 分享 | MVP 后期再添加 | 产品 |
| 是否需要医生端反馈 Dashboard | 冷启动阶段可用 Typeform/Notion 替代 | 产品 |

---

## 16. 附录

### 16.1 参考文档

- `docs/PRD.md` — 产品需求文档
- `docs/func-spec.md` — 功能规格文档
- `docs/decisions.md` — 设计决策记录
- `docs/local-testing-tool.md` — 本地测试工具设计
- Meta WhatsApp Business API 文档：https://developers.facebook.com/docs/whatsapp/cloud-api

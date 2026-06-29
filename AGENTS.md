# CareMemory — AI 编码代理须知

> 本文件面向为本项目编写代码的 AI 代理。只保留与开发、运行、维护相关的信息。项目主要文档与注释使用中文，本文件亦使用中文撰写；代码、命令、文件路径、技术术语保持原样。
> 最后更新：2026-06-29（基于实际项目结构与代码验证后重写）。

---

## 1. 项目概述

**CareMemory** 是一款 AI-native 的复诊前健康记忆引擎。患者在两次复诊之间通过即时通讯工具（首个 MVP 为 WhatsApp）进行轻量、对话式记录；系统基于医学知识库、疾病管理策略和患者实际回答，动态决定每次该问什么、如何追问、何时提醒，最终生成持续更新的 **Disease Card（疾病卡片）** 及其复诊导出形态 **Brief（Web / PDF）**。

首个 MVP 聚焦：

- **市场**：英国（UK）
- **疾病**：哮喘（Asthma）
- **IM 入口**：WhatsApp

产品定位：

- **Health Memory**：把复诊前的"健康故事"结构化；
- **AI-native Engine**：用 LLM + RAG 驱动每日问题路径、异常追问和疾病卡片生成；
- **IM-first**：用 WhatsApp 做轻量记录；
- **Disease Card**：患者的长期疾病肖像，患者主看；
- **Doctor Brief**：从 Disease Card 截取的一页式复诊摘要，医生主看。

核心红线：系统**不做诊断、不提供治疗建议、不判断是否需要急救**；所有输出必须标注"患者自报信息，供复诊参考"。

---

## 2. 关键文档

| 文档 | 路径 | 用途 |
|------|------|------|
| 产品需求文档 | `docs/PRD.md` | 产品目标、范围、用户旅程、成功指标 |
| 技术规格文档 | `docs/tech-spec.md` | 技术栈、架构、数据模型、部署、安全 |
| 功能规格文档 | `docs/func-spec.md` | 功能行为、字段、流程、验收标准 |
| 设计决策记录 | `docs/decisions.md` | PRD/func-spec 讨论中确定的关键边界决策 |
| 本地测试工具设计 | `docs/local-testing-tool.md` | 本地 simulator 设计：浏览器聊天、时间控制、引擎 inspector |
| 待明确边界 | `docs/open-boundaries.md` | 对齐审查中发现的未决边界与遗漏核心能力 |
| 策略研究文档 | `docs/carememorydiaglog.md` | 市场与疾病策略研究（非开发直接输入） |
| Staging E2E 运行手册 | `docs/staging-e2e-runbook.md` | 在真实 staging（Render）上运行 E2E smoke 的配置与步骤 |
| DDL 参考 | `docs/ddl.md` | 数据库 DDL 参考 |

---

## 3. 项目状态

### 3.1 文件结构

```
CareMemory/
├── apps/
│   ├── api/                 # Fastify 后端：Webhook、对话引擎、调度、Brief API、本地测试工具
│   │   ├── src/
│   │   │   ├── routes/      # API 路由（webhooks、test-tool、briefs、export、health、records、admin）
│   │   │   ├── test-tool/   # 本地测试工具 persona 库
│   │   │   ├── services/    # BullMQ 调度器（check-ins / reminders）
│   │   │   ├── plugins/     # Fastify 插件（prisma、redis、clock、raw-body）
│   │   │   └── lib/         # 共享工具（PDF 渲染、导出/访问 token、quota store、dispatch、logger）
│   │   └── public/test-tool/# 本地测试工具静态 UI
│   └── web/                 # Next.js Web Disease Card / Brief / Records / Privacy Policy 页面 + PDF 下载
│       ├── src/app/         # App Router 页面
│       └── src/components/  # DiseaseCardModule、BriefActions 等组件及单元测试
├── packages/
│   ├── db/                  # Prisma schema、client、迁移脚本
│   ├── engine/              # 六层 AI 引擎核心（types / engine / perception / memory / planner / dialogue / safety / llm / llm-quota / experiments / onboarding）
│   ├── im-core/             # 平台无关消息模型、IM Adapter 接口
│   ├── im-whatsapp/         # WhatsApp Adapter（MVP）与模板选择
│   ├── disease-card/        # Disease Card 生成（types + generator）
│   ├── brief-templates/     # Brief HTML 模板（generateBriefHtml）
│   └── rag/                 # RAG Corpus 文档与关键词检索接口
├── infra/
│   ├── docker-compose.yml          # 本地 PostgreSQL 16 + pgvector + Redis 7
│   ├── docker-compose.prod.yml     # 自托管生产栈（API + Postgres + Redis + 可选 migrate）
│   └── render.yaml                 # Render Blueprint（API + Web + Postgres + Redis）
├── tests/
│   └── scenarios/                  # 本地 E2E scenario JSON + runner / 汇总器
├── .github/
│   └── workflows/
│       ├── ci.yml                  # PR/Push：typecheck / test / build / 本地 infra E2E
│       └── deploy.yml              # main 合并后构建并推送 API Docker 镜像，可选 Render 触发 + staging smoke
├── temp/                           # 临时文件（分析报告、状态页面等，不纳入版本管理）
├── docs/                           # 产品与技术文档
├── Dockerfile                      # API 生产镜像（多阶段构建，暴露 3000）
├── .env.example                    # 环境变量示例（含 LLM 统一配置、A/B 实验、S3、email 等）
├── .npmrc                          # pnpm 配置（engine-strict、strict-peer-dependencies=false、auto-install-peers=true）
├── package.json                    # pnpm workspaces root
├── pnpm-workspace.yaml             # apps/* 与 packages/*
├── turbo.json                      # pipeline 定义：build（dependsOn ^build）、dev（persistent）、test、lint、typecheck
└── AGENTS.md                       # 本文件
```

### 3.2 工程状态

- 已初始化 pnpm workspaces monorepo 与根目录配置；
- 已选定技术栈：Node.js 22 LTS + TypeScript 5.7 + Fastify 5 + PostgreSQL 16 + Prisma 6 + Redis 7 + BullMQ 5 + Next.js 15 + Playwright 1.61；
- 已创建 `packages/db` 与 Prisma schema（两次迁移：`20260615142445_init`、`20260615180000_p1_p2_fields`），本地基础设施（`infra/docker-compose.yml`）就绪；
- 已实现 `apps/api`（Fastify 后端 + 引擎骨架 + 本地测试工具 + Brief API + GDPR 导出/删除 + admin/metrics），可本地跑通 onboarding → check-in → Disease Card → Brief / PDF 的最小闭环；
- 已实现 `apps/web`（Next.js Disease Card / Brief / Records / Privacy Policy 页面，含 PDF 下载按钮），已配置 vitest + @testing-library/react + jsdom，并对 `BriefActions`、`DiseaseCardModule` 组件编写了单元测试；
- 已实现 `packages/im-core`、`packages/im-whatsapp`、`packages/engine`、`packages/disease-card`、`packages/brief-templates`；
- 已实现 `packages/rag`（哮喘 RAG Corpus + 关键词检索），并已接入 Planner 生成 reasoning；
- 已引入 vitest，为 `packages/engine`、`packages/rag`、`packages/im-whatsapp`、`apps/api`、`apps/web` 编写了单元/集成测试；
- 已实现 WhatsApp Webhook HMAC-SHA256 签名验证、raw body 插件，以及 Meta Graph API outbound 消息发送客户端（配置真实 token 后自动发送，否则保持本地返回）；
- 已实现 LLM 抽象（OpenAI provider + stub），Perception / Planner 在 `LLM_API_KEY` 或 `OPENAI_API_KEY` 配置时调用 LLM，失败或无 key 时自动降级为规则逻辑；支持按层独立模型/温度配置；
- 已补充完整 onboarding 流程（同意 → 昵称 → 年龄校验 → 下次复诊 → 用药基线 → active cycle）；
- 已实现 LLM 调用审计日志（Event 表记录 model/input/output/token usage）；
- 已实现异常模式（exception mode）：检测到中高风险异常时追加最多 3 个澄清问题，结束后标准安全提示并写入 Disease Card Adverse Events；
- 已实现 check-in 自动调度与 24 小时提醒，状态持久化到数据库，服务重启后可恢复；调度器已迁移至 BullMQ（Redis repeatable job + Worker），服务关闭时优雅停止；
- 已实现 Disease Card 访问令牌与患者记录页（`/c/[cardId]?t=...` 与 `/records?t=...`）；
- 已实现 WhatsApp 24h session window 检测与模板消息 fallback；`packages/im-whatsapp/src/templates.ts` 定义了 MVP 模板文案、变量与智能模板选择逻辑；
- 已实现 RAG reindex CLI：`pnpm corpus:reindex` 重新生成 `packages/rag/src/corpus.ts`；
- 已补充 GDPR 导出格式（`carememory-gdpr-export-v1`，7 天有效链接，默认排除 LLM 审计日志）与 admin/metrics API（`ADMIN_API_KEY` 鉴权）；
- 已实现用户修正历史回答：感知层识别修正意图，原 observation 标记 `superseded=true`，新 observation 替代生效；
- 已实现迟到回答处理：同一 active cycle 内无 active check-in 的回复会被接受为补充更新；跨 cycle 场景下系统询问用户是否与最近记录相关，用户确认（YES / Add to last record）后保存到最近 cycle；
- 已实现 LLM 成本限流：用户级每日软上限（`LLM_DAILY_LIMIT_USER`）、备用模型降级（`LLM_FALLBACK_MODEL`）；每日调用计数通过 Redis（`llm:daily:<userId>:<dayKey>`）原子递增并设置当天过期；
- 已实现 A/B 测试框架：基于 userId hash 的稳定分桶，已用于 check-in 频率（48h/72h）与对话风格（v1/v2），通过 `EXPERIMENT_*` 环境变量控制；
- 已实现崩溃恢复与幂等性：入站消息按 `platformMessageId` 去重，出站消息带 `idempotencyKey` 避免重复发送；
- 已统一出站消息幂等性：engine 在 `saveOutboundMessages` 中生成 `idempotencyKey` 并写入 `outbound_message` 事件（状态 `pending`），dispatch 层读取已有事件并更新为 `sent`/`failed`；
- 已实现 4 周周期延续：`PLAN_4_WEEK` cycle 在 28 天结束时提示 CONTINUE，用户回复后创建下一个周期；
- 已补充端到端回归 scenario runner（`tests/scenarios/run-scenario.ts`），内置六个 scenario，支持 `message` / `planner` / `safety` / `observation` / `diseaseCard` / `brief` / `pdf` 断言；
- 已补充 Render 部署蓝图：`infra/render.yaml` 定义 API / Web / PostgreSQL / Redis 服务，GitHub Actions `deploy.yml` 可选触发 Render deploy hook；
- 已接入可观测性：API 使用 `@sentry/node`（^10.58.0）捕获异常，Next.js Web 使用 `@sentry/nextjs`；API 结构化 JSON 日志通过 Fastify/pino 输出，支持 `LOG_LEVEL` 与敏感字段脱敏；
- 已增强 `/health` 端点：返回 PostgreSQL / Redis 依赖检查结果与 `version`；
- 已重构 E2E runner：`tests/scenarios/run-scenario.ts` 支持程序化复用，`tests/scenarios/run-all.ts` 可顺序运行所有 scenario 并输出汇总表格；新增 `pnpm test:e2e:staging`，用于针对任意 `API_BASE_URL`（本地或 staging）做冒烟测试；
- 已为 staging E2E 加固本地测试工具：`/dev/test-tool/*` 在 `NODE_ENV=production` 下必须提供 `TEST_TOOL_API_KEY` 才能访问，生产环境保持禁用；
- 已更新部署工作流：`.github/workflows/deploy.yml` 在 Render 部署后自动等待 `/health` 并就绪后运行 staging E2E smoke。

---

## 4. 已确定技术栈

> 以 `docs/tech-spec.md` 第 3 节为准。MVP 已采用以下技术选型。

| 层级 | 选型 |
|------|------|
| Monorepo | pnpm workspaces 9.x (`packageManager: pnpm@9.0.0`) + Turbo 2.x |
| 后端运行时 | Node.js 22 LTS + TypeScript 5.7 |
| Web 框架 | Fastify 5.x（含 @fastify/helmet、@fastify/rate-limit、@fastify/static） |
| 数据库 | PostgreSQL 16 + pgvector + Prisma 6.x（client 输出到 `packages/db/generated/`） |
| 缓存 / 任务队列 | Redis 7（ioredis）+ BullMQ 5 |
| IM 接入 | Meta WhatsApp Business API（MVP 先用本地测试工具模拟） |
| Web 前端 | Next.js 15 (App Router) + React 19 + Tailwind CSS |
| PDF 生成 | Playwright 1.61 无头渲染 |
| LLM | OpenAI GPT-4o-mini（默认，可通过 `LLM_*` 环境变量统一配置各层模型） |
| LLM 可观测性 | Langfuse（可选） |
| 本地测试工具 | Fastify dev-only 路由 + 静态 HTML/JS |
| 部署 | Render（蓝图已落地：`infra/render.yaml`）；自托管备用 `infra/docker-compose.prod.yml` |
| 监控 | Sentry（`@sentry/node` + `@sentry/nextjs` + `@sentry/react`）+ 结构化 JSON 日志（pino） |
| 包构建 | tsup 8.x（输出 CJS + ESM + DTS） |
| 测试框架 | vitest 4.x（后端）+ @testing-library/react + jsdom（前端） |
| 数据校验 | zod 3.x |
| 运行时脚本 | tsx 4.x（`pnpm test:e2e:*`、`corpus:reindex` 等） |

新增框架或依赖前，请先在 `docs/tech-spec.md` 与本文件同步更新。

---

## 5. 代码组织

### 5.1 应用层

- `apps/api/src/index.ts`：Fastify 服务入口，注册插件（helmet、rate-limit、prisma、redis、clock、raw-body、static）、路由、BullMQ 调度器、Sentry 错误处理、结构化 JSON 日志；
- `apps/api/src/routes/`：路由实现；
  - `webhooks.ts`：WhatsApp Webhook 接收与 Meta 验证；
  - `test-tool.ts`：本地测试工具 API（需 `ENABLE_TEST_TOOL=true`，生产环境下还需 `TEST_TOOL_API_KEY` header）；
  - `briefs.ts`：Brief 生成与 PDF 导出；
  - `disease-cards.ts`：Disease Card 访问；
  - `records.ts`：患者记录页；
  - `export.ts`：GDPR 数据导出；
  - `health.ts`：健康检查（含 PostgreSQL / Redis 依赖状态）；
  - `admin.ts`：运营指标与 GDPR 管理（需 `ADMIN_API_KEY`）；
- `apps/api/src/plugins/`：Fastify 插件；
  - `prisma.ts`：Prisma client 注入；
  - `redis.ts`：ioredis 实例注入；
  - `clock.ts`：时钟抽象（支持 test-tool 虚拟时间覆盖）；
  - `raw-body.ts`：WhatsApp HMAC 验签所需的原始请求体；
- `apps/api/src/services/scheduler.ts`：BullMQ 调度器，负责 `scan-checkins` 与 `scan-reminders` 的 repeatable job 注册与立即触发；
- `apps/api/src/lib/`：业务无关工具；
  - `pdf.ts`：Playwright PDF 渲染；
  - `export-token.ts`：GDPR 导出安全链接（7 天有效期）；
  - `user-token.ts`：Disease Card / Brief / Records 访问令牌；
  - `quota-store.ts`：Redis-backed LLM 每日配额存储；
  - `dispatch-outbound.ts`：出站消息分发（去重 + 24h session window 检测 + 模板 fallback）；
  - `outbound-sender.ts`：WhatsApp / stub 消息发送；
  - `logger.ts`：结构化日志工具；
- `apps/api/src/test-tool/`：本地测试工具 persona 库（`persona-library.ts`）；
- `apps/web/src/app/`：Next.js App Router 页面；
  - `b/[briefId]/page.tsx`：Brief 展示页；
  - `c/[cardId]/page.tsx`：Disease Card 展示页；
  - `records/page.tsx`：患者记录页；
  - `privacy/page.tsx`：隐私政策页；
  - `layout.tsx`：根布局；
  - `global-error.tsx`：全局错误边界；
- `apps/web/src/components/`：可复用 React 组件（`DiseaseCardModule`、`BriefActions`）及单元测试。

### 5.2 包层

- `packages/db`：Prisma schema（`packages/db/prisma/schema.prisma`）与数据库 client；
  - 核心模型：User、Cycle、CheckIn、Event、Observation、NarrativeSummary、DiseaseCard、Brief；
  - Event 表同时承担审计日志角色（含 LLM 调用记录的 model/input/output/token usage 字段）；
  - 枚举：CycleType（TRIAL_7_DAY / PLAN_4_WEEK）、CycleStatus（ONBOARDING / ACTIVE / COMPLETED / CANCELLED）、CheckInStatus（SCHEDULED / SENT / COMPLETED / MISSED / EXCEPTION）、EventType（inbound_message / outbound_message / observation_extracted / state_updated / llm_call / safety_check / checkin_scheduled / checkin_sent / checkin_completed / user_action）、ObservationCategory（symptom / medication / trigger / function / adverse_event / subjective / question / system_intent / profile）、NarrativeScope（session / cycle / longitudinal）；
  - 已有两次迁移：`20260615142445_init`、`20260615180000_p1_p2_fields`；
  - Prisma client 输出目录为 `packages/db/generated/client/`（已加入 `.gitignore`）；
- `packages/engine`：六层引擎核心（对外导出 types + perceive / plan / safetyCheck / renderMessage + LLM/quota/experiments/memory 工具）；
  - `types.ts`：核心类型定义（EngineContext、PerceptionResult、PlannerInput/Output、SafetyResult、EngineTrace、Engine 接口等）；
  - `engine.ts`：入站处理主流程（`processInbound` / `handleCheckInTrigger`），串联全部六层，管理 onboarding 状态；
  - `perception.ts`：意图识别、observation 提取、安全标记、系统命令硬编码处理；
  - `planner.ts`：问题路径规划（含 RAG 检索增强、异常模式、预算管理）；
  - `dialogue.ts`：把 planner 输出渲染为平台无关消息；
  - `safety.ts`：输出安全校验与免责声明追加；
  - `memory.ts`：事件/observation 持久化、GDPR 删除/导出、幂等性 key、narrative summary 生成；
  - `llm.ts`：LLM client 抽象与 OpenAI provider，以及 `loadLLMConfig()`；支持按层独立模型、温度、baseUrl 配置；
  - `llm-quota.ts`：用户级每日 LLM 调用配额接口；
  - `experiments.ts`：A/B 测试稳定分桶与 `scheduleNextCheckInOffset()`；
  - `onboarding.ts`：onboarding 状态机（内部模块，由 engine.ts 直接消费，不对外导出）；
- `packages/rag`：RAG Corpus（哮喘）与关键词检索；
  - `corpus.ts`：预编译的哮喘疾病知识语料（由 `corpus:reindex` 脚本生成）；
  - `index.ts`：检索入口；
- `packages/im-core`：平台无关消息模型（`InboundMessage`、`OutboundMessage`）、`IMAdapter` 接口、`DefaultPlatformRegistry`；
- `packages/im-whatsapp`：WhatsApp Webhook 解析、payload 构建、HMAC 验证、模板选择（`templates.ts`）与 sender（`sender.ts`）；
- `packages/disease-card`：Disease Card 生成；
  - `types.ts`：`DiseaseCardModule`、`GeneratedDiseaseCard` 等类型；
  - `generator.ts`：`generateDiseaseCard()` 从 observations 生成 Disease Card，含控制评估、症状趋势、药物使用、不良事件等模块；
- `packages/brief-templates`：Brief HTML 模板；
  - 单一入口 `index.ts`：导出 `generateBriefHtml()` 与 `BriefData` 接口，由 Playwright 渲染为 PDF。

### 5.3 数据流（六层引擎）

```
入站消息 → L1 Perception → L2 Memory(持久化) → L3 RAG 检索 → L4 Planner → L5 Dialogue → L6 Safety → 出站消息
```

- **L1 Perception**：解析用户意图、提取 observations、标记安全信号；
- **L2 Memory**：持久化事件与 observation、GDPR 操作、幂等性；
- **L3 RAG**：关键词检索哮喘知识库，注入 Planner；
- **L4 Planner**：LLM 驱动的动态问题规划，含异常模式分叉；
- **L5 Dialogue**：将结构化 plan 转为平台无关的出站消息；
- **L6 Safety**：输出安全校验，追加免责声明，高风险信号快速路径。

### 5.4 测试

- 单元测试：各 package / app 内 `*.test.ts` / `*.test.tsx`（vitest）；
- E2E scenario：`tests/scenarios/*.json` + `tests/scenarios/run-scenario.ts` + `tests/scenarios/run-all.ts`。

---

## 6. 开发规范

- **语言**：TypeScript（后端与前端）、JSON（scenario）；
- **模块系统**：`"type": "module"`，使用 ESM；导入时必须使用 `.js` 扩展名（TypeScript NodeNext 模块解析要求，Web 除外 — Next.js 使用 bundler 模块解析）；
- **TypeScript 配置**：
  - 后端（`apps/api` 与所有 `packages/*`）：`target: ES2022`、`module: NodeNext`、`moduleResolution: NodeNext`、`strict: true`、`esModuleInterop: true`、`skipLibCheck: true`；
  - 前端（`apps/web`）：`module: esnext`、`moduleResolution: bundler`、Next.js 插件、`jsx: preserve`、`strict: true`；
- **构建工具**：根目录与 package 使用 `turbo`；各 package 使用 `tsup` 输出 CJS/ESM/DTS；
- **包管理器**：pnpm 9.x（`packageManager` 已固定为 `pnpm@9.0.0`）；
- **pnpm 配置**：`.npmrc` 中 `engine-strict=true`、`strict-peer-dependencies=false`、`auto-install-peers=true`、`shamefully-hoist=false`；
- **数据库迁移**：Prisma Migrate，开发用 `pnpm db:migrate`，生产用 `pnpm db:deploy`；
- **密钥管理**：使用 `.env` + 环境变量，不提交密钥；生产使用托管 secrets 服务；
- **提交规范**：建议 Conventional Commits；
- **分支模型**：trunk-based，功能通过 short-lived branch 合并；
- **代码审查**：所有代码通过 PR/MR 合并；
- **Lint**：`apps/api` 配置了 ESLint（`eslint src --ext .ts`），根目录通过 `turbo run lint` 统一运行。

---

## 7. 构建与运行

### 7.1 环境要求

- Node.js >= 22
- pnpm 9.x
- Docker + Docker Compose

### 7.2 本地开发流程

```bash
# 1. 安装依赖
pnpm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env（至少确认 DATABASE_URL、REDIS_URL）

# 3. 启动本地 PostgreSQL 和 Redis
pnpm infra:up

# 4. 数据库迁移
pnpm db:migrate

# 5. （可选）种子数据
pnpm db:seed

# 6. 启动开发服务器（api + web）
pnpm dev
```

默认端口：
- API：`3055`（通过 `PORT` 环境变量配置）
- Web：`3051`（通过 `WEB_PORT` 环境变量配置）

容器端口映射（`infra/docker-compose.yml`）：
- PostgreSQL：`5435:5432`（使用 pgvector/pgvector:pg16 镜像）
- Redis：`6381:6379`（使用 redis:7-alpine 镜像）

### 7.3 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 同时启动 apps/api 与 apps/web |
| `pnpm build` | 构建所有应用与包 |
| `pnpm typecheck` | 全仓类型检查 |
| `pnpm test` | 运行单元/集成测试套件 |
| `pnpm lint` | 运行 lint |
| `pnpm db:generate` | 生成 Prisma client |
| `pnpm db:migrate` | 执行 Prisma 迁移（开发用） |
| `pnpm db:deploy` | 生产式迁移部署 |
| `pnpm db:studio` | 打开 Prisma Studio |
| `pnpm db:seed` | 运行种子脚本 |
| `pnpm infra:up` | 启动 PostgreSQL + Redis |
| `pnpm infra:down` | 停止本地基础设施 |
| `pnpm infra:logs` | 查看基础设施日志 |
| `pnpm corpus:reindex` | 重新索引 RAG Corpus |
| `pnpm test:e2e:controlled` | 运行 controlled asthma E2E scenario |
| `pnpm test:e2e:worsening` | 运行 worsening asthma E2E scenario |
| `pnpm test:e2e:exception` | 运行异常模式 E2E scenario |
| `pnpm test:e2e:brief` | 运行 Brief/PDF E2E scenario |
| `pnpm test:e2e:cross-cycle` | 运行跨 cycle 迟到回答 E2E scenario |
| `pnpm test:e2e:7day` | 运行完整 7 天试用 E2E scenario |
| `pnpm test:e2e:staging` | 顺序运行所有 E2E scenario，可针对 `API_BASE_URL` 做冒烟测试 |

### 7.4 本地测试工具

开发模式下访问 `http://localhost:3055/dev/test-tool`，可在浏览器中：

- 模拟患者对话（文本 / 按钮）；
- 加载内置 persona（controlled / worsening / exercise_trigger / adverse_event / non_responder / early_quit）；
- 控制虚拟时间（Next Check-in / +1 day / 指定 ISO 时间）；
- 查看 L1 感知、L4 Planner、L6 Safety 的实时 trace；
- 导出当前 session JSON，或通过 `/dev/test-tool/api/replay-session` 重放脚本。

### 7.5 LLM 配置

LLM 配置已统一化，环境变量为单一真相来源。最小配置：

```bash
# OpenAI 示例
LLM_API_KEY=sk-openai-xxx
LLM_BASE_URL=https://api.openai.com/v1
LLM_DEFAULT_MODEL=gpt-4o-mini

# DeepSeek 示例
LLM_API_KEY=sk-deepseek-xxx
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_DEFAULT_MODEL=deepseek-chat
```

支持按层覆盖（可选）：

```bash
LLM_MODEL_PLANNER=gpt-4o
LLM_TEMPERATURE_PLANNER=0.1
```

兼容旧环境变量（`OPENAI_API_KEY`、`DEFAULT_PERCEPTION_MODEL` 等），但优先使用 `LLM_*` 系列。详见 `.env.example` 完整注释。

**注意**：`infra/render.yaml` 与 `turbo.json` 的 `globalEnv` 仍使用旧版命名（如 `DEFAULT_PLANNER_MODEL`、`OPENAI_BASE_URL`），后续应统一迁移到 `LLM_*` 系列。

---

## 8. 测试策略

### 8.1 单元测试

运行：`pnpm test`

已覆盖：

- 对话引擎状态转换（`packages/engine/src/*.test.ts`）；
- 记录规范化与汇总逻辑（`memory.test.ts`）；
- Planner 问题路径、预算耗尽、安全响应（`planner.test.ts`）；
- 感知层系统指令 / 按钮映射 / 安全标记（`perception.test.ts`）；
- 安全层诊断/治疗语言过滤与免责声明追加（`safety.test.ts`）；
- LLM client、LLM 驱动的感知/规划与降级（`llm.test.ts`）；
- LLM quota 接口（`llm-quota.test.ts`）；
- A/B 实验分桶（`experiments.test.ts`）；
- 异常模式处理（`exception.test.ts`）；
- RAG Corpus 加载与检索（`packages/rag/src/index.test.ts`）；
- WhatsApp Webhook 签名验证、解析、模板选择与 outbound 发送（`packages/im-whatsapp/src/*.test.ts`）；
- outbound 消息持久化与幂等性 key 生成（`packages/engine/src/memory.test.ts`）；
- dispatch 层去重、重试、session window 模板 fallback 与状态更新（`apps/api/src/lib/dispatch-outbound.test.ts`）；
- admin 路由鉴权、metrics、GDPR 导出与删除（`apps/api/src/routes/admin.test.ts`）；
- BullMQ scheduler 生命周期、repeatable job 注册、scan-checkins / scan-reminders 处理器（`apps/api/src/services/scheduler.test.ts`）；
- Redis-backed LLM quota store（`apps/api/src/lib/quota-store.test.ts`）；
- Web 组件：`BriefActions` 与 `DiseaseCardModule`（`apps/web/src/components/*.test.tsx`）。

### 8.2 集成测试

- Meta WhatsApp Webhook 签名验证与解析；
- 数据库读写和迁移；
- PDF 生成流程。

### 8.3 端到端测试

- `tests/scenarios/run-scenario.ts` 通过本地测试工具 API 执行 scenario 脚本并断言；
- `tests/scenarios/run-all.ts` 顺序运行所有 scenario 并输出汇总表格；
- 已内置六个 scenario：
  - `controlled-asthma-short.json`：controlled asthma persona，完成两次 check-in，验证 Disease Card 生成；
  - `worsening-override.json`：worsening asthma persona，模拟症状加重输入，验证 check-in 结束与 Disease Card 生成；
  - `exception-mode-short.json`：adverse_event persona，验证异常模式、澄清问题、安全提示与 Disease Card Adverse Events；
  - `brief-pdf-e2e.json`：完成一次 check-in 后生成 Brief，验证 HTML 视图与 PDF 导出；
  - `cross-cycle-late-reply.json`：完成 check-in 并停止 cycle 后，验证跨 cycle 迟到回答经用户确认后保存到最近 cycle；
  - `full-7-day-trial.json`：模拟完整 7 天试用，完成 4 次 check-in，验证 Disease Card 与 observation 聚合。

### 8.4 合规测试

- 诊断性/治疗性语言过滤；
- 用户删除账户后数据不可恢复（`DELETE MY DATA` 硬删除）；
- 用户可导出个人数据（`EXPORT MY DATA` + 7 天有效安全链接，默认排除 LLM 审计日志）；
- 运营方可通过 admin API 查询指标、导出用户完整数据、执行 GDPR 删除；
- 过期/错误 token 无法访问 Brief / 导出 / 记录页。

---

## 9. 安全与合规红线

### 9.1 不做诊断、不替代医生

- 不能由系统判断患者是否需要急救；
- 不能提供治疗建议或用药调整；
- 所有输出必须标注"患者自报信息，供复诊参考"。

### 9.2 数据隐私

- 健康数据属于敏感个人信息；
- 遵守 UK GDPR / GDPR 数据最小化原则；
- 用户可导出、删除自己的数据；
- 不与第三方共享健康数据，不用于广告或模型训练；
- 消费级 WhatsApp 不直接用于临床沟通；Brief 通过 Web / PDF / Email 传递给医生。

### 9.3 平台合规

- 使用 WhatsApp Business API 官方渠道，不使用个人账号自动化；
- 所有主动消息模板需通过 Meta 审核；
- 哮喘相关回复必须包含急救提示兜底（如拨打 999）。

### 9.4 内容安全

- 不在 IM 中保留完整敏感记录，详细内容存放到安全 Web/PWA 页面；
- Brief 页面和 PDF 必须包含免责声明；
- 系统命令（START ASTHMA / STOP / HELP / DELETE MY DATA / EXPORT MY DATA / AGREE / SKIP / CONTINUE / YES）在感知层硬编码处理；
- 高风险安全标记触发急救提示快速路径。

---

## 10. 部署流程

### 10.1 CI/CD

- `.github/workflows/ci.yml`：push/PR 到 `main` 时依次执行：
  1. `check` job：安装依赖 → typecheck → test → build；
  2. `e2e` job（依赖 check）：安装依赖 → build → 启动本地 PostgreSQL + Redis → 执行 Prisma 迁移 → 启动 API → 等待 health → 运行 `pnpm test:e2e:staging` → 清理基础设施；
- `.github/workflows/deploy.yml`：CI 通过后（`workflow_run`）或手动 dispatch（`workflow_dispatch`）执行：
  1. 构建并推送 `ghcr.io/<repo>/api:latest` 与 `ghcr.io/<repo>/api:<sha>` 到 GitHub Container Registry（Docker Buildx + GHA cache）；
  2. 可选触发 Render API / Web deploy hook（需配置 `RENDER_API_DEPLOY_HOOK_URL` / `RENDER_WEB_DEPLOY_HOOK_URL` secrets）；
  3. 若配置 `STAGING_API_BASE_URL` + `TEST_TOOL_API_KEY`，自动等待 `/health`（最多 5 分钟）并运行 `pnpm test:e2e:staging`；
- deploy workflow 配置了 `concurrency: deploy` 取消进行中的旧部署。

### 10.2 容器

- 根目录 `Dockerfile` 多阶段构建：
  1. `base`：node:22-slim + corepack enable pnpm@9.0.0；
  2. `deps`：复制各 workspace 的 `package.json` + lockfile → `pnpm install --frozen-lockfile`；
  3. `build`：复制全部源码 → `pnpm build`；
  4. `production`：node:22-slim，仅复制运行时文件（`apps/api/dist`、`apps/api/public`、`apps/api/package.json`、`packages/`、`node_modules/`、`pnpm-workspace.yaml`、`package.json`）；
- 生产镜像暴露 3000 端口；
- 启动命令：`node apps/api/dist/index.js`；
- 自托管生产栈：`infra/docker-compose.prod.yml`（API + PostgreSQL + Redis + 可选 migrate profile）。

### 10.3 Render

- `infra/render.yaml` 定义：
  - `carememory-api`（Docker Web 服务，健康检查 `/health`，默认 PORT=3000）；
  - `carememory-web`（Node Web 服务，Next.js，`buildCommand: pnpm install --frozen-lockfile && pnpm build`，`startCommand: pnpm --filter @carememory/web start`）；
  - `carememory-db`（托管 PostgreSQL，starter 计划）；
  - `carememory-redis`（托管 Redis，starter 计划，noeviction 策略）；
- 首次部署后需在 Render 服务 shell 中手动执行 `cd packages/db && npx prisma migrate deploy` 完成迁移；
- staging API 需开启 `ENABLE_TEST_TOOL=true` 并设置 `TEST_TOOL_API_KEY`；生产环境必须保持 `ENABLE_TEST_TOOL=false`；
- secrets（ENCRYPTION_KEY、JWT_SECRET、ADMIN_API_KEY、WhatsApp 凭证、OPENAI_API_KEY 等）需在 Render Dashboard 手动设置，蓝图不暴露 secrets。

### 10.4 未来待补充

- Secrets 管理（Render Dashboard secrets 或 Doppler / 1Password）；
- 告警渠道与 on-call 流程（Sentry alerting + PagerDuty / Opsgenie）；
- 日志聚合（Logtail / Better Stack）与结构化日志查询面板；
- 备份与灾难恢复。

---

## 11. 对 AI 编码代理的建议

1. **以文档为准**：实现功能前阅读 `docs/PRD.md`、`docs/tech-spec.md`、`docs/func-spec.md`、`docs/decisions.md`；
2. **不要假设技术栈**：在代码仓库出现明确配置前，不要引入框架或依赖；
3. **合规优先**：健康数据、医疗建议边界、IM 平台规则是第一约束；
4. **保持极简**：MVP 只支持英国 × 哮喘 × WhatsApp，不提前做多市场、多病种、多平台；
5. **先验证再扩张**：首个版本服务于 30 天冷启动验证，支持 1,000 名试用用户即可；
6. **修改本文件**：若你创建了代码结构、选定了技术栈、建立了测试或部署流程，请同步更新本文件对应章节；
7. **ESM 导入规范**：TypeScript 使用 NodeNext 模块解析，导入本地模块时必须带 `.js` 扩展名（Web 项目 `apps/web` 使用 bundler 模块解析，不需要 `.js` 扩展名）；
8. **LLM 配置**：不要硬编码 LLM 默认值，所有 LLM 配置走 `loadLLMConfig()` 从环境变量读取；新增 LLM 环境变量使用 `LLM_*` 命名规范；
9. **包依赖方向**：`packages/*` 之间通过 `workspace:*` 引用，`apps/*` 消费 `packages/*`；新增跨包依赖时确认依赖方向合理；
10. **测试优先**：修改引擎逻辑或 API 路由时，同步补充或更新对应测试文件。

---

## 12. 如何更新本文件

- 确定技术栈后，更新第 4、7 节；
- 创建代码结构后，更新第 5 节；
- 建立开发规范后，更新第 6 节；
- 引入测试后，更新第 8 节；
- 部署上线后，更新第 10 节；
- 安全合规要求变化时，更新第 9 节。

---

*最后更新：2026-06-29（基于实际项目结构与代码验证后重写）。*

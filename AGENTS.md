# CareMemory — AI 编码代理须知

> 本文件面向为本项目编写代码的 AI 代理。只保留与开发、运行、维护相关的信息。

---

## 1. 项目概述

**CareMemory** 帮助患者在两次复诊之间通过即时通讯工具轻量记录健康信息，由 AI 引擎动态管理随访问题，并生成持续更新的 **Disease Card（疾病卡片）** 及其复诊前导出形态 **Web Brief / PDF**。

首个 MVP 聚焦：

- **市场**：英国（UK）
- **疾病**：哮喘（Asthma）
- **IM 入口**：WhatsApp

产品定位：

- **Health Memory**：把复诊前的“健康故事”结构化；
- **AI-native Engine**：用 LLM + RAG 驱动每日问题路径、异常追问和疾病卡片生成；
- **IM-first**：用 WhatsApp 做轻量记录；
- **Disease Card**：患者的长期疾病肖像，患者主看；
- **Doctor Brief**：从 Disease Card 截取的一页式复诊摘要，医生主看。

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

---

## 3. 当前项目状态

### 3.1 文件结构

```
CareMemory/
├── apps/
│   ├── api/                 # Fastify 后端：Webhook、对话引擎、调度、Brief API、本地测试工具
│   │   ├── src/
│   │   │   ├── routes/      # API 路由（webhooks、test-tool、briefs、export、health）
│   │   │   ├── test-tool/   # 本地测试工具 persona 库
│   │   │   ├── plugins/     # Fastify 插件（prisma、redis、clock）
│   │   │   ├── lib/         # 共享工具（PDF 渲染、导出 token、LLM client）
│   │   │   └── index.ts     # 服务入口
│   │   └── public/test-tool/# 本地测试工具静态 UI
│   └── web/                 # Next.js Web Disease Card / Brief 页面 + PDF 渲染
│       ├── src/app/global-error.tsx   # Sentry 全局错误边界
│       ├── src/instrumentation.ts     # Sentry 服务端/edge 初始化
│       ├── instrumentation-client.ts  # Sentry 客户端初始化
│       ├── sentry.server.config.ts    # Sentry server config
│       ├── sentry.edge.config.ts      # Sentry edge config
│       └── next.config.ts             # withSentryConfig 包装
├── packages/
│   ├── db/                  # Prisma schema、client、迁移脚本
│   ├── engine/              # 六层 AI 引擎核心（perception/memory/planner/dialogue/safety/llm）
│   ├── rag/                 # RAG Corpus 文档与检索接口
│   ├── im-core/             # 平台无关消息模型、IM Adapter 接口
│   ├── im-whatsapp/         # WhatsApp Adapter（MVP）
│   ├── disease-card/        # Disease Card 生成与模板
│   └── brief-templates/     # Brief HTML/PDF 模板
├── infra/
│   ├── docker-compose.yml          # 本地 PostgreSQL + Redis + pgvector
│   ├── docker-compose.prod.yml     # 自托管生产栈（API + Postgres + Redis）
│   └── render.yaml                 # Render Blueprint（API + Web + Postgres + Redis）
├── tests/
│   └── scenarios/                  # 本地测试 scenario JSON + runner / 汇总器
├── .github/
│   └── workflows/
│       ├── ci.yml                  # PR/Push：typecheck / test / build
│       └── deploy.yml              # main 合并后构建并推送 API Docker 镜像
├── docs/                           # 产品与技术文档
├── Dockerfile                      # API 生产镜像
├── .dockerignore
├── package.json                    # pnpm workspaces root
├── pnpm-workspace.yaml
├── turbo.json
├── .env.example
└── AGENTS.md                       # 本文件
```

### 3.2 工程状态

- 已初始化 pnpm workspaces monorepo 与根目录配置。
- 已选定技术栈：Node.js + TypeScript + Fastify + PostgreSQL + Prisma + Redis + BullMQ + Next.js + Playwright。
- 已创建 `packages/db` 与 Prisma schema，本地基础设施（docker-compose）就绪。
- 已实现 `apps/api`（Fastify 后端 + 引擎骨架 + 本地测试工具 + Brief API + GDPR 导出/删除），可本地跑通 onboarding → check-in → Disease Card → Brief / PDF 的最小闭环。
- 已实现 `apps/web`（Next.js Disease Card / Brief / Privacy Policy / Records 页面，含 PDF 下载按钮）；已配置 vitest + @testing-library/react + jsdom，并对 `BriefActions`、`DiseaseCardModule` 组件编写了单元测试。
- 已实现 `packages/im-core`、`packages/im-whatsapp`、`packages/engine`、`packages/disease-card`、`packages/brief-templates`。
- 已实现 `packages/rag`（哮喘 RAG Corpus + 关键词检索），并已接入 Planner 生成 reasoning。
- 已引入 vitest，为 `packages/engine`、`packages/rag`、`packages/im-whatsapp` 编写了单元测试。
- 已实现 WhatsApp Webhook HMAC-SHA256 签名验证、raw body 插件，以及 Meta Graph API outbound 消息发送客户端（配置真实 token 后自动发送，否则保持本地返回）。
- 已实现 LLM 抽象（OpenAI provider + stub），Perception / Planner 在 `OPENAI_API_KEY` 配置时调用 LLM，失败或无 key 时自动降级为规则逻辑。
- 已补充 GitHub Actions CI（typecheck / test / build / e2e scenario）。
- 本地测试工具已增强：虚拟 Clock、6 个内置 persona、session export/replay、L1/L4/L6 trace inspector。
- 已补充生产部署骨架：API Dockerfile、自托管 `docker-compose.prod.yml`、GitHub Actions 构建并推送容器镜像。
- 已补充完整 onboarding 流程（昵称 → 年龄校验 → 下次复诊 → 用药基线 → active cycle）。
- 已实现 LLM 调用审计日志（Event 表记录 model/input/output/token usage）。
- 已实现异常模式（exception mode）：检测到中高风险异常时追加最多 3 个澄清问题，结束后标准安全提示并写入 Disease Card Adverse Events。
- 已实现 check-in 自动调度与 24 小时提醒，状态持久化到数据库，服务重启后可恢复；调度器已迁移至 BullMQ（Redis repeatable job + Worker），服务关闭时优雅停止。
- 已实现 Disease Card 访问令牌与患者记录页（`/c/[cardId]?t=...` 与 `/records?t=...`）。
- 已实现 WhatsApp 24h session window 检测与模板消息 fallback；`packages/im-whatsapp/src/templates.ts` 定义了 MVP 模板文案、变量与智能模板选择逻辑。
- 已实现 RAG reindex CLI：`pnpm corpus:reindex` 重新生成 `packages/rag/src/corpus.ts`。
- 已补充 GDPR 导出格式（`carememory-gdpr-export-v1`，7 天有效链接，默认排除 LLM 审计日志）与 admin/metrics API（`ADMIN_API_KEY` 鉴权）。
- 已实现用户修正历史回答：感知层识别修正意图，原 observation 标记 `superseded=true`，新 observation 替代生效。
- 已实现迟到回答处理：同一 active cycle 内无 active check-in 的回复会被接受为补充更新；跨 cycle 场景下系统询问用户是否与最近记录相关，用户确认（YES / Add to last record）后保存到最近 cycle。
- 已实现 LLM 成本限流：用户级每日软上限（`LLM_DAILY_LIMIT_USER`）、备用模型降级（`LLM_FALLBACK_MODEL`）；每日调用计数已从 DB `COUNT` 迁移到 Redis（`llm:daily:<userId>:<dayKey>`），通过 `apps/api/src/lib/quota-store.ts` 原子递增并设置当天过期。
- 已实现 A/B 测试框架：基于 userId hash 的稳定分桶，已用于 check-in 频率（48h/72h）与对话风格（v1/v2）。
- 已实现崩溃恢复与幂等性：入站消息按 `platformMessageId` 去重，出站消息带 `idempotencyKey` 避免重复发送。
- 已统一出站消息幂等性：engine 在 `saveOutboundMessages` 中生成 `idempotencyKey` 并写入 `outbound_message` 事件（状态 `pending`），dispatch 层读取已有事件并更新为 `sent`/`failed`，避免 engine 与 dispatch 重复创建事件；key 以 `inboundEventId` / `checkIn.id` 为 salt，确保不同逻辑 outbound 不会冲突。
- 已实现 4 周周期延续：`PLAN_4_WEEK` cycle 在 28 天结束时提示 CONTINUE，用户回复后创建下一个周期。
- 已补充端到端回归 scenario runner（`tests/scenarios/run-scenario.ts`），内置六个 scenario，支持 `message` / `planner` / `safety` / `observation` / `diseaseCard` / `brief` / `pdf` 断言，已在本地 API 验证通过。
- 已补充 Render 部署蓝图：`infra/render.yaml` 定义 API / Web / PostgreSQL / Redis 服务，GitHub Actions `deploy.yml` 可选触发 Render deploy hook。
- 已接入可观测性：API 使用 `@sentry/node` 捕获异常，Next.js Web 使用 `@sentry/nextjs`；API 结构化 JSON 日志通过 Fastify/pino 输出，支持 `LOG_LEVEL` 与敏感字段脱敏。
- 已增强 `/health` 端点：返回 PostgreSQL / Redis 依赖检查结果与 `version`。
- 已重构 E2E runner：`tests/scenarios/run-scenario.ts` 支持程序化复用，`tests/scenarios/run-all.ts` 可顺序运行所有 scenario 并输出汇总表格；新增 `pnpm test:e2e:staging`，用于针对任意 `API_BASE_URL`（本地或 staging）做冒烟测试。
- 已为 staging E2E 加固本地测试工具：`/dev/test-tool/*` 在 `NODE_ENV=production` 下必须提供 `TEST_TOOL_API_KEY` 才能访问，生产环境保持禁用；详见 `docs/staging-e2e-runbook.md`。
- 已更新部署工作流：`.github/workflows/deploy.yml` 在 Render 部署后自动等待 `/health` 并就绪后运行 staging E2E smoke。

---

## 4. 已确定技术栈

> 以 `docs/tech-spec.md` 第 3 节为准。MVP 已采用以下技术选型。

| 层级 | 选型 |
|------|------|
| Monorepo | pnpm workspaces + Turbo |
| 后端运行时 | Node.js 22 LTS + TypeScript |
| Web 框架 | Fastify 5.x |
| 数据库 | PostgreSQL 16 + Prisma 6.x |
| 缓存 / 任务队列 | Redis 7 + BullMQ |
| IM 接入 | Meta WhatsApp Business API（MVP 先用本地测试工具模拟） |
| Web 前端 | Next.js 15 (App Router) + Tailwind CSS |
| PDF 生成 | Playwright 无头渲染 |
| 向量检索 | pgvector（同一 PostgreSQL） |
| LLM | OpenAI GPT-4o / GPT-4o-mini（环境变量配置） |
| 本地测试工具 | Fastify dev-only 路由 + 静态 HTML/JS |
| 部署（计划） | Render（蓝图已落地：`infra/render.yaml`）；自托管备用 `infra/docker-compose.prod.yml` |
| 监控（计划） | Sentry + Logtail |

新增框架或依赖前，请先在 `docs/tech-spec.md` 与本文件同步更新。

---

## 5. 代码组织

```
CareMemory/
├── apps/
│   ├── api/                 # Fastify 后端：Webhook、对话引擎、调度、Brief API、本地测试工具
│   │   ├── src/
│   │   │   ├── routes/      # API 路由（webhooks、test-tool、briefs、export、health）
│   │   │   ├── test-tool/   # persona 库与测试工具业务逻辑
│   │   │   ├── plugins/     # Fastify 插件（prisma、redis、clock）
│   │   │   ├── lib/         # 共享工具（PDF 渲染、导出 token、LLM client）
│   │   │   └── index.ts     # 服务入口
│   │   └── public/test-tool/# 本地测试工具静态 UI
│   └── web/                 # Next.js：Disease Card / Brief / Records 页面
├── packages/
│   ├── db/                  # Prisma schema、client、迁移脚本
│   ├── engine/              # 六层 AI 引擎核心
│   │   ├── src/
│   │   │   ├── engine.ts
│   │   │   ├── perception.ts
│   │   │   ├── perception.test.ts
│   │   │   ├── planner.ts
│   │   │   ├── planner.test.ts
│   │   │   ├── dialogue.ts
│   │   │   ├── safety.ts
│   │   │   ├── safety.test.ts
│   │   │   ├── memory.ts
│   │   │   ├── llm.ts
│   │   │   ├── llm.test.ts
│   │   │   └── types.ts
│   ├── rag/                 # RAG Corpus 文档与检索接口
│   │   ├── corpus/
│   │   │   └── diseases/
│   │   │       └── asthma/
│   │   └── src/
│   │       ├── corpus.ts
│   │       ├── index.ts
│   │       └── index.test.ts
│   ├── im-core/             # 平台无关消息模型、IM Adapter 接口
│   ├── im-whatsapp/         # WhatsApp Adapter（MVP）
│   ├── disease-card/        # Disease Card 生成与模板
│   └── brief-templates/     # Brief HTML/PDF 模板
├── infra/
│   └── docker-compose.yml   # 本地 PostgreSQL + Redis + pgvector
├── tests/
│   └── scenarios/           # 本地测试 scenario JSON 与 runner
└── docs/                    # 产品与技术文档
```

---

## 6. 开发规范

代码结构建立后，建议约定：

- **格式化**：Prettier（前端/TS）、SQLFlame（若用 Python）
- **提交规范**：Conventional Commits
- **分支模型**：trunk-based，功能通过 short-lived branch 合并
- **代码审查**：所有代码通过 PR/MR 合并
- **密钥管理**：使用 `.env` + 环境变量，不提交密钥；生产使用托管 secrets 服务

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
cp .env.example .env
pnpm db:migrate

# 5. （可选）种子数据
pnpm db:seed

# 6. 启动开发服务器（api + web）
pnpm dev
```

### 7.3 常用命令

| 命令 | 说明 |
|------|------|
| `pnpm dev` | 同时启动 apps/api 与 apps/web |
| `pnpm db:migrate` | 执行 Prisma 迁移 |
| `pnpm db:studio` | 打开 Prisma Studio |
| `pnpm infra:up` | 启动 PostgreSQL + Redis |
| `pnpm infra:down` | 停止本地基础设施 |
| `pnpm build` | 构建所有应用与包 |
| `pnpm typecheck` | 全仓类型检查 |
| `pnpm test` | 运行单元/集成测试套件 |
| `pnpm test:e2e:controlled` | 运行 controlled asthma 端到端 scenario（需先启动 API + DB） |
| `pnpm test:e2e:worsening` | 运行 worsening asthma 端到端 scenario（需先启动 API + DB） |
| `pnpm test:e2e:exception` | 运行异常模式端到端 scenario（需先启动 API + DB） |
| `pnpm test:e2e:brief` | 运行 Brief/PDF 端到端 scenario（需先启动 API + DB） |
| `pnpm test:e2e:cross-cycle` | 运行跨 cycle 迟到回答端到端 scenario（需先启动 API + DB） |
| `pnpm test:e2e:7day` | 运行完整 7 天试用端到端 scenario（需先启动 API + DB） |
| `pnpm test:e2e:staging` | 顺序运行所有 E2E scenario，可针对 `API_BASE_URL` 做冒烟测试 |
| `pnpm corpus:reindex` | 重新索引 RAG Corpus（`packages/rag/documents/<disease>/*.md`） |

### 7.4 本地测试工具

开发模式下访问 `http://localhost:3055/dev/test-tool`，可在浏览器中：

- 模拟患者对话（文本 / 按钮）；
- 加载内置 persona（controlled/worsening/exercise/adverse_event/non_responder/early_quit）；
- 控制虚拟时间（Next Check-in / +1 day）；
- 查看 L1 感知、L4 Planner、L6 Safety 的实时 trace；
- 导出当前 session JSON，或通过 `/dev/test-tool/api/replay-session` 重放脚本。

---

## 8. 测试策略

### 8.1 单元测试

运行：`pnpm --filter @carememory/engine test`

- 对话引擎状态转换
- 记录规范化与汇总逻辑
- Brief 生成逻辑
- 消息模板渲染
- 当前已覆盖：
  - 感知层系统指令 / 按钮映射 / 安全标记（`packages/engine/src/perception.test.ts`）
  - Planner 问题路径、预算耗尽、安全响应（`packages/engine/src/planner.test.ts`）
  - 安全层诊断/治疗语言过滤与免责声明追加（`packages/engine/src/safety.test.ts`）
  - LLM client、LLM 驱动的感知/规划与降级（`packages/engine/src/llm.test.ts`）
  - RAG Corpus 加载与检索（`packages/rag/src/index.test.ts`）
  - WhatsApp Webhook 签名验证、解析与 outbound 发送（`packages/im-whatsapp/src/index.test.ts`、`packages/im-whatsapp/src/sender.test.ts`）
  - outbound 消息持久化与幂等性 key 生成（`packages/engine/src/memory.test.ts`）
  - dispatch 层去重、重试与状态更新（`apps/api/src/lib/dispatch-outbound.test.ts`）
  - admin 路由鉴权、metrics、GDPR 导出与删除（`apps/api/src/routes/admin.test.ts`）
  - BullMQ scheduler 生命周期、repeatable job 注册、scan-checkins / scan-reminders 处理器（`apps/api/src/services/scheduler.test.ts`）
  - Redis-backed LLM quota store（`apps/api/src/lib/quota-store.test.ts`）与 engine quota 接口（`packages/engine/src/llm-quota.test.ts`）
  - Web 组件：`BriefActions` 与 `DiseaseCardModule`（`apps/web/src/components/*.test.tsx`）

### 8.2 集成测试

- Meta WhatsApp Webhook 签名验证与解析
- 数据库读写和迁移
- PDF 生成流程

### 8.3 端到端测试

- 已新增 `tests/scenarios/run-scenario.ts`，通过本地测试工具 API 执行 scenario 脚本并断言。
- 已内置六个 scenario：
  - `controlled-asthma-short.json`：加载 controlled_asthma persona，完成两次 check-in，验证 Disease Card 生成。
  - `worsening-override.json`：加载 worsening_asthma persona，模拟症状加重输入，验证 check-in 结束与 Disease Card 生成。
  - `exception-mode-short.json`：加载 adverse_event persona，验证异常模式、澄清问题、安全提示与 Disease Card Adverse Events。
  - `brief-pdf-e2e.json`：完成一次 check-in 后生成 Brief，验证 HTML 视图与 PDF 导出。
  - `cross-cycle-late-reply.json`：完成 check-in 并停止 cycle 后，验证跨 cycle 迟到回答经用户确认后保存到最近 cycle。
  - `full-7-day-trial.json`：模拟完整 7 天试用，完成 4 次 check-in，验证 Disease Card 与 observation 聚合。
- 待补充：生产环境 E2E。

### 8.4 合规测试

- 诊断性/治疗性语言过滤
- 用户删除账户后数据不可恢复（已实现 `DELETE MY DATA` 硬删除并验证数据库无残留）
- 用户可导出个人数据（已实现 `EXPORT MY DATA` + 7 天有效安全链接，默认排除 LLM 审计日志）
- 运营方可通过 admin API 查询指标、导出用户完整数据、执行 GDPR 删除
- 过期/错误 token 无法访问 Brief / 导出 / 记录页

---

## 9. 安全与合规红线

### 9.1 不做诊断、不替代医生

- 不能由系统判断患者是否需要急救。
- 不能提供治疗建议或用药调整。
- 所有输出必须标注“患者自报信息，供复诊参考”。

### 9.2 数据隐私

- 健康数据属于敏感个人信息。
- 遵守 UK GDPR / GDPR 数据最小化原则。
- 用户可导出、删除自己的数据。
- 不与第三方共享健康数据，不用于广告或模型训练。
- 消费级 WhatsApp 不直接用于临床沟通；Brief 通过 Web / PDF / Email 传递给医生。

### 9.3 平台合规

- 使用 WhatsApp Business API 官方渠道，不使用个人账号自动化。
- 所有主动消息模板需通过 Meta 审核。
- 哮喘相关回复必须包含急救提示兜底（如拨打 999）。

### 9.4 内容安全

- 不在 IM 中保留完整敏感记录，详细内容存放到安全 Web/PWA 页面。
- Brief 页面和 PDF 必须包含免责声明。

---

## 10. 部署流程

已补充：

- GitHub Actions CI：`.github/workflows/ci.yml`，在 push/PR 时运行 `pnpm typecheck`、`pnpm test`、`pnpm build`，以及针对本地测试工具的 E2E scenario。
- API 生产容器：根目录 `Dockerfile` 构建整个 workspace 后运行 `apps/api`。
- 自托管生产栈：`infra/docker-compose.prod.yml`（API + PostgreSQL + Redis + 可选 migrate profile）。
- Render 蓝图：`infra/render.yaml` 定义 `carememory-api`（Docker）、`carememory-web`（Node）、托管 PostgreSQL 与 Redis；首次部署后需在 Render 服务 shell 中手动执行 `pnpm db:deploy` 完成迁移。
- CD 工作流：`.github/workflows/deploy.yml` 在 CI 通过后构建并推送 `ghcr.io/${repo}/api:latest` 与 `${sha}` 标签；可选触发 Render deploy hook；若配置 `STAGING_API_BASE_URL` + `TEST_TOOL_API_KEY` 则自动等待 `/health` 并运行 `pnpm test:e2e:staging` 做部署后冒烟。
- Staging E2E：见 `docs/staging-e2e-runbook.md`，staging API 需开启 `ENABLE_TEST_TOOL=true` 并设置 `TEST_TOOL_API_KEY`；生产环境必须保持 `ENABLE_TEST_TOOL=false`。

未来待补充：

- Secrets 管理（Render Dashboard secrets 或 Doppler / 1Password）
- 告警渠道与 on-call 流程（Sentry alerting + PagerDuty / Opsgenie）
- 日志聚合（Logtail / Better Stack）与结构化日志查询面板
- 备份与灾难恢复

---

## 11. 对 AI 编码代理的建议

1. **以文档为准**：实现功能前阅读 `docs/PRD.md`、`docs/tech-spec.md`、`docs/func-spec.md`。
2. **不要假设技术栈**：在代码仓库出现明确配置前，不要引入框架或依赖。
3. **合规优先**：健康数据、医疗建议边界、IM 平台规则是第一约束。
4. **保持极简**：MVP 只支持英国 × 哮喘 × WhatsApp，不提前做多市场、多病种、多平台。
5. **先验证再扩张**：首个版本服务于 30 天冷启动验证，支持 1,000 名试用用户即可。
6. **修改本文件**：若你创建了代码结构、选定了技术栈、建立了测试或部署流程，请同步更新本文件对应章节。

---

## 12. 如何更新本文件

- 确定技术栈后，更新第 4、7 节。
- 创建代码结构后，更新第 5 节。
- 建立开发规范后，更新第 6 节。
- 引入测试后，更新第 8 节。
- 部署上线后，更新第 10 节。
- 安全合规要求变化时，更新第 9 节。

---

*最后更新：2026-06-15（Sentry 可观测性、结构化日志、增强 health、staging E2E runner、test-tool staging 鉴权、Render 部署蓝图已落地）。*

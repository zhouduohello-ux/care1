# CareMemory

AI-native 复诊前健康记忆引擎。

首个 MVP：英国 × 哮喘 × WhatsApp。

## 技术栈

- **Monorepo**: pnpm workspaces + Turbo
- **Backend**: Node.js 22 + TypeScript + Fastify 5
- **Database**: PostgreSQL 16 + Prisma 6
- **Queue**: Redis 7 + BullMQ
- **Web**: Next.js 15
- **PDF**: Playwright（待实现 PDF 下载按钮）
- **Local Test Tool**: Fastify dev-only 路由 + 浏览器聊天模拟器

## 快速开始

```bash
# 1. 安装依赖
pnpm install

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env（默认端口 5435/6381 已避开常见本地服务）

# 3. 启动本地基础设施
pnpm infra:up

# 4. 数据库迁移
pnpm db:migrate

# 5. 启动后端
pnpm --filter @carememory/api start

# 6. 打开本地测试工具
open http://localhost:3055/dev/test-tool
```

## 项目结构

```
CareMemory/
├── apps/
│   ├── api/                 # Fastify 后端 + 本地测试工具 + Brief API
│   └── web/                 # Next.js 前端：Disease Card / Brief 页面
├── packages/
│   ├── db/                  # Prisma schema + client
│   ├── engine/              # 六层 AI 引擎
│   ├── im-core/             # 平台无关消息模型
│   ├── im-whatsapp/         # WhatsApp Adapter
│   ├── disease-card/        # Disease Card 生成
│   ├── brief-templates/     # Brief HTML 模板
│   └── rag-corpus/          # RAG Corpus（待实现）
├── infra/
│   └── docker-compose.yml   # PostgreSQL + Redis
└── docs/                    # 产品与技术文档
```

## 已实现

- [x] pnpm monorepo 与本地基础设施
- [x] Prisma schema 与迁移
- [x] Fastify API 骨架与插件（Prisma、Redis、Clock）
- [x] 平台无关 IM 消息模型与 WhatsApp Adapter
- [x] 六层引擎骨架（感知、记忆、规划、对话、安全）
- [x] Onboarding 流程：START ASTHMA → AGREE → 激活周期
- [x] Check-in 调度与虚拟时间推进
- [x] 本地测试工具 UI + API
- [x] 安全兜底：哮喘急救提示、诊断/治疗语言拦截
- [x] Disease Card 生成与 `/c/[cardId]` 页面
- [x] Brief 生成 API 与 `/b/[briefId]` 页面

## 进行中 / 待实现

- [ ] PDF 下载按钮与 Playwright 渲染
- [ ] RAG Corpus 与向量检索
- [ ] RAG Corpus 与向量检索
- [ ] 真实 WhatsApp Business API 接入
- [ ] 用户账户删除与数据导出
- [ ] 完整测试套件

## 文档

- `docs/PRD.md` — 产品需求
- `docs/tech-spec.md` — 技术规格
- `docs/func-spec.md` — 功能规格
- `docs/decisions.md` — 关键设计决策
- `docs/local-testing-tool.md` — 本地测试工具设计
- `AGENTS.md` — AI 编码代理须知

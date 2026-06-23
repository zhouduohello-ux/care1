# CareMemory 本地测试工具设计

> **版本**：v0.2  
> **日期**：2026-06-15  
> **对应文档**：`docs/tech-spec.md`、`docs/func-spec.md`  
> **目标**：在不连接 WhatsApp、不等待真实时间流逝的情况下，本地模拟、自动化测试和 AI 主导回归 CareMemory AI-native 引擎

---

## 1. 设计目标

本地测试工具是一个**开发/调试 simulator + 自动化测试框架**，让产品、研发、医学顾问和 AI 代理能够：

1. **无需 WhatsApp**：在浏览器里用一个聊天输入框模拟患者对话；
2. **控制时间**：手动或自动推进到「下一天」「下一 check-in 点」，不用等 24/48 小时；
3. **观察引擎内部**：查看每一层（L1–L6）的输入输出；
4. **快速切换场景**：加载不同测试 persona（哮喘控制良好、症状加重、不良反应等）；
5. **CLI 自动化**：通过命令行运行 scenario、验证断言、生成报告；
6. **AI 主导测试**：AI 代理可批量运行回归套件、分析失败项、生成人类审查报告；
7. **回归测试**：保存/重放对话脚本，验证改动后引擎行为是否一致。

这个工具只在 **开发环境（`NODE_ENV=development` 或 `local`）** 启用，绝不暴露到生产环境。

---

## 2. 核心功能

### 2.1 浏览器聊天界面

- 左侧：聊天窗口，模拟 WhatsApp 对话；
- 右侧：引擎调试面板，显示当前会话状态；
- 用户可发送：
  - 自由文本；
  - 快捷按钮（模拟 WhatsApp 按钮回复）；
  - 系统指令（如 `START ASTHMA`、`STOP`、`HELP`）。

### 2.2 时间控制

- **当前虚拟时间**：显示当前模拟的日期和时间；
- **推进 1 小时 / 1 天 / 到下一个 check-in**：按钮一键推进；
- **自动模式**：按设定倍速（如 1 天 = 10 秒）自动推进，用于演示完整 7 天旅程；
- **重置时间**：回到 Day 0。

### 2.3 引擎状态 inspector

对应当前消息，显示：

| 层级 | 显示内容 |
|------|----------|
| L1 感知层 | 提取的 observations、意图、异常标记、安全标记 |
| L2 记忆层 | 最新 Event、Observation、Narrative Summary、Disease Card |
| L3 RAG | 本次检索到的 Care Strategy / Medical KB / Patterns 片段 |
| L4 Planner | Session Objective、Next Action、Reasoning、预算状态 |
| L5 对话层 | 生成的 OutboundMessage、平台约束校验结果 |
| L6 安全层 | 校验结果、追加的安全提示、风险等级 |

### 2.4 Scenario / Persona 管理

内置常见测试场景：

| Persona | 说明 |
|---------|------|
| `controlled_asthma` | 控制良好，规律用药，无夜间症状 |
| `worsening_asthma` | 夜间症状增加，吸入药使用增加 |
| `exercise_trigger` | 运动后喘息，诱因明确 |
| `adverse_event` | 报告用药后不良反应 |
| `non_responder` | 多次不回复消息 |
| `early_quit` | 中途发送 STOP |

支持自定义 scenario JSON，预置一组初始患者状态和预期对话脚本。

### 2.5 记录与重放

- 保存一次完整对话为 `.carememory-test.json`；
- 可加载并重放，用于回归测试；
- 重放时可选择「单步执行」或「自动执行」。

### 2.6 CLI 工具

- 命令行运行 scenario、suite、replay、verify；
- 人类可读输出 + JSON / JUnit CI 输出；
- 不依赖浏览器，适合 AI 代理和 CI 流水线。

### 2.7 自动化断言与 AI-led Evaluation

- 对消息、Planner 输出、安全结果、Observation、Disease Card 做断言；
- Snapshot 回归测试；
- LLM judge 评估对话自然度、共情度、合规性；
- 生成结构化报告供人类审查。

---

## 3. 架构设计

### 3.1 部署形态

本地测试工具是 **backend 的一部分**，在开发模式下挂载到 `/dev/test-tool` 路径：

```
Backend (Fastify)
├── /webhooks/whatsapp          # 生产 WhatsApp Webhook
├── /dev/test-tool              # 本地测试工具 UI（仅 dev）
├── /dev/test-tool/api          # 测试工具 API（仅 dev）
└── /engine/*                   # 引擎内部 API
```

或者拆分为独立的 Next.js dev app：

```
apps/
├── api/              # 生产后端
├── web/              # 生产 Web Disease Card / Brief
└── test-tool/        # 本地测试工具（Next.js + 直连 backend）
```

**推荐 MVP 方案**：作为 backend 的 dev-only 路由，减少项目复杂度。

### 3.2 数据流

```
浏览器输入框
    │
    ▼
/dev/test-tool/api/simulate-message
    │
    ▼
构造 InboundMessage（platform="test"）
    │
    ▼
直接调用 Engine.handleInbound()  // 跳过 IM Adapter
    │
    ▼
引擎六层处理
    │
    ▼
返回完整 trace（L1–L6 输出）
    │
    ▼
浏览器渲染聊天消息 + inspector 面板
```

### 3.3 时间控制实现

- 使用一个可注入的 **Clock Service** 替代 `Date.now()`；
- 默认模式：真实时间；
- 测试模式：虚拟时间，由测试工具控制；
- BullMQ 调度器在测试模式下使用虚拟 clock 计算 `nextCheckinAt`。

```typescript
interface Clock {
  now(): Date;
  advance(ms: number): void;
  setTime(date: Date): void;
}

// 生产用 RealClock
// 测试用 VirtualClock
```

### 3.4 测试工具 API

```typescript
// 发送模拟消息
POST /dev/test-tool/api/simulate-message
Body: {
  userId: string;
  text: string;
  // 可选：模拟按钮回复
  buttonId?: string;
}
Response: {
  outboundMessages: OutboundMessage[];
  trace: EngineTrace;
}

// 推进虚拟时间
POST /dev/test-tool/api/advance-time
Body: {
  userId: string;
  to: "next_checkin" | "next_day" | "+24h" | "+1h" | Date;
}
Response: {
  newTime: Date;
  triggeredEvents: Array<{ type: string; description: string }>;
  outboundMessages: OutboundMessage[];
}

// 获取当前会话状态
GET /dev/test-tool/api/session-state?userId=xxx
Response: {
  user: User;
  cycle: Cycle;
  checkIn: CheckIn;
  diseaseCard: DiseaseCard | null;
  recentEvents: Event[];
  recentObservations: Observation[];
}

// 加载 persona
POST /dev/test-tool/api/load-persona
Body: {
  personaId: string;
  // 或自定义 persona JSON
}
Response: { userId: string }

// 获取可用 personas
GET /dev/test-tool/api/personas

// 重置测试用户数据
POST /dev/test-tool/api/reset-user
Body: { userId: string }

// 导出对话记录
GET /dev/test-tool/api/export-session?userId=xxx

// 导入并重放对话记录
POST /dev/test-tool/api/replay-session
Body: { sessionJson: object; stepByStep?: boolean }
```

---

## 4. Web UI 设计

### 4.1 布局

```
┌─────────────────────────────────────────────────────────────────────┐
│  CareMemory Local Test Tool                              [Reset]    │
├──────────────────────────────┬──────────────────────────────────────┤
│                              │  Engine Inspector                     │
│   Chat Simulation            │  ┌────────────────────────────────┐  │
│   ┌────────────────────────┐ │  │ L1 Perception                  │  │
│   │ System: Hi Sarah...    │ │  │ - intent: ask                  │  │
│   │                        │ │  │ - observations: [...]          │  │
│   │ Sarah (you): Mild      │ │  │ - safetyFlags: []              │  │
│   │                        │ │  └────────────────────────────────┘  │
│   │ System: How many...    │ │  ┌────────────────────────────────┐  │
│   │                        │ │  │ L4 Planner                     │  │
│   │                        │ │  │ - objective: track control     │  │
│   │                        │ │  │ - nextAction: ask reliever_use │  │
│   │                        │ │  │ - budgetRemaining: 2           │  │
│   └────────────────────────┘ │  └────────────────────────────────┘  │
│                              │  ...                                  │
│   [Quick buttons]            │                                       │
│   [Type here...] [Send]      │                                       │
│                              │                                       │
├──────────────────────────────┴──────────────────────────────────────┤
│  Time Control:  Now: Day 3, 10:05  [+1h] [+24h] [Next Check-in] [▶ Auto] │
├─────────────────────────────────────────────────────────────────────┤
│  Scenario: [controlled_asthma ▼]  [Load]  [Export]  [Replay]         │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 快捷按钮

聊天输入框上方提供快捷按钮，模拟 WhatsApp 交互：

- 常用患者回复：`None`, `Mild`, `Disturbed sleep`, `Woke me up`
- 系统指令：`START ASTHMA`, `STOP`, `HELP`, `DELETE MY DATA`
- 异常测试：`我今天喘得厉害`, `吸入器用了4次`, `新药吃了皮疹`

### 4.3 Inspector 面板

- 默认折叠，可展开；
- 每个层级用不同颜色区分；
- 显示原始 JSON 和可读摘要两种视图；
- 高亮异常和安全标记。

---

## 5. 测试场景库

### 5.1 内置 Scenarios

每个 scenario 包含：
- 患者基础信息（昵称、时区、下次复诊日期）
- 初始状态（如有）
- 预期对话脚本（用于验证，非强制）

#### Scenario 1: 7 天正常旅程

```json
{
  "id": "normal_7day_journey",
  "name": "7-day normal asthma journey",
  "user": {
    "name": "Sarah",
    "timezone": "Europe/London",
    "nextVisit": "2026-07-15"
  },
  "script": [
    { "day": 0, "action": "send", "text": "START ASTHMA" },
    { "day": 1, "action": "reply", "text": "AGREE" },
    { "day": 1, "action": "reply", "text": "Sarah" },
    { "day": 1, "action": "advance", "to": "next_checkin" },
    { "day": 1, "action": "reply", "buttonId": "night_none" },
    { "day": 1, "action": "reply", "buttonId": "reliever_0" },
    { "day": 1, "action": "reply", "buttonId": "activity_no" },
    ...
  ]
}
```

#### Scenario 2: 症状加重触发异常覆盖

```json
{
  "id": "worsening_with_override",
  "name": "Worsening symptoms trigger budget override",
  "script": [
    { "action": "send", "text": "START ASTHMA" },
    { "action": "reply", "text": "AGREE" },
    { "action": "advance", "to": "next_checkin" },
    { "action": "reply", "buttonId": "night_woke_up" },
    { "action": "reply", "buttonId": "reliever_3_plus" },
    { "action": "reply", "text": "今天跑步后喘得很厉害" }
  ]
}
```

### 5.2 自定义 Scenario

提供 JSON 编辑器，允许用户：
- 修改内置 scenario；
- 创建新的 persona；
- 导入/导出 scenario 文件。

---

## 6. 与生产代码的隔离

### 6.1 环境隔离

- 测试工具路由只在 `NODE_ENV=development` 或 `local` 时注册；
- 生产构建时完全剔除相关代码；
- 使用单独的数据库 schema 或前缀，避免污染生产/预发数据。

### 6.2 用户隔离

- 测试用户用 `test_` 前缀或单独的 `platform="test"` 标识；
- 测试用户数据不参与运营指标统计；
- 提供一键清除所有测试用户数据的接口。

### 6.3 IM 平台隔离

- 测试消息使用 `platform: "test"`，不调用任何外部 IM API；
- IM Adapter 在测试模式下返回 mock 发送结果。

---

## 7. 实现建议

### 7.1 MVP 实现范围

第一阶段实现最小可用版本：

- [ ] 浏览器聊天 UI；
- [ ] CLI 工具（`carememory test run` 等命令）；
- [ ] 虚拟 Clock Service；
- [ ] `/dev/test-tool/api/simulate-message`；
- [ ] `/dev/test-tool/api/advance-time`；
- [ ] `/dev/test-tool/api/session-state`；
- [ ] 3 个内置 persona；
- [ ] 基础 inspector 面板（显示 Planner 输出和 Patient Memory）；
- [ ] 断言式自动化测试（message contains / planner action / safety flag 等）。

第二阶段扩展：

- [ ] 完整 L1–L6 trace 展示；
- [ ] scenario 编辑器；
- [ ] 导入/导出/重放；
- [ ] 批量回归测试与 snapshot diff；
- [ ] AI-led evaluation（用 LLM 判断对话质量）；
- [ ] CI 输出格式（JUnit / JSON）。

### 7.2 技术实现

- **Backend**：在 Fastify 中注册 dev-only 路由；
- **Frontend**：用简单 HTML + Tailwind + 少量 React/Vanilla JS，避免引入复杂构建；
- **State**：SSE 或短轮询获取最新状态；
- **Storage**：测试数据存入同一 PostgreSQL，但用 `test_` 前缀或独立 schema。

### 7.3 目录结构

```
apps/
├── api/
│   └── src/
│       ├── routes/
│       │   └── dev-test-tool.routes.ts   # dev-only 路由
│       ├── test-tool/
│       │   ├── persona-library.ts        # 内置 scenarios
│       │   ├── virtual-clock.ts          # Clock Service 实现
│       │   ├── test-tool.service.ts      # 测试工具业务逻辑
│       │   └── assertions.ts             # 断言库
│       └── engine/...
├── test-tool-cli/                        # CLI 工具（可独立 package）
│   ├── src/
│   │   ├── commands/
│   │   │   ├── run.ts                    # 运行 scenario
│   │   │   ├── verify.ts                 # 带断言验证
│   │   │   ├── suite.ts                  # 批量运行测试套件
│   │   │   ├── replay.ts                 # 重放记录
│   │   │   └── report.ts                 # 生成报告
│   │   ├── client.ts                     # 调用 backend test-tool API
│   │   ├── runner.ts                     # scenario 执行引擎
│   │   └── index.ts                      # CLI 入口
│   └── package.json
└── test-tool-ui/                         # 可选：独立 Next.js 前端
    └── ...
```

或者内嵌在 backend 的 `public/test-tool/` 静态文件中：

```
apps/api/
├── src/
│   └── routes/dev-test-tool.routes.ts
└── public/
    └── test-tool/
        ├── index.html
        ├── app.js
        └── styles.css
```

**推荐 MVP 方案**：静态 HTML + JS 内嵌在 backend，通过 `/dev/test-tool` 访问。

---

## 8. 使用流程示例

### 8.1 手动测试一次 7 天旅程

1. 启动本地 backend；
2. 访问 `http://localhost:3055/dev/test-tool`；
3. 选择 persona `controlled_asthma`；
4. 点击 `START ASTHMA`；
5. 回复 `AGREE`、昵称、复诊日期；
6. 点击 `Next Check-in`，系统自动跳到 Day 1 10:00；
7. 回答 3 个问题；
8. 点击 `Next Check-in`，跳到 Day 3；
9. 重复直到 Day 7；
10. 查看 Disease Card 和 Brief。

### 8.2 调试 Planner 决策

1. 加载 persona `worsening_asthma`；
2. 完成 Day 1 check-in；
3. 在 inspector 面板查看 L4 Planner 的 reasoning；
4. 修改 RAG Corpus 中的 care-strategy.md；
5. 重新加载 persona，观察 Planner 行为变化。

### 8.3 回归测试

1. 运行 scenario `normal_7day_journey`；
2. 导出对话记录；
3. 代码修改后，重新运行同一 scenario；
4. 对比两次 trace，检查关键决策是否一致。

### 8.4 自动化回归（CLI / AI 主导）

```bash
# 1. 启动本地 backend
pnpm dev

# 2. 运行完整回归套件
pnpm test-tool ci --suite ./suites/regression-suite.json --output ./test-results/

# 3. 查看失败项（如有）
pnpm test-tool report --run-id run_20260615_001

# 4. 人工审查报告后，更新 snapshot（如果变化是预期的）
pnpm test-tool suite --file ./suites/regression-suite.json --update-snapshot
```

---

## 9. 安全与合规

### 9.1 绝不暴露到生产

- 测试工具路由通过环境变量开关：`ENABLE_TEST_TOOL=true`（默认 false）；
- 生产构建时移除 `/dev/*` 路由；
- 测试工具页面加明显水印：「LOCAL DEV ONLY」。

### 9.2 不使用真实患者数据

- 测试数据与生产数据物理或逻辑隔离；
- 禁止导入生产数据库到测试工具。

### 9.3 LLM 成本控制

- 测试时仍会调用 LLM API，建议：
  - 使用 cheaper 模型做大部分测试；
  - 对回归测试使用缓存的 LLM 响应（vcr 或本地 mock）；
  - 提供「mock LLM」模式，返回固定响应，用于纯 UI/流程测试。

---

## 11. CLI 设计

测试工具必须提供 **CLI**，让 AI 代理和开发者能在终端快速运行 scenario、验证断言、生成报告，而无需打开浏览器。

### 11.1 命令列表

```bash
# 运行单个内置 scenario
pnpm test-tool run --scenario normal_7day_journey

# 运行自定义 scenario 文件
pnpm test-tool run --file ./scenarios/worsening_asthma.json

# 运行并验证断言
pnpm test-tool verify --scenario normal_7day_journey --expect ./expects/normal_7day.json

# 运行测试套件（多个 scenario）
pnpm test-tool suite --file ./suites/regression-suite.json

# 重放已导出的会话
pnpm test-tool replay --file ./sessions/session_001.json

# 导出某个用户的会话
pnpm test-tool export --userId test_user_123 --output ./sessions/session_001.json

# 列出内置 personas
pnpm test-tool personas

# 生成人类可读的测试报告
pnpm test-tool report --run-id run_20260615_001 --output ./reports/

# 启动 headless 批量回归（CI 模式）
pnpm test-tool ci --suite ./suites/regression-suite.json --output ./test-results/
```

### 11.2 CLI 输出格式

默认输出简洁的进度和结果：

```
▶ Scenario: normal_7day_journey
  ✓ onboarding completed
  ✓ check-in day 1 (3/3 questions)
  ✓ check-in day 3 (3/3 questions)
  ✓ check-in day 5 (3/3 questions)
  ✓ check-in day 7 (3/3 questions)
  ✓ disease card generated
  ✓ brief generated

  Assertions: 12 passed, 0 failed
  LLM calls: 24
  Duration: 3.2s
```

CI 模式输出 JSON：

```json
{
  "runId": "run_20260615_001",
  "passed": 5,
  "failed": 0,
  "scenarios": [
    {
      "id": "normal_7day_journey",
      "status": "passed",
      "assertions": { "passed": 12, "failed": 0 },
      "llmCalls": 24,
      "durationMs": 3200
    }
  ]
}
```

### 11.3 CLI 与 Backend 的关系

CLI 通过 HTTP 调用 backend 的 `/dev/test-tool/api/*` 接口。这意味着：
- 必须先启动本地 backend；
- CLI 本身不直接访问数据库或引擎，保持与 UI 一致的行为；
- 未来可将 CLI 独立为 npm package，供 CI 使用。

---

## 12. 自动化测试框架

### 12.1 Scenario 脚本增强

Scenario 不仅是「操作序列」，还应支持 **期望（expectations）** 和 **断言（assertions）**。

```json
{
  "id": "worsening_with_override",
  "name": "Worsening symptoms trigger budget override",
  "user": {
    "name": "Sarah",
    "timezone": "Europe/London"
  },
  "script": [
    { "action": "send", "text": "START ASTHMA" },
    { "action": "reply", "text": "AGREE" },
    { "action": "advance", "to": "next_checkin" },
    { "action": "reply", "buttonId": "night_woke_up" },
    { "action": "reply", "buttonId": "reliever_3_plus" },
    { "action": "reply", "text": "今天跑步后喘得很厉害" }
  ],
  "expectations": {
    "atStep": 6,
    "assertions": [
      {
        "type": "planner",
        "path": "nextAction.type",
        "op": "eq",
        "value": "ask"
      },
      {
        "type": "planner",
        "path": "conversationContext.inExceptionMode",
        "op": "eq",
        "value": true
      },
      {
        "type": "safety",
        "path": "riskLevel",
        "op": "in",
        "value": ["medium", "high"]
      },
      {
        "type": "message",
        "op": "contains",
        "value": "call 999",
        "caseInsensitive": true
      },
      {
        "type": "observation",
        "op": "exists",
        "filter": { "category": "symptom", "concept": "exercise_induced_wheezing" }
      }
    ]
  }
}
```

### 12.2 断言类型

| 类型 | 说明 | 示例 |
|------|------|------|
| `message` | 校验 outbound 消息内容 | contains / not_contains / matches |
| `planner` | 校验 Planner 输出 | eq / in / gt / exists |
| `safety` | 校验安全层结果 | riskLevel / approved / addendums |
| `observation` | 校验提取的 observation | exists / count / value_eq |
| `diseaseCard` | 校验 Disease Card 模块 | module_exists / headline_contains |
| `brief` | 校验 Brief 内容 | contains / not_contains |
| `trace` | 校验完整 trace | snapshot_match / json_path |

### 12.3 Snapshot 回归测试

- 每次运行可将完整 trace 保存为 snapshot；
- 后续运行与 baseline snapshot 对比；
- diff 只显示变化部分，便于 AI/人工审查；
- 更新 snapshot：`pnpm test-tool run --scenario x --update-snapshot`。

### 12.4 AI-led Evaluation

对于无法精确断言的场景（如「对话是否自然」「是否过于像机器人」），可使用 LLM judge：

```json
{
  "assertions": [
    {
      "type": "llm_judge",
      "criteria": "The response sounds empathetic and does not give medical advice.",
      "expected": "pass"
    }
  ]
}
```

LLM judge 返回：
- `pass/fail`
- `reasoning`
- `confidence`

人类最终检查 fail 项即可。

### 12.5 测试套件（Suite）

一个 suite 是多个 scenario 的集合：

```json
{
  "name": "MVP Regression Suite",
  "scenarios": [
    "normal_7day_journey",
    "worsening_with_override",
    "adverse_event",
    "non_responder"
  ],
  "config": {
    "parallel": 2,
    "mockLLM": false,
    "cacheRAG": true
  }
}
```

---

## 13. AI 主导测试工作流

CLI + 自动化框架的设计目标，是让 AI 代理能够自主验证改动，人类只做最终审查。

### 13.1 典型工作流

```
1. AI 修改代码 / RAG Corpus / prompt
   │
   ▼
2. AI 运行 regression suite
   pnpm test-tool ci --suite ./suites/regression-suite.json
   │
   ▼
3. AI 获得结果
   - 全部通过 → 提交并生成简短报告
   - 部分失败 → AI 查看 diff 和 reasoning
   │
   ▼
4. AI 修复失败项（最多 N 轮）
   │
   ▼
5. AI 生成人类审查报告
   - 改了什么
   - 哪些测试通过/失败
   - 需要人类关注的边界 case
   │
   ▼
6. 人类审查报告，决定是否合并
```

### 13.2 AI 可读取的上下文

每次测试运行生成结构化输出：

```json
{
  "runId": "run_20260615_001",
  "summary": { "passed": 18, "failed": 2, "total": 20 },
  "failures": [
    {
      "scenario": "worsening_with_override",
      "step": 6,
      "assertion": {
        "type": "message",
        "op": "contains",
        "value": "call 999"
      },
      "actual": "Thanks for letting me know. Have you used your reliever inhaler?",
      "expected": "contains 'call 999'",
      "suggestedFix": "Safety layer did not flag severe post-exercise wheezing. Consider lowering safety threshold for exercise + high reliever use."
    }
  ],
  "llmCost": { "usd": 0.42, "tokens": 12400 }
}
```

### 13.3 Mock 模式

为加速 AI 测试和降低成本：

- **Mock LLM**：返回固定响应，用于验证流程和 UI；
- **Mock RAG**：返回固定知识片段，用于验证检索路由；
- **Cached LLM**：首次调用真实 LLM，后续相同输入使用缓存；
- **Deterministic mode**：固定 seed，使 Planner 输出可预测（用于 snapshot）。

### 13.4 与人类审查的衔接

- AI 不直接合并代码；
- 所有改动必须附带 `test-report.md`；
- 报告包含：改动摘要、测试通过情况、失败项分析、建议人类关注点；
- 人类通过 `pnpm test-tool report --run-id xxx` 查看可视化报告。

---

## 10. 附录

### 10.1 参考文档

- `docs/tech-spec.md` — 技术规格
- `docs/func-spec.md` — 功能规格
- `docs/decisions.md` — 设计决策记录

### 10.2 变更记录

| 版本 | 日期 | 变更内容 |
|------|------|----------|
| 0.1  | 2026-06-15 | 初始版本，定义本地测试工具目标、功能、架构和实现建议 |
| 0.2  | 2026-06-15 | 增加 CLI 设计、自动化断言框架、AI 主导测试工作流、CI 输出与 mock 模式 |

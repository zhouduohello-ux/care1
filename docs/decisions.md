# CareMemory 设计决策记录

> **版本**：v0.1  
> **日期**：2026-06-15  
> **记录范围**：PRD v0.2 / func-spec v0.2 讨论过程中确定的所有关键边界决策  
> **决策方式**：基于用户需求、AI-native 原则和医疗合规约束，通过 grilling 式讨论逐层确认

---

## 如何使用本文档

本文档用于记录那些在 PRD/func-spec 中无法充分展开、但对实现有重大影响的边界决策。每当我们面对设计分歧时，应先查阅本文档；若需推翻某项决策，必须在本文档中记录变更理由。

---

## D1. 底层架构：疾病通用引擎 vs 哮喘专用重构

**决策**：从第一天起设计为**疾病无关的 Care Memory Engine**，哮喘只是第一个加载的 disease profile。

**边界**：
- MVP 只实现 asthma profile；
- 但引擎的六层架构、数据模型、RAG Corpus 接口必须支持未来加载 IBD、糖尿病/高血压等 profile；
- 不允许把哮喘字段、问题、模板硬编码到引擎核心逻辑中。

**理由**：
- carememorydiaglog 已明确要做英国哮喘、英国 IBD、泰国糖尿病/高血压三个组合验证；
- AI-native 决策引擎不可能在每个疾病分支里写 if/else；
- MVP 边界应是「实现范围」，而不是「架构简陋」的借口。

**影响文件**：`docs/PRD.md` 第 5 节、`docs/func-spec.md` 第 2–3 节。

---

## D2. 策略库形态：RAG Corpus + LLM 语义理解，而非 rigid ontology

**决策**：疾病管理策略库不是人类维护的 JSON/关键词表，而是**LLM 可读的 RAG Corpus**。

**边界**：
- 不维护一张庞大的 signal ontology；
- 用医学语料库 RAG + 大模型做意图分析和信号识别；
- 信号存储为半结构化的 observation，字段可扩展，不强制映射到预定义 concept。

**理由**：
- 硬编码 ontology 无法适应多病种和患者自由表达；
- LLM 能从自然语言中直接理解医学意义；
- 但下游安全、Brief、指标仍需要最小结构化，因此保留 observation 记录。

**例外**：
- 安全红线仍用规则 + LLM judge 双重校验；
- 一些明确的按钮回复可直接规则映射为 observation。

**影响文件**：`docs/func-spec.md` 第 4 节、第 5.2 节。

---

## D3. 引擎分层：六层架构

**决策**：引擎拆分为六层，每层职责单一、LLM 可调用、可审计。

| 层级 | 名称 | 职责 |
|------|------|------|
| L1 | 感知层 | 解析输入，提取 observation、意图、异常、安全标记 |
| L2 | 患者记忆层 | Event log、observations、narrative summaries、Disease Card |
| L3 | 策略库层 | RAG Corpus（Medical KB / Care Strategy / Patterns / Safety） |
| L4 | 规划层 | Planner，决定推进哪个疾病片段、问什么问题 |
| L5 | 对话层 | 把 Planner 意图渲染为平台消息 |
| L6 | 安全/合规层 | 校验输出，拦截越界表述，追加安全提示 |

**边界**：
- 引擎内部不知道 WhatsApp；
- 引擎内部不知道 asthma 的具体字段；
- 每层之间通过定义好的接口交互。

**影响文件**：`docs/PRD.md` 第 5.1 节、`docs/func-spec.md` 第 2–3 节。

---

## D4. RAG Corpus 四层结构

**决策**：RAG Corpus 分为四个子库，分别服务不同检索场景。

| Corpus | 内容 | 检索触发 |
|--------|------|----------|
| Medical Knowledge Base | 疾病管理知识、症状识别 | 感知层理解输入 / 生成解释 |
| Care Strategy Library | CareMemory 疾病管理策略 | Planner 决策 |
| Conversation Pattern Library | 问题、追问、回复示例 | 对话层生成消息 |
| Safety Rules | 禁止表述、必须提示、风险场景 | 安全/合规层校验 |

**边界**：
- Disease Profile 不是 JSON，而是一组 RAG 文档；
- MVP 只准备 asthma 文档包；
- 医学权威性由内部整理 + 外部指南引用 + 医学顾问审核共同保证。

**影响文件**：`docs/func-spec.md` 第 4 节。

---

## D5. 患者记忆层：Event Log + Observations + LLM 生成 Narrative Summary

**决策**：患者记忆采用三层混合模型。

**边界**：
- **Event Log**：唯一事实来源，不可变，用于审计；
- **Observations**：LLM/规则从事件中提取的半结构化观察记录；
- **Narrative Summaries**：LLM 生成的自然语言摘要，分 session / cycle / longitudinal 三级；
- Disease Card 由 narrative + observations 生成。

**理由**：
- 完全语义化不可审计；
- 完全结构化太 rigid；
- 混合模型既保留灵活性，又支持下游使用。

**影响文件**：`docs/func-spec.md` 第 5 节。

---

## D6. Planner：Session Objective + Per-turn Re-planning

**决策**：Planner 不是一次性规划 3 题，而是**每答一题就重新规划下一步**，同时维护一个 session objective 保证连贯性。

**边界**：
- check-in 开始时设定 session objective；
- 每收到一个回答后调用 Planner；
- Planner 可继续、更新或替换 session objective；
- objective 变更必须显式记录。

**理由**：
- 一次性规划无法根据患者回答动态追问；
- 完全无 objective 的重规划会导致对话发散；
- session objective 提供连贯性，per-turn re-planning 提供适应性。

**影响文件**：`docs/func-spec.md` 第 6 节。

---

## D7. 3 题预算：主动 Check-in 的软预算 + 异常覆盖

**决策**：常规主动 check-in 最多 3 个问题，但**异常情况下可以覆盖预算**。

**边界**：
- 3 题是 L5 对话层的主动 check-in 预算，不是策略层约束；
- 以下情况可覆盖：
  - 与管理规则不一致的回答
  - 异常反馈（严重症状等）
  - 不良反应报告
  - 复合信号冲突
  - 患者主动求助
- 异常模式下最多追加 2–3 个问题；
- 安全响应最高优先级，可清空 budget 并结束 check-in。

**理由**：
- 机械限制 3 题会在患者真正需要关注时失败；
- 异常追问体现「AI-native 的疾病管理」；
- 追加上限防止对话无限延长。

**影响文件**：`docs/PRD.md` 第 6.2 节、`docs/func-spec.md` 第 6.4 节、第 12.3 节、第 13 节。

---

## D8. 用户主动咨询：不占用 Check-in 预算，触发完整推理

**决策**：患者主动发来的消息不消耗当天 3 题预算，而是触发一次完整的 L1→L4 推理流程。

**边界**：
- 主动咨询可压入 intent stack；
- 处理完后可返回原 check-in 或推迟；
- 主动咨询中的异常同样适用预算覆盖规则。

**理由**：
- 主动咨询是用户表达需求，不能拒绝或限制；
- intent stack 保证会话连贯。

**影响文件**：`docs/func-spec.md` 第 6.4 节、第 12 节。

---

## D9. L5 对话层：LLM 自由生成 + 约束校验 + 模板映射

**决策**：对话层采用方案 C：LLM 生成自然语言消息，然后经过平台约束校验和模板映射。

**边界**：
- 24h 会话窗口内：自由生成 text / buttons / list；
- 24h 外：只能使用预审批模板；
- WhatsApp buttons 最多 3 个，标题 ≤20 字符；
- 自由文本回答不匹配时，最多澄清 1 次。

**理由**：
- 纯模板太僵硬；
- 纯自由生成不可控；
- 混合方案兼顾 AI-native 体验和平台合规。

**影响文件**：`docs/func-spec.md` 第 7 节。

---

## D10. IM 兼容层：平台无关消息模型 + Adapter

**决策**：引擎内部使用平台无关的消息模型，通过 IM Adapter 对接具体平台。

**边界**：
- 引擎只处理 `InboundMessage` / `OutboundMessage`；
- Adapter 负责 webhook 解析、API 封装、会话窗口检测、模板管理；
- MVP 只实现 WhatsApp Adapter，但代码中不能写死 WhatsApp 逻辑；
- 未来 LINE / SMS / 其他平台只需新增 Adapter。

**影响文件**：`docs/func-spec.md` 第 8 节。

---

## D11. 24 小时窗口策略

**决策**：WhatsApp Business API 的 24 小时会话窗口影响消息类型和调度策略。

**边界**：
- 窗口内用户回复：正常自由消息；
- 窗口内用户未回复：发送一次提醒模板，若仍无回复则标记 missed；
- 窗口外主动 check-in：必须使用预审批模板；
- 窗口外用户主动回复：开启新会话，但保留历史上下文。

**影响文件**：`docs/func-spec.md` 第 7.4 节、第 8.2 节、第 12 节。

---

## D12. Disease Card：核心资产，Brief 是其 Visit-prep 导出

**决策**：Disease Card 是患者的长期疾病肖像，Brief 是 Disease Card 在复诊前的导出形态。

**边界**：
- Disease Card 患者主看，持续更新；
- Brief 医生主看，针对某次复诊生成；
- MVP 7 天版本展示早期 Disease Card；
- 4 周及以后展示更完整的趋势和洞察。

**理由**：
- CareMemory 不是日记，而是疾病肖像；
- 复诊周期可能是 1–3 个月，长期价值在 Disease Card；
- Brief 只是 Disease Card 的一种使用场景。

**影响文件**：`docs/PRD.md` 第 5.4 节、第 6.3 节；`docs/func-spec.md` 第 9 节、第 10 节。

---

## D13. Disease Card 内容边界：患者报告为主，不做临床量表推断

**决策**：Disease Card 聚焦患者自报信息，**不能从稀疏非结构化回答中推断临床量表分数**。

**边界**：
- **可做**：依从性摘要、症状-治疗关系、不良反应记录、主观感受变化、诱因频率、患者问题；
- **不可做**：从非量表问题计算 ACT、GINA、SCCAI 等临床分数；
- **唯一例外**：问题本身直接询问量表（如「腹痛 0-10 分打几分？」）时，可展示该量表值。

**理由**：
- 稀疏数据无法支撑准确的临床评分；
- 误报临床分数会误导患者和医生；
- 产品定位是「患者自报信息的结构化呈现」。

**影响文件**：`docs/PRD.md` 第 9.3 节、第 6.3 节；`docs/func-spec.md` 第 9.3 节。

---

## D14. Disease Card 指标：参考临床框架，输出 CareMemory 指标

**决策**：指标设计参考临床框架（如 GINA 哮喘控制维度），但输出的是 **CareMemory 三级指标**（Well controlled / Needs attention / Unstable），而不是临床分数。

**边界**：
- 趋势优先于绝对值；
- 数据稀疏时显示置信度提示；
- 不补全缺失数据；
- 每个指标计算逻辑需医学顾问审核。

**影响文件**：`docs/func-spec.md` 第 9.3 节。

---

## D15. 安全与合规：LLM 输出必须经校验层

**决策**：所有 LLM 生成的 outbound 内容必须经过 L6 安全/合规层校验。

**边界**：
- 禁止诊断结论、治疗建议、用药调整建议；
- 禁止判断患者是否需要急救；
- 哮喘相关内容默认附带急救提示；
- 所有 medical summary 底部附带免责声明；
- 保留 LLM 调用、Planner 决策、安全校验日志。

**影响文件**：`docs/PRD.md` 第 8 节、第 9 节；`docs/func-spec.md` 第 3.6 节、第 14 节。

---

## D16. MVP 范围边界

**决策**：MVP 聚焦英国 × 哮喘 × WhatsApp，但架构必须支持扩展。

**边界**：
- 实现：asthma profile、WhatsApp Adapter、7 天试用、4 周预订按钮；
- 不实现：其它疾病完整 profile、其它 IM 平台、真实支付、医生端 Dashboard、设备同步；
- 但架构层面必须预留：多 disease profile、多 platform adapter、Disease Card 长期视图。

**影响文件**：`docs/PRD.md` 第 3 节、第 1.3 节。

---

## D17. 记录周期与价值节奏

**决策**：7 天试用用于验证交互完成率；真正价值在 1–3 个月复诊周期。

**边界**：
- 7 天：验证用户是否愿意在 WhatsApp 里记录；
- 4 周：开始出现有意义的趋势；
- 1–3 个月：Disease Card 展现完整复诊前价值。

**影响文件**：`docs/PRD.md` 第 3.2 节、第 4 节。

---

## D18. 用户修正历史回答

**决策**：接受用户修正，不删除原 observation，而是标记原记录为 `superseded=true` 并创建新的 observation。

**边界**：
- 感知层通过关键词识别修正意图（"I was wrong / actually / I meant" 等）；
- 仅对同一 cycle 内同一 `concept` 的最新非 superseded observation 执行 supersede；
- 后续 Disease Card、Brief、Planner 均只读取未废止的 observation；
- Event Log 保留修正痕迹。

**影响文件**：`packages/engine/src/perception.ts`、`packages/engine/src/engine.ts`、`packages/engine/src/memory.ts`、`docs/func-spec.md` 第 5 节。

---

## D19. LLM 成本与限流

**决策**：MVP 采用用户级每日 LLM 调用软上限 + 备用模型自动降级，超限后走规则逻辑。

**边界**：
- 默认上限 50 次/用户/天，可通过 `LLM_DAILY_LIMIT_USER` 调整；
- 超限时记录 `llm_call` event（model=`RULE_FALLBACK`）并完全禁用该用户当日 LLM；
- 主模型返回 429/5xx 时，自动尝试 `LLM_FALLBACK_MODEL` 一次；
- 运营 dashboard 通过 admin metrics 监控每个用户的调用次数与 token 消耗。

**影响文件**：`packages/engine/src/llm-quota.ts`、`packages/engine/src/llm.ts`、`packages/engine/src/engine.ts`、`docs/tech-spec.md` 第 6 节。

---

## D20. A/B 测试框架（最小化实现）

**决策**：MVP 不构建完整 A/B 平台，而是基于 userId 稳定 hash 分桶，通过环境变量开关实验。

**边界**：
- 已定义实验：`checkin_frequency`（48h / 72h）、`conversation_style`（v1 / v2）；
- 分桶比例通过 `EXPERIMENT_<NAME>_ENABLED` 与 `EXPERIMENT_<NAME>_SPLIT` 配置；
- 实验桶随 Event payload 记录，便于后续按桶分析；
- 默认未启用实验时保持原有行为不变。

**影响文件**：`packages/engine/src/experiments.ts`、`packages/engine/src/engine.ts`、`packages/engine/src/planner.ts`。

---

## D21. 出站消息幂等性：engine 生成 pending 事件，dispatch 更新状态

**决策**：出站消息的持久化与发送职责分离。引擎负责生成 `idempotencyKey` 并写入状态为 `pending` 的 `outbound_message` 事件；调度层（`dispatchOutboundMessages`）负责检查已有事件、执行实际发送，并将状态更新为 `sent` 或 `failed`。

**边界**：
- `OutboundMessage` 携带可选 `idempotencyKey`，由 engine 统一生成；
- key 以 `userId + timestamp + salt + content.text` 哈希生成，salt 使用 `inboundEventId`（用户回复触发）或 `checkIn.id`（系统主动 check-in），确保不同逻辑 outbound 不会冲突；
- dispatch 发现事件已 `sent` 则跳过，发现 `pending`/`failed` 则（重）试发送并更新状态；
- 未 onboarding 前的 welcome 消息因无 user 记录，不强制持久化；
- 崩溃恢复时可通过 `idempotencyKey` 判断哪些 outbound 已发送，避免重复发送。

**影响文件**：`packages/im-core/src/index.ts`、`packages/engine/src/memory.ts`、`packages/engine/src/engine.ts`、`apps/api/src/lib/dispatch-outbound.ts`。

---

## D22. 跨 cycle 迟到回答

**决策**：当用户在没有 active cycle 时发送消息，系统不直接拒绝，而是询问是否与最近 cycle 相关；用户确认后，将该消息内容作为 observation 保存到最近 cycle。

**边界**：
- 仅当存在最近 cycle（无论 COMPLETED / CANCELLED / EXCEPTION）时才触发确认流程；
- 确认关键词：`YES` / `Y` / `ADD TO LAST RECORD` / `RECENT`；
- 用户确认后，从 Event log 读取上一条 inbound_message 的文本，保存为 `free_text_response` observation，并记录原始时间戳；
- 如果用户没有最近 cycle 或回复 `START ASTHMA`，按原有流程处理；
- 同一 cycle 内的迟到回答仍按原有逻辑直接接受。

**影响文件**：`packages/engine/src/perception.ts`、`packages/engine/src/engine.ts`、`docs/open-boundaries.md`。

---

## D23. 4 周计划周期自动延续

**决策**：`PLAN_4_WEEK` cycle 在 28 天结束时发送 CONTINUE 提示；用户回复 CONTINUE 后创建下一个 4 周 cycle，旧 cycle 标记为 COMPLETED，所有周期数据汇聚到同一个 Disease Card。

**边界**：
- 4 周计划是付费验证单位，不是真实复诊周期；
- 结束后系统询问是否继续下一个 4 周周期；
- 用户可连续参与多个 4 周周期直到复诊；
- Brief 可在复诊前基于多个周期数据生成。

**影响文件**：`packages/engine/src/engine.ts`、`packages/engine/src/onboarding.ts`、`docs/func-spec.md` 第 3.2、4.5 节。

---

## D24. Turn Manager：pending question 轮次管理

**决策**：Check-in 的待回答问题由 `packages/engine/src/turn-manager.ts` 统一管理，用户答非所问时进行重提示，超限后记录 `no_answer` 并继续下一题。

**边界**：
- `CheckIn` 新增 `pendingQuestion`（Json）与 `repromptCount`（Int）；
- `EventType` 新增 `turn_reprompt`；
- 重提示次数上限由 `PENDING_QUESTION_MAX_REPROMPTS` 环境变量控制，默认 2 次；
- 重提示文案按次数变化（第 1 次 “I didn't catch that.”，第 2 次 “Just to confirm:”）；
- `processInbound` 中 `recentObservations` 的获取移到 Turn Manager 之后，使 `no_answer` observation 对 Planner 可见。

**影响文件**：`packages/engine/src/turn-manager.ts`、`packages/engine/src/engine.ts`、`packages/db/prisma/schema.prisma`、`docs/l5-dialogue-spec.md`。

---

## D25. Pending question 超时、nudge、审计与可配置时间

**决策**：pending question 在发出后 12h 发送一次 gentle nudge，24h 未回复则静默超时记录 `no_answer`；nudge / timeout 时间可通过环境变量配置，所有关键动作写入 Event 审计。

**边界**：
- `CheckIn` 新增 `nudgeSentAt`；`EventType` 新增 `nudge_sent`；
- scheduler 新增 `scan-pending-nudge` 与 `scan-expired-pending` repeatable job；
- 环境变量 `PENDING_QUESTION_NUDGE_AFTER_MS`（默认 12h）与 `PENDING_QUESTION_TIMEOUT_MS`（默认 24h）控制时间；
- 非法环境值自动回退到默认值；
- 超时后不发送消息，仅更新 DB 状态并写入 `state_updated` Event。

**影响文件**：`apps/api/src/services/scheduler.ts`、`packages/db/prisma/schema.prisma`、`docs/l5-dialogue-spec.md`、`.env.example`。

---

## D26. WhatsApp MVP 模板清单

**决策**：MVP 阶段预定义 6 个 WhatsApp 模板，用于 24h 会话窗口外的主动消息。

**边界**：
- 模板：`welcome`、`checkin_reminder`、`brief_ready`、`safety_notice`、`stop_confirm`、`reactivation`；
- 模板内容由 `packages/im-whatsapp/src/templates.ts` 集中管理；
- 发送前检测 24h session window，窗口外必须 fallback 到模板；
- 所有模板需通过 Meta 预审批。

**影响文件**：`packages/im-whatsapp/src/templates.ts`、`packages/im-whatsapp/src/index.ts`、`apps/api/src/lib/dispatch-outbound.ts`、`docs/func-spec.md`。

---

## D27. Disease Card / Brief / Records 访问令牌

**决策**：Disease Card、Brief 与患者记录页通过短期访问令牌共享，令牌不依赖登录会话。

**边界**：
- Disease Card：`/c/[cardId]?t={token}`；
- Brief：`/b/[briefId]?t={token}`；
- Records：`/records?t={token}`；
- 令牌基于 `userId` + `cardId/briefId` + 过期时间签名生成，默认 7 天有效；
- 过期/错误令牌返回 401/403；
- MVP 医生不直接查看 Disease Card，只看 Brief。

**影响文件**：`apps/api/src/lib/user-token.ts`、`apps/api/src/routes/disease-cards.ts`、`apps/api/src/routes/briefs.ts`、`apps/api/src/routes/records.ts`、`apps/web/src/app/`。

---

## D28. GDPR 导出/删除与 admin API

**决策**：用户可通过 `EXPORT MY DATA` / `DELETE MY DATA` 导出或删除个人数据；运营方可通过 admin API 查询指标、导出/删除指定用户数据。

**边界**：
- 导出格式为 `carememory-gdpr-export-v1` JSON，7 天有效安全链接；
- 默认排除 LLM 审计日志；
- 删除为硬删除，包含用户、cycle、check-in、event、observation、narrative、disease card、brief；
- admin API 需 `ADMIN_API_KEY`；
- admin metrics 暴露用户数、check-in 数、LLM 调用、turn manager 统计等。

**影响文件**：`apps/api/src/routes/export.ts`、`apps/api/src/routes/admin.ts`、`apps/api/src/lib/export-token.ts`、`docs/func-spec.md`。

---

## D29. 可观测性：Sentry、结构化日志与健康检查

**决策**：API 与 Web 接入 Sentry，API 输出结构化 JSON 日志，`/health` 端点检查 PostgreSQL / Redis 依赖并返回版本。

**边界**：
- API：`@sentry/node` 捕获异常，Fastify/pino 输出 JSON 日志，支持 `LOG_LEVEL`；
- Web：`@sentry/nextjs`；
- `/health` 返回 db / redis 状态与 `version`；
- 部署工作流在 Render 部署后自动等待 `/health` 并运行 staging E2E smoke。

**影响文件**：`apps/api/src/index.ts`、`apps/api/src/routes/health.ts`、`apps/api/src/lib/logger.ts`、`.github/workflows/deploy.yml`、`infra/render.yaml`。

---

## 变更记录

| 版本 | 日期 | 变更内容 |
|------|------|----------|
| 0.1  | 2026-06-15 | 初始版本，记录 PRD v0.2 / func-spec v0.2 讨论确定的所有边界决策 |
| 0.2  | 2026-06-15 | 追加 D18 用户修正、D19 LLM 限流、D20 A/B 框架 |
| 0.3  | 2026-06-15 | 追加 D21 出站消息幂等性统一 |
| 0.4  | 2026-06-16 | 追加 D22 跨 cycle 迟到回答 |
| 0.5  | 2026-07-11 | 追加 D23–D29：4 周周期延续、Turn Manager、pending question 超时/nudge/审计、WhatsApp 模板清单、访问令牌、GDPR/admin、可观测性 |

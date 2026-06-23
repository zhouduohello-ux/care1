# CareMemory 待明确边界与遗漏核心能力

> **版本**：v0.1  
> **日期**：2026-06-15  
> **用途**：记录在 PRD/func-spec/tech-spec 对齐审查中发现的、尚未写入正式文档的边界问题和遗漏能力。  
> **状态**：待决策 / 待补充进正式文档

---

## 说明

本文档不是最终决策记录。它用于：
1. 暴露当前设计中边界不清晰的地方；
2. 列出 MVP 必须做但尚未细化的核心能力；
3. 为下一轮讨论提供结构化入口。

每项包含：**问题描述**、**当前文档状态**、**推荐决策**、**建议优先级**、**影响文件**。

---

## B1. 多病种 onboarding 边界

**问题**：当前 onboarding 假设用户发送 `START ASTHMA` 开始一个哮喘周期。未来支持 IBD、糖尿病时：
- 用户是否需要先选择疾病？
- 一个用户能否同时管理多个疾病？
- 关键词是 `START ASTHMA` / `START IBD`，还是统一的 `START` 后选择？

**当前状态**：PRD/func-spec 只说 MVP 做哮喘，架构支持多病种，但没有 onboarding 扩展设计。

**推荐决策**：
- MVP：一个用户一个 active cycle，关键词决定疾病（`START ASTHMA`）。
- 未来：用户可通过 `START <disease>` 开启新疾病的 cycle；一个用户可同时拥有多个 active cycles（不同疾病）。
- 因此 `Cycle` 必须有 `disease` 字段（已在 tech-spec/func-spec 中补齐）。

**优先级**：P1（MVP 需决定关键词和 cycle-disease 关系）  
**影响文件**：`docs/func-spec.md` 第 11 节 onboarding

---

## B2. 用户用药基线（Medication Baseline）

**问题**：Disease Card 要做「依从性」模块，但系统怎么知道患者「应该」用什么药？

**当前状态**：PRD 6.2 采集内容提到「用药/治疗依从性」，但没有说明如何建立用药清单。

**推荐决策**：
- MVP onboarding 可选收集患者当前用药（controller inhaler、reliever inhaler 等）；
- 用自然语言输入，LLM 提取为 medication baseline observation；
- 依从性问题基于此清单生成，例如「过去 2 天有没有按医嘱使用 {controller}？」；
- 患者可在记录页面补充/修改用药清单。

**优先级**：P1（否则依从性模块无的放矢）  
**影响文件**：`docs/func-spec.md` 第 5、11 节；`docs/PRD.md` 第 6.2 节

---

## B3. LLM 失败 / 超时 Fallback

**问题**：如果 OpenAI/Anthropic API 超时、限流或返回异常，系统如何响应患者？

**当前状态**：tech-spec 提到 BullMQ 重试，但没有定义用户可见的 fallback 策略。

**推荐决策**：
- 第一层：重试 1 次，可能换用备用模型（如 GPT-4o → Claude 3.5 Sonnet）；
- 第二层：使用轻量级规则 fallback，例如发送预设的安全确认消息："Thanks for your reply. I’ll get back to you shortly."；
- 第三层：如果 Planner 失败，发送致歉消息并通知运营；
- 绝不向患者输出未经验证的 LLM 内容。

**优先级**：P1（影响可用性）  
**影响文件**：`docs/func-spec.md` 第 12 节错误处理；`docs/tech-spec.md` 第 8 节

---

## B4. 用户修正历史回答

**问题**：患者可能说「我刚才说错了，昨晚其实咳得很厉害」。系统怎么处理？

**当前状态**：已实现。感知层识别 "I was wrong / actually / I meant" 等修正意图，将同 concept 的旧 observation 标记为 `superseded=true` 并创建新 observation；`getRecentObservations` 默认过滤掉被 superseded 的记录。

**推荐决策**：
- 接受用户修正；
- 不删除原 observation，而是创建新的 observation 并标记原 observation 为 `supersededBy`；
- Event Log 保留修正记录；
- Narrative Summary 和 Disease Card 基于最新有效 observation 生成；
- 如果修正影响已生成的 Brief，Brief 不自动更新（避免医生已查看的版本变化），但可提示用户重新生成。

**优先级**：P2（MVP 可后补，但数据模型需预留）  
**影响文件**：`docs/func-spec.md` 第 5 节数据模型；第 12 节边界处理

---

## B5. 迟到的回答

**问题**：用户几天后才回复某个旧问题，怎么处理？

**当前状态**：已实现。同一 active cycle 内若用户回复时无 active check-in，系统接受该回复为迟到补充并确认；跨 cycle 场景下系统询问用户是否与最近记录相关，用户确认（YES / Add to last record）后保存到最近 cycle。

**推荐决策**：
- 如果仍在同一 cycle 内：接受回答，更新 observation， Planner 判断是否继续本次 check-in 或开始新的；
- 如果已跨越 cycle：询问用户「这是关于最近的情况吗？」，让用户确认时间范围；
- 所有 observation 必须带准确时间戳，不能默认按当前时间。

**优先级**：P2  
**影响文件**：`docs/func-spec.md` 第 7.4 节、第 12 节

---

## B6. 季节性 / 周期性提醒的具体机制

**问题**：用户最初提到季节性、周期性是 Planner 的重要输入。但当前设计只把 season/day-of-week 作为 temporal context，没有说明如何触发季节性追问。

**当前状态**：已决策，无需额外代码。季节性/周期性仅作为 Planner 的 temporalContext 与 RAG Corpus 上下文，由 LLM 自行判断，不主动推断用户周期。

**推荐决策**：
- 季节性不作为硬触发，而是作为 Planner 的上下文提示；
- 例如花粉季时，Planner 更可能询问户外活动和花粉暴露；
- 周期性（如月经、周末）通过 RAG Corpus 中的疾病策略文档描述，由 LLM 自行判断；
- 不主动推断用户周期，除非用户自己报告过规律。

**优先级**：P2（MVP 可依赖 LLM 上下文，无需复杂规则）  
**影响文件**：`docs/func-spec.md` 第 6 节 Planner；`docs/decisions.md`

---

## B7. 异常流程的终止条件

**问题**：异常覆盖下追加 2–3 个问题后，如何结束？什么情况下必须建议就医？

**当前状态**：func-spec 12.3 说「澄清后返回原路径或结束」，但没有明确终止规则。

**推荐决策**：
- 异常流程最多追加 3 个问题；
- 如果 3 个问题后仍无法排除高风险，发送标准安全提示并结束 check-in；
- 以下情况立即结束并建议联系医生/急救：
  - 用户报告严重呼吸困难、胸痛、意识模糊；
  - 用户报告严重过敏反应；
  - 用户连续报告症状急剧恶化；
- 所有异常交互标记在 Disease Card 的 Adverse Events 模块。

**优先级**：P1（安全关键）  
**影响文件**：`docs/func-spec.md` 第 12.3、13 节；`docs/decisions.md`

---

## B8. Disease Card 访问控制

**问题**：Brief 有 accessToken 和过期时间，Disease Card 是否也需要？谁能看？

**当前状态**：func-spec 15.1 提到 Disease Card 路径 `/c/{cardId}?t={accessToken}`，但没有定义访问策略。

**推荐决策**：
- Disease Card 默认仅患者本人可查看（通过 userToken 或 accessToken）；
- MVP 不支持医生直接查看 Disease Card；医生只看 Brief；
- 未来可生成「只读分享版 Disease Card」给患者家属；
- accessToken 可长期有效但支持用户手动撤销。

**优先级**：P1（数据隐私）  
**影响文件**：`docs/func-spec.md` 第 15.1 节；`docs/PRD.md` 第 6.3 节

---

## B9. LLM 成本与限流控制

**问题**：MVP 目标 1,000 用户，若每个用户每天触发多次 LLM 调用，成本可能失控。

**当前状态**：已实现。每个用户每日 LLM 调用数通过 `LLM_DAILY_LIMIT_USER` 设置软上限（默认 50），超限时降级为规则逻辑；`LLM_FALLBACK_MODEL` 在主模型 429/5xx 时自动切换一次。

**推荐决策**：
- 每个用户每日 LLM 调用设置软上限（如 50 次）；
- 高频任务使用更便宜模型（GPT-4o-mini）；
- RAG 查询结果缓存 1 小时；
- 对重复/相似用户输入复用最近的 observation 提取结果；
- 运营 dashboard 监控每个用户的 LLM 成本。

**优先级**：P2（MVP 可先监控后限制）  
**影响文件**：`docs/tech-spec.md` 第 6 节；第 14 节性能

---

## B10. RAG Corpus 更新与嵌入管道

**问题**：医学顾问更新 Care Strategy 后，如何重新嵌入向量数据库？

**当前状态**：tech-spec 6.2 描述了 pipeline，但没有更新机制。

**推荐决策**：
- 提供一个 CLI 命令 `pnpm corpus:reindex`；
- 每次更新 Markdown 文件后，重新分块、embedding、写入向量库；
- 记录 Corpus 版本号，LLM trace 中携带版本号以便审计；
- MVP 阶段可手动触发，未来接入 CI/CD。

**优先级**：P1（否则策略库无法迭代）  
**影响文件**：`docs/tech-spec.md` 第 6.2 节；`docs/func-spec.md` 第 4 节

---

## B11. WhatsApp 模板清单

**问题**：24h 外需要预审批模板。具体哪些模板？内容是什么？

**当前状态**：tech-spec 7.4 列举了几个模板名称，但没有内容。

**推荐决策**：
MVP 至少准备以下模板（英文）：
- `welcome`：欢迎语 + 隐私政策链接；
- `checkin_reminder`：提醒用户有未完成的 check-in；
- `brief_ready`：Brief 已生成，含链接；
- `safety_notice`：标准安全提示；
- `stop_confirm`：确认已停止并说明数据删除；
- `reactivation`：用户 24h 外回复后重新 engaging。

**优先级**：P1（Meta 审核需要提前准备）  
**影响文件**：`docs/func-spec.md` 第 7 节、第 8 节；`docs/tech-spec.md` 第 7.4 节

---

## B12. GDPR 数据导出格式

**问题**：PRD/func-spec 都提到用户可导出数据，但没有定义格式和接口。

**当前状态**：PRD 6.5、tech-spec 11.3 提及，func-spec 未定义。

**推荐决策**：
- 用户发送 `EXPORT MY DATA` 后，系统生成 JSON 文件下载链接；
- JSON 包含：User 信息、所有 Cycles、CheckIns、Events、Observations、Narrative Summaries、Disease Cards、Briefs；
- 链接 7 天有效；
- 导出内容不包含 LLM 调用日志（这些属于系统审计数据）。

**优先级**：P2（MVP 可通过 manual admin 实现，产品上线前必须支持）  
**影响文件**：`docs/func-spec.md` 第 11、16 节

---

## B13. 医生反馈收集机制

**问题**：PRD 提到收集医生对 Brief 的反馈，但 MVP 没有具体机制。

**当前状态**：已实现。Brief 页面与 PDF 底部通过 `DOCTOR_FEEDBACK_URL` 嵌入外部反馈链接（Typeform/Google Form），医生匿名提交，系统不存储反馈内容。

**推荐决策**：
- MVP 不在产品内做医生端 Dashboard；
- 通过 Brief 页面底部嵌入一个 Typeform/Google Form 链接收集反馈；
- 反馈问题限定为：「这份摘要有用吗？」「哪些内容有帮助/多余？」「愿意让患者继续使用吗？」；
- 医生不登录，匿名提交。

**优先级**：P2（冷启动可用外部工具）  
**影响文件**：`docs/PRD.md` 第 6.6 节；`docs/func-spec.md` 第 10 节

---

## B14. A/B 测试框架

**问题**：PRD 提到支持 A/B 测试策略和对话风格，但没有框架设计。

**当前状态**：已实现。`packages/engine/src/experiments.ts` 提供基于 userId hash 的稳定分桶，支持 `checkin_frequency`（48h/72h）与 `conversation_style`（v1/v2），通过环境变量启用与调整比例。

**推荐决策**：
- MVP 不构建完整 A/B 平台；
- 通过环境变量或 feature flag 控制：
  - 对话风格版本（v1 / v2）；
  - check-in 频率（每 2 天 / 每 3 天）；
  - 问题生成策略（更积极 / 更保守）；
- 用户按 userId hash 分桶；
- 运营指标按 bucket 统计。

**优先级**：P2（MVP 后可扩展）  
**影响文件**：`docs/tech-spec.md` 第 14 节；`docs/PRD.md` 第 8 节

---

## B15. 系统崩溃 / 会话恢复

**问题**：如果 check-in 过程中 backend 重启，如何恢复会话状态？

**当前状态**：已实现。所有状态持久化到数据库；入站消息通过 `platformMessageId` 去重；出站消息由 engine 统一生成 `idempotencyKey` 并写入 pending 事件，dispatch 层更新为 sent/failed，避免崩溃/重试导致的重复发送。

**推荐决策**：
- 所有状态持久化到数据库，不依赖内存；
- 重启后根据 `CheckIn.status` 和 `Event` 日志恢复；
- 如果用户已回答但系统未发送下一题，重新调用 Planner 继续；
- 如果 outbound 消息发送失败，BullMQ 重试；
- 设计 idempotency key 防止重复发送。

**优先级**：P1（可用性关键）  
**影响文件**：`docs/func-spec.md` 第 12 节；`docs/tech-spec.md` 第 8 节

---

## B16. 4 周计划与真实复诊周期的关系

**问题**：用户复诊可能是 3 个月后，4 周计划结束后怎么办？

**当前状态**：已实现。`PLAN_4_WEEK` cycle 在 28 天结束时发送 CONTINUE 提示；用户回复 CONTINUE 后创建下一个 4 周 cycle，旧 cycle 标记为 COMPLETED。真实付费/booking 仍为占位链接。

**推荐决策**：
- 4 周计划是一个付费验证单位；
- 结束后系统询问是否继续下一个 4 周周期；
- 用户可连续购买多个 4 周周期直到复诊；
- 所有周期数据汇聚到同一个 Disease Card；
- Brief 在复诊前生成，可基于多个周期数据。

**优先级**：P2（MVP 只做预订按钮，真实付费后续实现）  
**影响文件**：`docs/PRD.md` 第 3.2、4.5 节

---

## B17. 用户通知偏好

**问题**：check-in 时间固定在 10:00–11:00，用户能否修改？

**当前状态**：func-spec 12.1 说默认 10:00–11:00，没有偏好设置。

**推荐决策**：
- MVP：不支持自定义时间，统一在 10:00–11:00 发送（基于用户时区）；
- 未来： onboarding 或设置中允许选择上午/下午/晚上；
- 避免过早提供偏好设置，增加复杂度。

**优先级**：P3（MVP 不做）  
**影响文件**：`docs/func-spec.md` 第 12.1 节；`docs/PRD.md` 第 3.1 节

---

## B18. 年龄验证与未成年人

**问题**：目标用户 18–60 岁，系统是否验证年龄？

**当前状态**：PRD 2.1 提到年龄范围，但没有验证机制。

**推荐决策**：
- MVP：在 onboarding 中询问年龄，仅作提示；
- 如果年龄 < 18，发送「本服务目前仅面向 18 岁以上用户」并停止；
- 不严格验证身份证，依赖用户自报。

**优先级**：P2（合规与产品定位）  
**影响文件**：`docs/func-spec.md` 第 11 节 onboarding

---

## 总结：优先级分布与状态

| 优先级 | 项 | 状态 |
|--------|-----|------|
| P1 | B1, B2, B3, B7, B8, B10, B11, B15 | 已实现或已有决策 |
| P2 | B4, B5, B9, B12, B13, B14, B16, B18 | 已实现 |
| P2 | B6 | 已决策，无需代码 |
| P3 | B17 | 明确跳过（MVP 不做） |

**下一步建议**：
1. 将 B4/B9/B14/B15/B16 的关键决策追加到 `docs/decisions.md`；
2. 更新 `AGENTS.md` 工程状态；
3. 运行全量 typecheck / test / build / E2E 验证。

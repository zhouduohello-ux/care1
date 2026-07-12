# WhatsApp Business API 模板文案与提交说明

> 本文档汇总 CareMemory MVP 期间需要向 Meta 提交审核的 WhatsApp 模板（template）。文案以英国哮喘场景为准，所有健康相关模板均包含急救提示兜底，避免任何诊断或治疗建议表述。

---

## 1. 模板清单

以下 6 个模板覆盖 MVP 核心用户旅程：首次欢迎、待答提醒、Brief 就绪、安全提示、暂停确认、24h 会话过期后重新激活。`plain_text` 为系统内部 fallback，不单独提交 Meta。

| 模板 Key | Meta 模板名 | 用途 | 变量 |
|----------|-------------|------|------|
| `welcome` | `carememory_welcome` | 新用户首次接触，说明产品定位与隐私政策 | `{{nickname}}` |
| `checkin_reminder` | `carememory_checkin_reminder` | 主动提醒用户有 pending check-in | `{{first_name}}` |
| `brief_ready` | `carememory_brief_ready` | Brief / PDF 生成后通知用户查看 | `{{first_name}}`, `{{link}}` |
| `safety_notice` | `carememory_safety_notice` | 用户报告异常或高风险信号后发送的标准安全提示 | 无变量 |
| `stop_confirm` | `carememory_stop_confirm` | 用户发送 STOP 后确认暂停并说明数据删除方式 | 无变量 |
| `reactivation` | `carememory_reactivation` | 用户超过 24h 会话窗口回复后，引导重新激活 | `{{first_name}}` |

---

## 2. 模板正文与变量示例

### 2.1 `carememory_welcome`

**用途**：用户通过任意入口首次发起对话后，在获取知情同意前发送。

**正文（EN-GB）**：

```text
Hi {{nickname}}, welcome to CareMemory. We help you keep a light record of your asthma between appointments. This is not a diagnosis tool. Reply AGREE to continue or read our privacy policy: https://carememory.app/privacy
```

**变量示例**：

| 变量 | 示例值 | 来源 |
|------|--------|------|
| `nickname` | Alex | onboarding 中用户自报昵称，最长 60 字符；缺失时回退为 "there" |

**Meta 提交要点**：
- 分类：Transactional 或 Utility（含用户确认 opt-in）。
- 必须在用户主动发送 START ASTHMA 或类似启动命令后 24h 内发送；否则需使用模板。
- 包含隐私政策链接，满足 GDPR 透明度要求。

---

### 2.2 `carememory_checkin_reminder`

**用途**：系统生成 pending check-in 后，在用户未在指定时间内回答时主动提醒。

**正文（EN-GB）**：

```text
Hi {{first_name}}, you have a pending CareMemory check-in. It only takes a minute. If you're having severe breathing problems, call 999 or follow your asthma action plan.
```

**变量示例**：

| 变量 | 示例值 | 来源 |
|------|--------|------|
| `first_name` | Alex | 用户昵称或名，最长 60 字符 |

**Meta 提交要点**：
- 分类：Utility / Appointment Update。
- 需说明这是用户已订阅的复诊前健康管理服务的一部分。
- 必须包含急救提示，避免被判定为医疗建议。

---

### 2.3 `carememory_brief_ready`

**用途**：Cycle 结束或医生请求时，Brief（一页式复诊摘要）已生成并可通过安全链接查看。

**正文（EN-GB）**：

```text
Hi {{first_name}}, your visit brief is ready: {{link}}. Please share this link with your healthcare team.
```

**变量示例**：

| 变量 | 示例值 | 来源 |
|------|--------|------|
| `first_name` | Alex | 用户昵称或名 |
| `link` | `https://carememory.app/b/abc123?t=def456` | `apps/api/src/lib/user-token.ts` 生成的 7 天有效安全链接 |

**Meta 提交要点**：
- 分类：Utility / Alert Update。
- 链接必须是 HTTPS；测试阶段可使用 staging 域名。
- 提示用户自行分享给医疗团队，避免系统主动发送给第三方的合规风险。

---

### 2.4 `carememory_safety_notice`

**用途**：L6 Safety 层检测到用户报告严重症状、高风险信号或触发异常模式后，作为标准兜底提示。

**正文（EN-GB）**：

```text
If you're having severe breathing problems, call 999 or follow your asthma action plan. Otherwise, contact your GP or call 111 if symptoms persist.
```

**变量**：无。

**Meta 提交要点**：
- 分类：Utility / Alert Update。
- 不含变量，便于快速审核。
- 强调“拨打 999 / 111”是英国合规的急救提示写法；若扩展至其他地区需替换为当地急救号码。

---

### 2.5 `carememory_stop_confirm`

**用途**：用户发送 STOP / PAUSE 后确认服务已暂停，并告知如何删除数据或重新激活。

**正文（EN-GB）**：

```text
We've paused your CareMemory reminders. Send START ASTHMA at any time to restart. Reply DELETE MY DATA to remove all your stored information.
```

**变量**：无。

**Meta 提交要点**：
- 分类：Utility / Account Update。
- 包含 GDPR 删除数据指令（DELETE MY DATA），体现用户控制权。
- 避免使用“取消订阅”等可能被归类为营销拒绝的表述。

---

### 2.6 `carememory_reactivation`

**用途**：用户超过 24h WhatsApp 会话窗口后再次回复，系统通过模板消息引导其重新激活服务。

**正文（EN-GB）**：

```text
Hi {{first_name}}, welcome back. Send START ASTHMA to continue recording, or HELP for options.
```

**变量示例**：

| 变量 | 示例值 | 来源 |
|------|--------|------|
| `first_name` | Alex | 用户昵称或名 |

**Meta 提交要点**：
- 分类：Utility / Account Update。
- 仅用于会话窗口外；窗口内使用普通自由文本回复即可。
- 引导用户发送系统命令（START ASTHMA / HELP），以便重新打开会话窗口。

---

## 3. 内部 Fallback：`plain_text`

**Key**：`plain_text`
**Meta 模板名**：`carememory_plain_text`
**变量**：`{{body}}`
**用途**：当以上 6 个模板均不匹配出站消息内容，或目标模板尚未通过 Meta 审核时使用。系统将完整文本作为变量填入。

**正文示例**：

```text
{{body}}
```

**注意**：该模板可作为开发 / staging 阶段的临时方案；生产环境应优先使用精准模板，以降低因变量内容被误判导致的封号风险。

---

## 4. 模板选择逻辑

代码入口：`packages/im-whatsapp/src/templates.ts` 中的 `selectTemplate()`。

优先级如下：

1. **安全优先**：文本含 `999 / emergency / severe / struggling to breathe / call 999` 或 conversation context priority 为 `urgent` → `safety_notice`。
2. **Brief 就绪**：文本匹配 `visit brief` / `brief is ready` → `brief_ready`。
3. **Check-in 提醒**：文本匹配 `pending.*check-in` / `check-in.*pending` → `checkin_reminder`。
4. **暂停确认**：文本含 `paused / STOP / restart` → `stop_confirm`。
5. **欢迎语**：文本含 `welcome to CareMemory / AGREE / privacy policy` → `welcome`。
6. **重新激活**：文本含 `welcome back / continue recording` → `reactivation`。
7. **Fallback**：以上皆不匹配 → `plain_text`。

---

## 5. Meta 提交通用要求

### 5.1 账号与业务验证
- 使用已验证的 WhatsApp Business Account（WABA）。
- 应用显示名称与品牌一致：CareMemory。
- 模板所属业务类型选择 Healthcare / Health Services（若可选）。

### 5.2 语言与地区
- 默认语言：English (UK)。
- 号码注册地区：英国（+44）。
- 若后续扩展至其他地区，需为每个地区单独提交本地化模板。

### 5.3 合规表述
- 不允许出现诊断、处方、用药调整、急救判断等表述。
- 必须包含急救提示或“供复诊参考 / patient-reported information”声明。
- 不要承诺医生会查看消息或因此改变治疗方案。

### 5.4 变量规范
- 所有变量使用 `{{variable_name}}` 格式。
- 变量名使用下划线：`first_name`、`nickname`、`link`。
- 变量值长度不超过模板 `maxBodyLength`（默认 1024 字符）。
- 避免变量中包含 URL、电话号码、或可能被识别为垃圾信息的内容；链接类内容应放在固定文案中（如 `brief_ready` 的 `{{link}}`）。

### 5.5 审核被拒常见原因与规避

| 被拒原因 | 规避方法 |
|----------|----------|
| 涉及医疗建议 | 仅记录患者自报信息，不包含诊断/治疗建议；添加“not a diagnosis tool”声明 |
| 缺少 opt-in 证明 | 保存用户发送 START ASTHMA 或 AGREE 的事件日志 |
| 变量内容可能变化过大 | 减少 `plain_text` 使用；对关键路径使用固定文案模板 |
| 链接域名未验证 | 使用 HTTPS，并在 Meta Business Manager 中完成域名验证 |
| 24h 会话限制 | 所有主动提醒使用模板；仅用户发起消息使用自由文本 |

---

## 6. 本地测试与覆盖

- 开发环境通过 `ENABLE_TEST_TOOL=true` 使用本地测试工具模拟入站/出站，不调用真实 WhatsApp API。
- 若需验证模板选择逻辑，可运行 `pnpm --filter @carememory/im-whatsapp test`，覆盖 `templates.test.ts` 中的选择器与变量构建用例。
- Staging 部署后，使用 `TEST_TOOL_API_KEY` 保护 `/dev/test-tool` 路由，但仍可手动触发模板消息查看渲染结果。

---

## 7. 后续扩展

MVP 之后可能新增的模板：

| 模板 Key | 触发场景 |
|----------|----------|
| `medication_reminder` | 基于用药基线主动提醒记录吸入剂使用 |
| `appointment_prompt` | 复诊日期临近时提醒用户更新信息 |
| `weekly_summary` | 每周向患者推送 Disease Card 摘要链接 |
| `multi_language_welcome` | 支持威尔士语 / 其他英国常用语言 |

新增模板前，需先更新本文档与 `packages/im-whatsapp/src/templates.ts` 中的 `WHATSAPP_TEMPLATES` 和 `selectTemplate()` 逻辑，并补充对应单元测试。

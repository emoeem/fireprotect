# Telegram 反垃圾 Bot 竞品与外部 API 研究

调研日期 2026-10-28。所有结论带来源；无法在文档/源码中直接核实的标 **未验证**。

## 1. 竞品总览

| Bot | 开源/技术栈 | 存储 | 反垃圾信号 | 联邦/共享名单 | 状态 |
|---|---|---|---|---|---|
| Miss Rose | 闭源（文档站 [missrose.org/docs](https://missrose.org/docs/)） | 未验证 | locks、blocklist(glob)、captcha、antiflood、antiraid（[anti-spam](https://missrose.org/docs/anti-spam/)） | 自建 federation，跨群同步封禁，**无全局封禁**（[federations](https://missrose.org/docs/federations/)） | 活跃，自称 600M 用户 / 14M 群（[首页](https://missrose.org/)） |
| GroupButler | Lua + Redis，otouto 分支（[repo](https://github.com/group-butler/GroupButler)） | **全部存 Redis**，`dump.rdb`（[README](https://github.com/group-butler/GroupButler/blob/develop/README.md)） | antiflood、rules、custom triggers、captcha | 无（README 未提及） | 维护停滞 |
| Shieldy | TypeScript/Telegraf + MongoDB（[repo](https://github.com/1inch/shieldy)） | MongoDB（typegoose 模型） | captcha（主）、`banNewTelegramUsers`（id>1e9 视为新号）、CAS | 仅 CAS 只读查询 | 被 1inch 收购（[blog](https://blog.borodutch.com/shieldy-got-acquired-by-1inch-exchange/)） |
| tg-spam | Go，自托管（[repo](https://github.com/umputun/tg-spam)） | SQLite 默认 / PostgreSQL，`--db=`（[README](https://github.com/umputun/tg-spam#readme)） | stop-words → 相似度 0.5 → Bayes 分类器(min-prob 50) → meta 检查 → 重复消息 → 短消息洪水 → 禁用字符集 → CAS → LLM(OpenAI/Gemini/jev，veto 模式) | 仅 CAS | 活跃 |
| Combot / CAS | 闭源 SaaS + REST API v5 | 未验证 | captcha、spam filters、warnings、under-attack、mass removal（[combot.org](https://combot.org/)） | **CAS**：加入即封，免费且"open to third-party bots" | 活跃，480k 群 |

### 1.1 Shieldy captcha 机制（源码级）

| 项 | 值 | 来源 |
|---|---|---|
| 类型枚举 | `simple / digits / button / image`，默认 `DIGITS` | [Chat.ts](https://github.com/1inch/shieldy/blob/master/src/models/Chat.ts) |
| 计时 | `timeGiven` 默认 **60 秒**；`restrict` 默认 true（先禁言再验） | 同上 |
| 图片 captcha | `svg-captcha` size=6、`ignoreChars` = 全部大小写字母（**实际只剩数字**）、noise=2、150×100，`sharp` 转 PNG | [captcha.ts](https://github.com/1inch/shieldy/blob/master/src/helpers/captcha.ts) |
| 算术 captcha | `a + b`，a/b ∈ [1,10] | [equation.ts](https://github.com/1inch/shieldy/blob/master/src/helpers/equation.ts) |
| 全局已验证集合 | `VerifiedUser{id unique}` —— 跨群记住已验证用户 | [VerifiedUser.ts](https://github.com/1inch/shieldy/blob/master/src/models/VerifiedUser.ts) |
| CAS 判定 | `checkCAS()` 直接 `!ok`，**无 token**；调用点 `if (chat.cas && !(await checkCAS(id))) kick` | [cas.ts](https://github.com/1inch/shieldy/blob/master/src/helpers/cas.ts)、[handleNewChatMembers.ts](https://github.com/1inch/shieldy/blob/master/src/helpers/newcomers/handleNewChatMembers.ts) |

要点：Shieldy 的 CAS 查询**失败即放行**（`catch → return true` → 不踢），但同一个 `cas.ts` 未带 API key，按今天的 API 行为会恒得 401，属实现陈旧 —— 这是"外部依赖静默失效"的典型。

### 1.2 Miss Rose antiflood（可直接借用的限流语义）

- 连续消息数：`/setflood 5`（[antiflood 文档](https://missrose.org/docs/anti-spam/antiflood/)）
- 窗口计数：`/setfloodtimer 5 10s` = 10 秒内 >5 条
- 惩罚阶梯：`kick / ban / tban TIME / mute / tmute TIME`，TIME 支持 `m/d/w`

### 1.3 tg-spam 的 CAS 客户端（超时/重试的工业写法）

`3 次重试、500ms 起始、factor 2、带 jitter`；`401/403` 立即放弃（`errCasAuth`，不重试）；`>=500` 与非 `application/json`（Cloudflare HTML）都重试；默认 `--cas.timeout=5s`（[detector.go](https://github.com/umputun/tg-spam/blob/master/lib/tgspam/detector.go)、[README cas 段](https://github.com/umputun/tg-spam#readme)）。

## 2. 外部反垃圾 API

### 2.1 CAS（Combot Anti-Spam）— 可用

| 项 | 值 |
|---|---|
| Endpoint | `GET https://api.cas.chat/check?user_id=<telegram_user_id>`（仅 GET） |
| 认证 | `Authorization: Bearer <COMBOT_API_KEY>` 或 `?api_key=`（[cas.chat/api](https://cas.chat/api/)） |
| 成功语义 | `ok:true` = **该用户已被 CAS 封禁**；`ok:false` = 未封禁 |
| 响应外壳 | 恒有布尔 `ok`，成功带 `result`，失败带 `error_code` + `description` |

实测（本机 curl，2026-10-28）：

```
GET https://api.cas.chat/check?user_id=12345
  无 key → 401 {"ok":false,"error_code":401,"description":"API key required"}
  错 key → 401 {"ok":false,"error_code":401,"description":"Invalid API key"}
GET https://api.cas.chat/banlist?limit=2 → 404（无此方法）
```

`result` 内部字段（是否含 `reported` 计数）**未验证**：文档只写 "The only parameter is `user_id`"，未给出 `result` 示例。tg-spam 只解析 `ok` + `description`，并在 `ok:true` 且 description 为空时补 `"spam detected"`，说明**封禁响应可以不带原因**。key 轮换后旧 key 最多再被接受 5 分钟。

共享名单规模：`cas.chat/feed` 明示 "Showing last 100 CAS bans"，实测前 20 条时间戳集中在 1–10 分钟内，且 ID 多为 6–9 位数（新号段）→ 全球封禁速率约每分钟数条。

### 2.2 Combot API v5（不是黑名单 API）

`https://api.combot.org/v5/<method>?api_key=<key>&chat_id=<id>`，`api_key` 必填（也可 `Authorization: Bearer` 用于 MCP）；分页 `page`(0-based)/`limit`；错误 `{"ok":false,"error_code":404,"description":"Chat not found"}`（[combot.org/api](https://combot.org/api)）。方法清单里**没有** spam-check / federation 查询，只有 `getChatMember`/`banMember` 等群管理方法 → 想查黑名单只能用 CAS。MCP：`https://mcp.combot.org/mcp`，Streamable HTTP + Bearer。

### 2.3 SpamWatch — 已失效（重要）

| 检查 | 结果 |
|---|---|
| `GET https://api.spamwat.ch/banlist/1` | curl 无法解析主机 |
| DoH `api.spamwat.ch` A | `Status:3`（NXDOMAIN），权威 NS 为 `chip.ns.cloudflare.com` |
| DoH `www.spamwat.ch` | `Status:3`；apex 仅有 SOA/NS |
| `https://github.com/SpamWatch/SpamWatch` | HTTP 404 |

历史接口形态（`GET /banlist/{user_id}` + `Authorization: Bearer <token>`，`/banlist` 全量、`/banlist/count`）**未验证**：服务端与仓库当前都不可达，不能作为依赖。

其它候选：`https://api.lols.bot/account/123` 返回 200 但 **0 字节**（无内容）；`spamwatch.io`/`missrose.rocks` 均 NXDOMAIN。结论：**免费可用的公开名单实际上只剩 CAS**。

## 3. 用户报告的失败模式

| 现象 | 证据 |
|---|---|
| 按钮式 captcha 被脚本轻易通过（Shieldy） | [issue #232 "Bots easily pass captcha"](https://github.com/1inch/shieldy/issues/232)，2024-10-28 开、仍 open |
| 6 位纯数字 + 2 条噪声线可被 OCR 低成本破解 | 由 `svg-captcha` 参数（size=6、字母全忽略）推得；实际破解率 **未验证** |
| CAS 返回 HTML（Cloudflare 拦截）导致解析失败 | tg-spam [issue #325](https://github.com/umputun/tg-spam/issues/325)，修法是"非 JSON 即重试" |
| 无 key 的 CAS 客户端静默失效（Shieldy `cas.ts`） | 代码无 token + 现网 401，见 §1.1/§2.1 |
| Bot API `kickChatMember/unbanChatMember` 对"曾在群内"的用户恒返回成功 | GroupButler [README 注意事项](https://github.com/group-butler/GroupButler/blob/develop/README.md) |
| 误报：短消息/引用内容被当成本人发言 | tg-spam 用 `--min-msg-len 50` 与 `AuthoredText()` 剥离引用（[spamcheck.go](https://github.com/umputun/tg-spam/blob/master/lib/spamcheck/spamcheck.go)） |
| 全局封禁不可申诉/不可退出 | Miss Rose 明确拒绝全局封禁，只做 federation（[docs](https://missrose.org/docs/federations/)） |

## 4. JS/TS 库（Cloudflare Workers）

| 需求 | 选型 | 版本 / 发布 | 依赖 | Workers 适配证据 |
|---|---|---|---|---|
| 滑动窗口限流 | `rate-limiter-flexible` | 11.2.3 / 2026-10-17 | 无 | `package.json.browser = {crypto:false, cluster:false}`；README "Memory limiter also works in the browser"（[npm](https://www.npmjs.com/package/rate-limiter-flexible)、[README](https://cdn.jsdelivr.net/npm/rate-limiter-flexible@11/README.md)）。仅用 `RateLimiterMemory`；Redis/Postgres/DO 变体需外部服务 |
| LRU + TTL | `lru-cache` | 11.5.3 / 2026-09-18 | 无 | 唯一 node 痕迹是 `diagnostics-channel.js` 里 `import('node:diagnostics_channel')` 且在 `.catch()` 内（[源码](https://cdn.jsdelivr.net/npm/lru-cache@11/dist/esm/diagnostics-channel.js)）；`perf.js` 用 `globalThis.performance`。`engines: node 20 || >=22` → workerd 运行 **未验证**；保守可用 Map+TTL 自实现 |
| HTML 转义 | `he` | 2.0.0 / 2026-10-04 | 无 | ES2022 模块，"works in all modern browsers and in Node.js v22+"（[README](https://cdn.jsdelivr.net/npm/he@2.0.0/README.md)）；包内只有 `bin/he.mjs` + `src/`，纯 ESM |
| 公共后缀/域名解析 | `tldts` | 7.4.19 | `tldts-core` | 自带 `umd/esm/cjs`；文档建议**先用 `new URL()` 取 hostname** 再 `extractHostname:false`（[README](https://raw.githubusercontent.com/remusao/tldts/master/README.md)）。Workers 显式支持 **未验证** |
| 备选后缀库 | `psl` | 1.15.0 / 2024-12-02 | `punycode` | 纯 JS；一年多未更新，优先级低于 tldts（[npm](https://www.npmjs.com/package/psl)） |
| Schema 校验 | `zod` | 4.6.7 | 无 | 零依赖，Workers 常用；运行时 **未验证**（[npm](https://www.npmjs.com/package/zod)） |

## 5. 对 fireprotect 的三条设计结论

1. **分层闸门 + 成本排序**：廉价确定性检查（stopword/相似度/重复/meta）先跑，LLM 与外部名单在后；再提供 "veto" 模式（只有 LLM 认可才封）以压误报 —— 直接对齐 tg-spam 的流水线。
2. **captcha 是状态机不是页面**：join → 立刻 restrict → 发欢迎语带按钮 → `timeGiven` 到期 `kickCandidates` → 通过则写 `VerifiedUser`（跨群/按群二选一）→ 被 admin kick 则清状态重验（Miss Rose 的"踢出重置"语义）。默认别用"按钮=唯一关卡"。
3. **外部名单按"可失败依赖"处理**：CAS 结果本地 TTL 缓存（建议 24h 阳性 / 1h 阴性）、5s 超时、3 次退避、`401/403` 不重试、非 JSON 视为瞬时故障；**失败一律 fail-open**，且把 `error_code` 记入指标而不是计入封禁理由。

> 未验证清单：CAS `result` 字段内部结构（含是否存在 reported 计数）、Miss Rose/Combot 的存储实现、SpamWatch 的历史接口契约、`lru-cache`/`tldts`/`zod` 在 workerd 上的实际运行、Shieldy 数字 captcha 的实测破解率。

# 焰卫 · Telegram 群管理机器人

一个可正式上线的 Telegram 群管理 / 反垃圾机器人：同一套核心，两种跑法。

| 形态 | 入口 | 场景 |
|---|---|---|
| Cloudflare Worker（webhook） | `src/worker.ts` | 正式上线；cron 负责关闭过期验证 |
| 本机长轮询 | `src/node.ts` | 没有域名、先在本机跑 |

```bash
cd bot
BOT_TOKEN=123456:ABC-DEF... npm run dev        # 长轮询
npm test && npm run typecheck && npm run lint  # 96 测试
```

拉进群 → **设为管理员**（删除消息、封禁用户、置顶消息）→ @BotFather `/setprivacy` 选 **Disable**。
不关隐私模式，机器人只能看见命令，看不见广告。

## 一、运行时依赖（都有明确用途）

| 库 | 用途 | 为什么不用手写 |
|---|---|---|
| `zod` | 每群配置的 schema 校验 | 配置来自群管理员的自由文本，`NaN` 一路传到 `until_date` 就是永久封禁 |
| `drizzle-orm` | D1 / SQLite 迁移与查询 | 同一份 schema 同时跑在 Workers 和本地 `node:sqlite` |
| `lru-cache` | 配置、权限、刷屏窗口、指纹的 TTL 缓存 | 见 `src/caches.ts`：缓存按 runtime 分实例 |
| `he` | HTML 实体转义 | 用户昵称进 `parse_mode: HTML` 时是注入面 |
| `tldts` | 域名后缀解析 | 判断高风险 TLD 需要公共后缀表，正则做不对 |

`grammy` 评估后没有引入：现有传输层只有 130 行、已被 96 个测试覆盖，迁移要重写命令层与全部测试，成本不可控（见 `docs/research/competitors.md`）。

## 二、存储分工

热状态进 KV（每群配置、待验证、进群时间），可查询的记录进 D1（处置事件、警告、说明、自动回复、共享黑名单）。

这样分是为了**不在每条消息上写 KV**：免费额度 1,000 写/天，一次写入就是一次配额。刷屏窗口、重复内容指纹因此放在 isolate 内存里——它们是近似判断，值得用精度换成本。

首次启动自动建表（`src/db/migrate.ts`），不需要手工 `d1 migrations apply`。

## 三、命令

任何人：`/id` `/rules` `/notes` `/get <名字>` `/help`

管理员（回复对方后发；括号里是需要的群权限）：

| 命令 | 作用 | 权限 |
|---|---|---|
| `/ban [分钟]` `/mute [分钟]` `/kick` `/unban` | 处置 | 封禁用户 |
| `/warn` `/unwarn` `/verify` `/trust` | 警告、放行、信任 | 封禁用户 |
| `/del` `/purge [数量]` | 删消息 | 删除消息 |
| `/pin` `/unpin` | 置顶 | 置顶消息 |
| `/lock` `/unlock` | 不带参数＝全群禁言/解除 | 封禁用户 |
| `/lock links photos …` / `/lock all` | 按消息类型拦截 | 封禁用户 |
| `/set 字段 值` | 改规则，`/set strikes off` 关阶梯 | 修改群信息 |
| `/captcha on\|off\|button\|math\|question` | 验证方式 | 修改群信息 |
| `/keywords add 词1,词2` `/keywords del 词` | 关键词 | 修改群信息 |
| `/nightmode on\|off [23:00-07:00]` | 夜间只允许管理员发言 | 修改群信息 |
| `/logs 频道ID\|off` | 处置记录发到哪 | 修改群信息 |
| `/save 名字 内容` `/delnote 名字` | 群内说明 | 修改群信息 |
| `/filter add exact\|prefix\|regex 触发词 => 回复` | 自动回复 | 修改群信息 |
| `/filters` `/delfilter ID` | 管理自动回复 | 修改群信息 |
| `/export` `/import <JSON>` | 规则模板复制到别的群 | 修改群信息 |
| `/stats [天数]` `/config` | 统计与当前配置 | 管理员 |

## 四、防护能力

- **新人验证三档**：`button`（点按钮，默认）、`math`（四个选项，防脚本）、`question`（自由文本答案）。
  button/math 会把新人静音，因为被静音的人无法打字；question 模式反过来——不静音，答错的消息直接删掉。
- **阶梯制裁**：默认 1 次禁言 1h、2 次禁言 24h、3 次封禁，`/set strikes off` 回到单次处置。计数在封禁时清零。
- **内容锁**：链接 / 图片 / 视频 / 贴纸 / 动图 / 文件 / 投票 / 语音 / 转发 / 邀请 / 提及 / 频道身份 / 机器人消息。
- **新人窗口**（默认 24h）：新号发链接和提及直接删；管理员 `/unban` 过的人自动免检。
- **炸群防护**：`joinRateMax` 秒内进群人数超阈值 → 提醒或直接锁群。
- **外部名单**：CAS（需要 Combot API key）、自建联邦、本地共享黑名单。三者都是 **fail-open**：超时 2s、失败缓存 5 分钟、401/403 不重试，宁可漏杀不误杀。
- **本地启发式**：邀请链接、高风险 TLD、冒充官方+链接、不可见字符、拉丁/西里尔混排、多人同文。外部服务全挂时它还在工作。
- **幂等**：`update_id` 去重 + 同群串行，重复投递不会二次处罚；按钮回调带 HMAC，不能替别人过验证。

## 五、部署

```bash
cd bot
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET    # /install 的安装密钥，必填
npx wrangler secret put CAS_KEY           # 可选
npx wrangler deploy
```

`wrangler.toml` 里已经绑好 KV、D1 和每分钟一次的 cron。部署后打开 `https://<worker 域名>/install`，填 `WEBHOOK_SECRET` 完成 `setWebhook`。

- `/health` 返回 bot / db 绑定状态；D1 没绑会直接 503 说明原因。
- `npm run live` 用真 token 跑一遍 Bot API 自检（含隐私模式、群权限、发一条再删掉）。
- webhook 路由校验 `X-Telegram-Bot-Api-Secret-Token`；没配 `WEBHOOK_SECRET` 时用 BOT_TOKEN 派生，不存在「没配就没校验」。

长期跑长轮询：`BOT_TOKEN=... npm run dev`，状态在 `bot.db` + `.bot-store/`。

## 六、目录

```
src/rules.ts        配置 schema（zod）/ 默认值 / 描述
src/filters.ts      内容判定（锁、新人、关键词、长度）
src/heuristics.ts   本地评分与重复内容
src/captcha.ts      验证挑战与 HMAC 回调
src/ladder.ts       阶梯制裁
src/nightmode.ts    夜间窗口
src/replies.ts      自动回复匹配
src/moderation.ts   所有改动群状态的动作 + 事件落库
src/bot.ts          update 分发（去重 + 同群串行）
src/handlers/       message / commands / join / verify / callback
src/db/             schema、迁移、查询、D1 与 node:sqlite 两个驱动
src/external/       第三方名单（唯一出网点，3 条失败策略在这里）
src/worker.ts       Worker 入口（webhook、/install、/health、cron）
src/node.ts         长轮询入口
```

`docs/research/competitors.md` 是对标调研（Miss Rose、Shieldy、tg-spam、Combot）与外部 API 实测结果。

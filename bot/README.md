# 焰卫 · Telegram 群管理机器人

一个可正式上线的 Telegram 群管理 / 反垃圾机器人：同一套核心，两种跑法。

| 形态 | 入口 | 场景 |
|---|---|---|
| Cloudflare Worker（webhook） | `src/worker.ts` | 正式上线；cron 负责关闭过期验证 |
| 本机长轮询 | `src/node.ts` | 没有域名、先在本机跑 |

```bash
cd bot
BOT_TOKEN=123456:ABC-DEF... npm run dev        # 长轮询
npm test && npm run typecheck && npm run lint  # 145 测试
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
| `pdf-lib` | `/splitpdf` 按页拆分 | 纯 JS、无 `node:` 依赖，Worker 与本地共用同一份实现 |
| `sharp` | `/slice` 长图切分 | 原生库，**只被 `src/tools/slice.node.ts` 引用**，Worker bundle 里没有它（`wrangler deploy --dry-run` 后 grep `node:` / `sharp` 均为 0） |
| `rss-parser` | `/rss` 订阅轮询 | 纯 JS，但假设 Node 全局；**只被 `src/rss.node.ts` 引用**，Worker 里既没有它也没有调度器 |

`grammy` 评估后没有引入：现有传输层只有 130 行、已被 145 个测试覆盖，迁移要重写命令层与全部测试，成本不可控（见 `docs/research/competitors.md`）。

## 二、存储分工

热状态进 KV（每群配置、待验证、进群时间），可查询的记录进 D1（处置事件、警告、说明、自动回复、共享黑名单）。

这样分是为了**不在每条消息上写 KV**：免费额度 1,000 写/天，一次写入就是一次配额。刷屏窗口、重复内容指纹因此放在 isolate 内存里——它们是近似判断，值得用精度换成本。

首次启动自动建表（`src/db/migrate.ts`），不需要手工 `d1 migrations apply`。

## 三、命令

任何人：`/id` `/rules` `/notes` `/get <名字>` `/help`

`/help` 只发一张卡片（状态 + 按钮），完整命令表在卡片里的「📖 全部命令」。

**后台按钮的三种传输方式**（由 Telegram 的能力决定，不是设计偏好）：

| 场景 | 按钮类型 | 点开的效果 |
|---|---|---|
| 私聊 | `web_app` | Mini App 就地打开，initData 签名免登录 |
| 群里 + BotFather 已配 **Main Mini App** | `url` → `t.me/<bot>?startapp=admin` | Mini App 就地打开 |
| 群里 + 未配 | `url` → `PUBLIC_URL/admin` | Telegram 内置浏览器打开网页后台，要密码 |

`web_app` 按钮在群里会被 Bot API 直接拒绝（实测 `400 BUTTON_TYPE_INVALID`），所以群里的"原地打开"只能靠 `t.me` 直链。
一次性开启步骤（约 30 秒，只能人工做，Bot API 无对应方法）：@BotFather → `/mybots` → 选机器人 → **Bot Settings → Configure Main Mini App** → 填 `PUBLIC_URL/admin`。
配好之后 `getMe.has_main_web_app` 变 true，群卡片**下一次刷新自动升级**成直链，不用改代码或重新部署。

机器人左下角菜单按钮同样是这个后台：`setChatMenuButton` 用 `web_app`。Mini App 走 initData 签名（不依赖 Cookie），浏览器走 `ADMIN_PASSWORD` / `ADMIN_TOKEN` 密码登录。

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
| `/captcha on\|off\|button\|math\|question\|image\|subscribe` | 验证方式（图形验证码 / 订阅频道，频道用 `/set captchaChannel` 设） | 修改群信息 |
| `/keywords add 词1,词2` `/keywords del 词` | 关键词 | 修改群信息 |
| `/nightmode on\|off [23:00-07:00]` | 夜间只允许管理员发言 | 修改群信息 |
| `/logs 频道ID\|off` | 处置记录发到哪 | 修改群信息 |
| `/save 名字 内容` `/delnote 名字` | 群内说明 | 修改群信息 |
| `/filter add exact\|prefix\|regex 触发词 => 回复` | 自动回复 | 修改群信息 |
| `/filters` `/delfilter ID` | 管理自动回复 | 修改群信息 |
| `/export` `/import <JSON>` | 规则模板复制到别的群 | 修改群信息 |
| `/stats [天数]` `/rules` | 统计与当前配置 | 管理员 |
| `/actions [条数]` `/warns <ID>` | 审计：最近动作（含操作人）/ 某位成员的全部记录 | 管理员 |
| `/top [人数]` | 今日发言榜；定时消息里写 `{{top}}` 发送时替换为榜单 | 管理员 |
| `/login <6位码>` | 批准网页后台登录码（登录页「Telegram 登录码」生成），个人会话按群鉴权、写操作归因 | 管理员 |
| `/block` `/unblock` `/blocks` | 屏蔽成员：静默删除其全部消息，不提示、不计警告 | 封禁用户 |
| `/sync add <@频道> [秒\|instant]` `/sync list\|on\|off\|del` | 频道新帖同步到本群；失效自动停用并告警 | 修改群信息 |
| `/sub <feed 地址>` `/sub list` `/sub export` `/unsub #ID` `/unsubthis` | RSS 订阅，按群隔离；连续 5 次抓不到自动退订并告警；导出 OPML | 修改群信息 |
| `/keywords action delete\|mute\|record` `/keywords regex add 加\s*V` | 关键词命中后的动作；正则规则（含回溯安全检查） | 修改群信息 |
| `/allow` `/unallow` | 广告白名单：命中关键词只记录、不处置 | 修改群信息 |
| `/ai on\|off\|status\|provider\|min\|budget` | 图片/贴纸/视频封面视觉审核（默认关，需 `VISION_KEY`） | 修改群信息 |
| `/words [天数]` | 今日热词与每日发言量 | 管理员 |

任何人：`/tool` `/splitpdf`（回复 PDF）`/slice`（回复长图）`/expand t.me链接` `/ts 时间戳` `/parse（抖音/小红书/X/B站链接）`（`/ocr` 回复图片读文字需要管理员权限）

### 网页控制台的「规则」页

44 个配置键按语义分成 10 组（总开关 / 进群验证 / 欢迎与告别 / 关键词与内容拦截 / 违规与处罚 / 刷屏与新成员 / 夜间模式 / 图片审核 / 链接解析与热词 / 外部名单与日志），每个字段是：

- **中文名** + 一句话说明「改了会发生什么」
- 右侧小字是原始键名（`captchaTimeout`）——写给 `/set` 用，不用去源码里翻
- 数字带单位（秒 / 分钟 / 次 / 字），枚举选项带中文标签和中括号里的原值
- 布尔是开关而不是「开/关」下拉（滚轮划过不会误改）
- 内容类型是胶囊多选，不是逗号串
- **违规阶梯**是行编辑器（第几次 → 怎么处理 → 多久），封禁档自动禁用时长输入
- 顶部有搜索框，按中文名或原始键名过滤
- 底部「高级：批量编辑原始 JSON」折叠区，用于从别的群整套复制配置

每个字段只提交自己那一个键（`PATCH {captchaTimeout: 900}`），失败时错误显示在该控件下方并把旧值写回——不会出现"表单显示的值服务端其实没接受"。
字段表在 `src/admin/fields.ts`，`test/console-fields.test.ts` 断言它与 `configSchema` 逐键一致：新增一个配置键却忘了写中文名，测试会红。

## 四、防护能力

- **新人验证三档**：`button`（点按钮，默认）、`math`（四个选项，防脚本）、`question`（自由文本答案）。
  button/math 会把新人静音，因为被静音的人无法打字；question 模式反过来——不静音，答错的消息直接删掉。
- **阶梯制裁**：默认 1 次禁言 1h、2 次禁言 24h、3 次封禁，`/set strikes off` 回到单次处置。计数在封禁时清零。
- **内容锁**：链接 / 图片 / 视频 / 贴纸 / 动图 / 文件 / 投票 / 语音 / 转发 / 邀请 / 提及 / 频道身份 / 机器人消息。
- **新人窗口**（默认 24h）：新号发链接和提及直接删；管理员 `/unban` 过的人自动免检。
- **炸群防护**：`joinRateMax` 秒内进群人数超阈值 → 提醒或直接锁群。
- **外部名单**：CAS（需要 Combot API key）、自建联邦、本地共享黑名单。三者都是 **fail-open**：超时 2s、失败缓存 5 分钟、401/403 不重试，宁可漏杀不误杀。
- **本地启发式**：邀请链接、高风险 TLD、冒充官方+链接、不可见字符、拉丁/西里尔混排、多人同文。外部服务全挂时它还在工作。
- **新群预设**：第一次见到一个群时落盘一套保守配置（验证开、刷屏 5 条/10 秒、阶梯制裁、新人 24h 禁链、关键词空），之后归该群所有；控制台可改「新群预设」本身。
- **屏蔽（shadowban）**：`/block` 后静默删除其所有消息，对方收不到任何提示，也不计入警告——被明确告知的垃圾号会换号，没收到反馈的会继续对着空气发。
- **幂等**：`update_id` 去重 + 同群串行，重复投递不会二次处罚；按钮回调带 HMAC，不能替别人过验证。
- **视觉审核**（可选，默认关）：图片/贴纸/视频封面走 `VISION_URL`（generic）或 Google Cloud Vision，3s 超时、按 `file_unique_id` 缓存、失败 5 分钟不重试、**不可达一律 fail-open**；每天 `aiDailyBudget` 次后告警一次并停到明天。
- **RSS**：`/sub` 按群订阅，`/sub export` 出 OPML 给阅读器直接导入。水位线存 `rss_feeds.last_key`，连续 5 次失败自动退订并告警。**只有自托管形态能轮询**（Worker 没有 `rss-parser` 也没有定时器），Worker 里 `/sub` 会明确说明这一点而不是假装成功。
- **图片 OCR**：`/ocr` 回复一张图，用本机 `tesseract -l chi_sim+eng` 读文字；命中广告词走与文字消息**完全相同**的处置链（白名单、管理员豁免、阶梯）。识别失败原样放行。`chi_sim` 会在汉字之间插空格，所以匹配前先折叠 CJK 间距，否则中文关键词永远打不中。
- **链接解析**：`/parse` 取抖音/小红书/X/B站的原图集或视频。自托管（`yt-dlp`）发完整媒体，Worker 只发 OpenGraph 封面 + 原链接；失败只回一句话，**不动原消息**。
- **热词**：中文二元组 + 停用词表，内存累加、每 30 词或 10 分钟批量写一次 D1（一条消息一次写会打爆免费额度）。

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

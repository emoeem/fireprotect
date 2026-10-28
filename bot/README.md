# 焰卫 · 群管理机器人（可直接运行的版本）

从这个仓库的配置生成器（`src/lib/generate-worker.ts`，把 600 行代码拼成字符串塞进输入框）派生出**真正的机器人工程**：同一套群管逻辑，写成可维护的模块，带测试、带部署配置。

两种跑法共用一份核心，只换传输层：

| 形态 | 入口 | 场景 |
|---|---|---|
| Cloudflare Worker（webhook） | `src/worker.ts` | 正式上线，免费额度就够 |
| 本机长轮询 | `src/node.ts` | 没有域名、在公司网络后面、想先在本机试 |

**零运行时依赖**：`package.json` 里没有 `dependencies`。装不装 `wrangler` 只影响部署方式。

---

## 一、5 分钟跑起来（本机长轮询，不需要域名）

```bash
# 1. 找 @BotFather 要一个 BOT_TOKEN
# 2. 跑起来
cd bot
BOT_TOKEN=123456:ABC-DEF... node --experimental-strip-types src/node.ts
```

启动时会打印 `焰卫已上线：@your_bot`。然后：

1. 把机器人拉进群 → **设为管理员** → 勾选「删除消息」「封禁用户」「置顶消息」。
2. 到 @BotFather → `/setprivacy` → 选 **Disable**。不关的话机器人收不到普通群消息，只能看到命令。
3. 群里发 `/id` 看你自己的数字 ID；`/help` 看命令表；`/rules` 看当前规则。

状态落在 `bot/.bot-data/`（每群规则、待验证名单、警告次数），一个 key 一个 JSON 文件，可直接 `ls` 检查。想换目录用 `BOT_DATA_DIR=/tmp/x`。

> 长轮询会先调用 `deleteWebhook`。如果同一个机器人另有一个 Worker 在跑，两边会互相抢更新（`getUpdates` 报 409），只能选一种。

## 二、部署到 Cloudflare Worker

```bash
cd bot
npx wrangler kv namespace create STORE     # 输出里的 id 填进 wrangler.toml，并去掉那三行注释
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET     # 可选但强烈建议
npx wrangler deploy
```

部署完打开 `https://<worker 域名>/install`，提交表单完成接入（会 `setWebhook` + 写命令菜单）。

- 打开 `/install` 这个 **GET 只显示表单**，真正改 webhook 的是 POST。旧模板用 GET 完成变更，一个链接预览就可能把 webhook 指到别处。
- 不接 KV 也能跑，但会退化成 per-isolate 内存：重启丢规则、丢待验证名单。生产请接。

## 三、群里怎么用

任何人：`/id`、`/rules`、`/help`

管理员（回复对方消息后）：

| 命令 | 作用 |
|---|---|
| `/ban [分钟]` | 封禁；带分钟数到期自动解封 |
| `/mute [分钟]` | 禁言，默认取 `muteMinutes` |
| `/kick` | 踢出，对方还能再进来 |
| `/unban` | 解封并恢复发言 |
| `/warn` | 删掉被回复的消息 + 记一次警告，满 `warnLimit` 次自动封禁 |
| `/unwarn` | 撤销一次警告 |
| `/del` | 删除被回复的消息 |
| `/purge [数量]` | 从被回复那条删到这里，最多 100 条 |
| `/pin` / `/unpin` | 置顶 / 取消置顶 |
| `/lock` / `/unlock` | 全群禁言 / 解除（管理员不受影响） |

也可以不回复，写成 `/ban 123456789`。

改规则（每群各自保存，不需要重新部署）：

```
/set captcha off          /set filterLinks on
/set warnLimit 5          /set maxLength 0        # 0 = 关掉超长拦截
/set spamAction ban       /set muteMinutes 60
/set captchaPrompt {name}，点按钮进群
/captcha on|off           /keywords add 引流,代开
/keywords del 引流        /keywords list
/logs -1001234567890      /logs off               # 审核记录发到频道
/config                                          # 看全部字段当前值
```

**配置项全表**

| 字段 | 默认 | 说明 |
|---|---|---|
| `captcha` | `true` | 新人进群先禁言，点按钮才放行 |
| `captchaPrompt` | `{name}，先点下面的按钮。通过之前不能发言。` | 支持 `{name}` `{chat}` `{username}` |
| `captchaTimeout` | `900` | 秒；超时移出群（30–86400） |
| `welcome` / `welcomeText` | `true` / 见源码 | 验证通过或直接进群时发送 |
| `deleteJoinMessages` | `true` | 删「某某加入了群组」 |
| `keywords` | 加微信/代理/博彩/日赚/兼职刷单 | 不区分大小写，最多 200 条 |
| `filterLinks` | `true` | 含链接即处理（裸域名也认） |
| `filterForwards` | `false` | 转发消息 |
| `filterChannels` | `true` | 以频道身份发言 |
| `maxLength` | `1200` | 0 = 关闭 |
| `floodLimit` / `floodWindow` | `0` / `10` | 刷屏：窗口内超过 N 条则处理，0 = 关闭 |
| `spamAction` | `delete` | `delete` / `mute` / `ban` |
| `muteMinutes` | `30` | |
| `warnLimit` | `3` | 0 = 关闭自动封禁 |
| `logChatId` | `""` | 审核记录目标，空则用环境变量 `LOG_CHAT_ID` |

## 四、结构

```
bot/
├── src/
│   ├── types.ts        Telegram 子集类型 + Store/Env 接口（手写，不引 workers-types）
│   ├── rules.ts        每群规则的默认值、合并与边界钳制
│   ├── store.ts        存储抽象 + memory（测试/兜底）+ KV（生产）+ 分页 list
│   ├── store-file.ts   磁盘存储（只给本机长轮询用）
│   ├── telegram.ts     Bot API 客户端：超时、429/网络错误各重试一次、HTML 转义
│   ├── context.ts      Ctx 组装、规则读写、管理员解析（静态名单 ∪ 群管理员，带缓存）
│   ├── moderation.ts   处置/禁言/踢人/解封、警告计数、审核日志
│   ├── filters.ts      链接/关键词/转发/频道/超长/刷屏判定
│   ├── captcha.ts      HMAC 签名按钮、放行、超时清扫
│   ├── commands.ts     命令路由与参数解析
│   ├── router.ts       update 分发：callback → 成员变动 → 命令 → 内容过滤
│   ├── install.ts      /install 页面与 setWebhook
│   ├── worker.ts       Cloudflare 入口（makeWorker 可注入假 Telegram）
│   └── node.ts         长轮询入口
└── test/               76 个用例，含假 Bot API（记录每一次调用）
```

一次更新的流向：

```
Telegram → worker.fetch / getUpdates
        → 校验 secret_token（恒定时间比较）
        → handleUpdate
             ├ callback_query → 验证签名/归属/时效 → 放行 + 删提示 + 欢迎
             ├ my_chat_member → 被拉进群时的安装指引
             └ message
                  ├ 新成员 → 禁言(带 until_date) + 按钮 + 删服务消息
                  ├ 成员离开 → 删服务消息
                  ├ 命令   → 解析目标 → 校验身份 → 调 Bot API → 回报真实结果
                  └ 其它   → 内容过滤（频道/转发/关键词/链接/超长）→ 刷屏 → 处置
```

## 五、测试

```bash
cd bot
node --experimental-strip-types --test test/*.test.ts   # 76 passed
../node_modules/.bin/tsc -p tsconfig.json              # 0 errors
```

测试的核心是 `test/harness.ts` 里的假 Bot API：它记录机器人**实际发出的每一次调用**，所以「处罚了但没有真的 ban」这种失败能被抓住，而不是只断言「数据里有」。

覆盖的关键行为：

- 未配置 `WEBHOOK_SECRET` 时，伪造的 webhook POST 仍然 401（旧模板这时是完全不校验的）
- 频道身份发言（无 `from`）仍被拦截——旧模板的过滤顺序让这条规则变成死代码
- `/mute 10` 被拒绝，而不是去禁言 id 恰好为 10 的陌生人
- 按钮发不出去时**把成员资格还回去**，不制造「永久禁言」
- 警告满额 → 封禁 + 计数归零（不是减一）
- Telegram 返回失败时回复「没成功：<原因>」，不假装成功

## 六、安全上的取舍

| 决定 | 原因 |
|---|---|
| webhook 永远校验，密钥回退到 `BOT_TOKEN` | 空密钥不能等于「不校验」；`BOT_TOKEN` 只有 Telegram 和部署方知道 |
| 捕获按钮用 HMAC 签名 + 过期时间 + 归属校验 | 少任何一条，别人可以替你点掉验证 |
| 禁言带 `until_date` | Worker 没有可靠的定时器；bot 死了也不能让人永久闭嘴 |
| 放行只给「发言」权限 | `can_invite_users: true` 会绕开群自己的邀请策略 |
| 处置与删除互相独立 | 旧模板删除失败会连带取消封禁 |
| 审核日志失败不影响处置 | 日志是旁路，不是前置条件 |
| 所有用户文本走 `escapeHtml` | 显示名可以是 `<b>x</b>`，在管理员的 HTML 消息里就是标记 |

## 七、已知限制

- **超时清算是惰性的**：Worker 不能定时，只有群里来消息时才会顺便扫一次（每群 30 秒节流）。没有流量的群也不需要清算。
- **没有支付/订阅、没有 CAS 黑名单库**：这是一个纯本地规则机器人，不依赖任何第三方服务。
- **`/purge` 依赖消息 id 连续**，在超级群里通常成立；任一条删除失败整批可能被拒。
- **KV 写额度**：每条待验证成员一次写、每次刷屏判定一次写。`floodLimit` 保持默认 0 就不产生这笔开销。
- **Cloudflare 免费版 50 subrequest/请求**：批量入群（一次 `new_chat_members` 很多人）时可能触顶，`/lock`、`/purge` 也一样。
- 本机长轮询**没有**做多进程主备；同一个 token 只能有一个消费者。
- `wrangler deploy` 在本机没有执行（环境离线，未安装 wrangler）。worker 入口的依赖图已确认不含 `node:` 内置模块（只有 `store-file.ts` 用，且只被 `node.ts` 引用），但**部署这一步需要你在有网络的环境跑一次确认**。

## 八、和旧「生成器」的关系

`src/lib/generate-worker.ts` 仍然在仓库里，网页还能生成单文件 Worker——那份适合「粘贴一次就不管」的场景。这里这份适合要长期维护、要多群不同规则、要能在本机调试的场景。

两者行为对齐的地方：同样的关键词默认值、同样的 `/ban /mute /kick /unban /warn /del /pin`、同样的处置语义（`delete`/`mute`/`ban`）。这份多出来的：每群独立规则、警告升级、刷屏控制、群管理员自动识别、审核日志、`/purge /lock /unlock /set /keywords /config`、超时自动移出。

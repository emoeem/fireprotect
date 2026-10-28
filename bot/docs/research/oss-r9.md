# R9 · 开源项目挖掘与集成

所有事实取自 GitHub REST API（`/repos/{owner}/{repo}`、`/license`、`/git/trees/HEAD?recursive=1`）与
`raw.githubusercontent.com` 原文，抓取时间 2026-10-28。许可证一栏区分两件事：**GitHub 的
SPDX 识别结果**与**LICENSE 文件正文实际是什么**——这两者不一致时以后者为准，但把差异记下来。

## 1. 仓库判定表

| 仓库 | GitHub 识别 | LICENSE 正文 | 最后提交 | 开放 issue | 星 | 判定 | 理由 |
|---|---|---|---|---|---|---|---|
| runawaydevil/ScoutBot | `NOASSERTION` | **MIT**（正文完整，只是版权行格式不规范导致识别失败） | 2026-01-23 | 0 | 8 | **参考** | 熔断/重试/限流的**形状**值得借；Python + Redis + SQLAlchemy，代码无法直接复用 |
| iovxw/rssbot | `Unlicense` | Unlicense（**不是 MIT**，比 MIT 更宽松） | 2026-08-17 | 18 | 1697 | **参考** | `/sub /unsub /unsubthis /export(OPML)` 的**交互设计**；Rust，代码不可移植 |
| yt-dlp/yt-dlp | `Unlicense` | Unlicense | 2026-10-26 | 2737 | 203296 | **集成（已在用）** | `/parse` 的底层引擎，`src/parse/ytdlp.node.ts` 已在调 |
| Desiders/ytdl_tg_bot | `NONE` | **无许可证文件** | 2026-10-26 | — | 42 | **跳过** | 无许可证 = 默认保留所有权利，代码一行都不能抄；README 里的用法可以当需求参考 |
| upekshaip/tg-ytdlp-bot | `GPL-3.0` | GPL-3.0 | 2026-01-11 | — | 253 | **跳过** | GPL 传染，与闭源部署冲突 |
| gpchelkin/scdlbot | `MIT` | MIT | 2026-10-26 | — | 438 | **参考（已采纳）** | 音频封面/元数据的正确做法：交给 yt-dlp 的 `EmbedThumbnail`，不手搓 ffmpeg（见 §2.2） |
| callsmusic/tgmusicbot | `AGPL-3.0` | AGPL-3.0 | **2022-05-23** | — | 108 | **跳过** | AGPL + 已停更四年 |
| AshokShau/TgMusicBot | `GPL-3.0` | GPL-3.0 | 2026-10-20 | — | 101 | **跳过** | GPL 传染；活跃但不是我们要解决的问题 |
| ChatControlCenter/chatcontrolcenter | `Apache-2.0` | Apache-2.0 | **2024-09-01** | — | 5 | **跳过** | **仓库已归档**（archived=true），且只有 5 星，参考价值低于维护成本 |
| TediCross/TediCross | `MIT` | MIT | 2026-10-28 | 8 | 724 | **参考** | 跨平台消息映射表（`chatId ↔ 对方 id`）的建模思路；我们不做桥接，不需要代码 |
| grammyjs/grammY | `MIT` | MIT | 2026-10-16 | 25 | 3785 | **参考（不迁移）** | 见 §3 |
| telegraf/telegraf | `MIT` | MIT | 2026-09-24 | 77 | 9202 | **跳过** | 迁移成本不可控，且现有传输层 130 行 + 569 条测试已经覆盖 |
| awesome-telegram 类 | `CC0-1.0` / `NONE` / `MIT` 混杂 | 逐个不同 | 2023-11 ~ 2026-09 | — | 1~602 | **参考（仅作入口）** | 同名仓库至少 4 个，必须逐个看许可证；只当索引，不抄内容 |

**四个与任务书前提不符的事实**（按证据改，不按记忆）：

1. `ScoutBot` 任务书写「✅MIT」。GitHub 元数据是 `NOASSERTION`，但 `LICENSE` 文件正文确实是 MIT 全文——
   结论是**可用**，风险在“识别失败”这件事本身：法务工具会把它标成未知许可证。
2. `iovxw/rssbot` 任务书写「✅MIT」，实际是 **Unlicense**。
3. `yt-dlp` 任务书只给了「✅」，实际是 **Unlicense**。
4. `ytdl_tg_bot` 任务书列在“🔍 待核对”里，核对结果是最坏的一种：**没有任何许可证文件**。

## 2. 三处真正改变了实现的发现

### 2.1 ScoutBot 的熔断器（借形状，不借参数）

`app/resilience/circuit_breaker.py`（120 行）是教科书实现：

```
failure_threshold = 5
recovery_timeout  = 300000 ms（5 分钟）
success_threshold = 2          # half-open 下连续 2 次成功才闭合
状态：CLOSED / OPEN / HALF_OPEN
```

同一仓库里还有 `app/utils/circuit_breaker.py` —— **同一个东西写了两份**，这是“参考者的警告”：
它是靠复制长出来的代码库。

我们的场景不是“服务降级”而是“目标站封 IP”，所以参数必须改（详见 `src/parse/breaker.ts` 头注释）：
3 次失败触发、冷却 60 s 起、每次重开翻倍、上限 30 min、半开放**一条**探针。
理由：封 IP 的恢复期比 5xx 长，但第一次探测要早——晚探测等于把站点永久拉黑。

### 2.2 scdlbot 贴封面的正确姿势（直接改了 R9d 的实现）

`scdlbot/__main__.py`（1552 行）里没有一段“下载完再手搓 ffmpeg 写 ID3”的代码。它的做法是：

```
line 976:  "--embed-art",                                   # Embed album art
line 1062: {"key": "EmbedThumbnail", 'already_have_thumbnail': False}
line 1069: "writethumbnail": True,
```

ffmpeg 只用于 `probe` 和切片（line 1177–1214、1355），不用于写标签。

**为什么这条重要**：手写 `ffmpeg -map 0 -map 1 -c copy -id3v2_version 3` 只对 mp3 正确；
m4a 要写 `covr` atom、flac/ogg 要写 `METADATA_BLOCK_PICTURE`，手搓的版本会在这些容器上
静默失败或写坏文件。yt-dlp 的 postprocessor 按容器分派，已经处理完了。

采纳结果：`--embed-thumbnail --add-metadata --write-thumbnail` 进 yt-dlp 参数表，
下载后用 `ffprobe` 验证标签与 attached-picture 流**确实存在**，验证失败才走一次 ffmpeg 兜底。

### 2.3 rssbot 的 OPML 交互（借用法，不借代码）

`/sub` `/unsub` `/unsubthis` `/export` 四个动词的职责边界很清楚：
`unsubthis` 是“回复某条消息，退订那条消息里的源”，而不是再让用户复制一遍 URL。
`/export` 出 OPML 而不是 JSON，因为 OPML 能被所有阅读器直接导入——**导出物的消费方是用户的阅读器，
不是我们的程序**。这条直接决定了 `src/rss.ts` 的 `exportOpml` 输出格式。

## 3. 框架层：为什么仍然不迁移

`grammY`（MIT，3785★，25 个开放 issue）与 `telegraf`（MIT，9202★，77 个开放 issue）都健康。
不迁移的理由不是许可证，是**已经被测试固化的表面积**：

| 项 | 现状 |
|---|---|
| 传输层 | `src/telegram.ts` 130 行，含 429 `retry_after` 退避、`until_date` 钳制、回调 38 字节上限 |
| 测试 | 569 条，其中 `test/matrix.test.ts` 按 `COMMAND_SPEC` 逐命令跑五类输入 |
| 迁移面 | 全套命令层 + 回调层 + 全部测试重写，而收益只是“用上了社区中间件” |

结论：`参考` 而不是 `集成`。等哪天要接 inline query / payments 这类框架强势领域再评估。

## 4. 集成回写（B 段四项）

| 项 | 借鉴自 | 落在哪 | 与来源的差异（有意识的） |
|---|---|---|---|
| `/rss` 订阅 + OPML | `iovxw/rssbot`（Unlicense，Rust） | `src/rss.ts`、`src/rss.node.ts`、`rss_feeds` 表、`test/rss.test.ts`(39) | rssbot 用 SQLite+FTS 存条目；我们**只存水位线**（`last_key`），条目不留档——群是消费端，不是归档器。`/export` 改名 `/sub export`，因为 `/export` 已经是配置 JSON 导出 |
| `/ocr` 图片读字 | `ScoutBot` 的 `app/commands/ocr_commands.py`（形状） | `src/ocr.ts`、`src/tools/ocr.node.ts`、`test/ocr.test.ts`(16) | ScoutBot 用 Python OCR 栈；我们用本机 `tesseract` CLI（`chi_sim+eng` 已装）。**关键差异**：我们把识别文本喂进**既有**关键词/处置链，而不是新写一套判定 |
| `/parse` 限流 + 熔断 | `ScoutBot` 的 `app/resilience/circuit_breaker.py` | `src/parse/breaker.ts`、`test/parse-breaker.test.ts`(21+1) | 参数重调：ScoutBot 5 次/300 s/需 2 次成功闭合；我们 3 次/60 s 起翻倍/上限 30 min/半开放 1 个探针。**理由**：封 IP 的恢复期长，但首次探测要早 |
| 音频元数据 | `scdlbot`（MIT） | `src/parse/ytdlp.node.ts` | 采纳其结论：**交给 yt-dlp 的 postprocessor**；ffmpeg 只做兜底与 `ffprobe` 校验。容器差异是实测的：mp3 走 `-id3v2_version 3`，mp4/m4a/flac 走 `-disposition:v attached_pic`，Ogg/Opus 只写标签 |

### 4.1 顺带建立的守卫

`test/worker-compat.test.ts`（6 条）从 `src/worker.ts` 出发**走真实 import 图**，断言 node-only 模块
（`node:*` / `sharp` / `rss-parser` / `tesseract.js`）不可达，且 `*.node.ts` 是唯一边界。
这条不是为 R9 写的装饰——它是「新库进 lockfile」这一步唯一能被机器验证的部分。

**负向对照**（必须做，否则等于没测）：往 `src/captcha.ts` 里插一行 `import Parser from "rss-parser"`，
三条测试立刻变红；删掉后恢复绿。

### 4.2 生产验证（不是单测）

| 检查 | 结果 |
|---|---|
| `wrangler deploy` | `8294850c-9fae-490d-a01c-6eda0bd5e4fc`，100% 流量 |
| Worker bundle | 2570609 B / gzip 562.65 KiB；`rss-parser` `child_process` `spawnSync` `xml2js` **各 0 次** |
| 生产 D1 | `SELECT name FROM sqlite_master` → 表 `rss_feeds` 存在；`_migrations` → `0004_rss` 已应用 |
| 真实 feed（3 个不同家族） | hnrss(RSS2) 20 条 / Cloudflare blog 20 条 / reddit `programming`(Atom) 25 条，全部解析成功 |
| 真实端到端轮询 | 订阅 hnrss → 首轮推送 **10 条** → 次轮 **0 条**（水位线在真数据上生效）；`/sub list` 学到标题；OPML 352 B 带 XML 声明 |
| `/health` | `{"ok":true,"bot":true,"db":true,"env":"production"}`，webhook `pending=0 last_error=none` |

未验证（照实记）：真实 Telegram 客户端里的渲染；真实封禁下的熔断（触发条件是注入的失败下载器）；
真实音频下载后的打标（往返只在合成正弦波上验过）。

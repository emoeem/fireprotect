/**
 * `/parse` hardening, part 1 of the R9 pass: the per-host circuit breaker and
 * the audio-tagging path.
 *
 * Everything here is fault injection or a local binary — no network, no real
 * time. The breaker takes its clock from the runtime the harness already
 * controls (`advance`), and the audio cases drive the real `ffmpeg`/`ffprobe`
 * on synthetic files so the assertion is "the tag survived the round trip",
 * not "our mock was called".
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { createBreaker } from "../src/parse/breaker.ts";
import {
  PARSE_BREAKER_COOLDOWN_MS,
  PARSE_BREAKER_FAILURE_THRESHOLD,
  PARSE_BREAKER_MAX_COOLDOWN_MS,
  parseBlockedNotice,
  parseBreakerFor,
  parseHostOf,
  runParseJob,
} from "../src/parse/service.ts";
import { embedAudioMetadata, probeAudio } from "../src/parse/ytdlp.node.ts";
import { handleMessage } from "../src/handlers/message.ts";
import { command, makeRuntime, user } from "./harness.ts";

const execFileAsync = promisify(execFile);

/** A clock the test moves by hand: the breaker must never read the real one. */
function fakeClock(start = 1_700_000_000_000) {
  let at = start;
  return {
    now: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// Breaker state machine (pure, no service, no network)
// ---------------------------------------------------------------------------

test("three consecutive failures open the breaker and the fourth call never runs the work", async () => {
  const clock = fakeClock();
  const breaker = createBreaker({ now: clock.now });
  let calls = 0;
  const work = async () => {
    calls += 1;
    throw new Error("本站封了我们的 IP");
  };

  for (let attempt = 0; attempt < PARSE_BREAKER_FAILURE_THRESHOLD; attempt++) {
    const outcome = await breaker.run("v.douyin.com", work);
    assert.equal(outcome.ok, false);
  }
  assert.equal(calls, 3, "every attempt before the threshold really ran");
  assert.equal(breaker.inspect("v.douyin.com").state, "open");

  const refused = await breaker.run("v.douyin.com", work);
  assert.equal(refused.ok, false);
  if (!refused.ok) {
    assert.equal(refused.reason, "open");
    assert.equal(refused.retryAfterMs, PARSE_BREAKER_COOLDOWN_MS);
  }
  assert.equal(calls, 3, "the rejected call must not reach the work function");
});

test("hosts are isolated: one open breaker does not refuse a different site", async () => {
  const clock = fakeClock();
  const breaker = createBreaker({ now: clock.now });
  const failing = async () => {
    throw new Error("down");
  };
  for (let index = 0; index < PARSE_BREAKER_FAILURE_THRESHOLD; index++) await breaker.run("a.example.com", failing);

  assert.equal(breaker.inspect("a.example.com").state, "open");
  assert.equal(breaker.inspect("b.example.com").state, "closed");

  let calls = 0;
  const ok = await breaker.run("b.example.com", async () => {
    calls += 1;
    return "fine";
  });
  assert.equal(ok.ok, true);
  assert.equal(calls, 1);
});

test("after the cooldown exactly one probe is let through; a concurrent second call is rejected", async () => {
  const clock = fakeClock();
  const breaker = createBreaker({ now: clock.now });
  const failing = async () => {
    throw new Error("down");
  };
  for (let index = 0; index < PARSE_BREAKER_FAILURE_THRESHOLD; index++) await breaker.run("c.example.com", failing);

  clock.advance(PARSE_BREAKER_COOLDOWN_MS - 1);
  assert.equal(breaker.inspect("c.example.com").state, "open", "one millisecond early is still open");

  clock.advance(1);
  assert.equal(breaker.inspect("c.example.com").state, "half-open");

  // The probe is held open by a promise we control, so the second caller
  // arrives while it is genuinely in flight — the real race.
  let release: (value: string) => void = () => undefined;
  const pending = new Promise<string>((resolve) => {
    release = resolve;
  });
  let reached = 0;
  const slow = async () => {
    reached += 1;
    return pending;
  };

  const probe = breaker.run("c.example.com", slow);
  const second = await breaker.run("c.example.com", slow);
  assert.equal(reached, 1, "only the probe reached the work function");
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, "open");

  release("recovered");
  const first = await probe;
  assert.equal(first.ok, true);
  // The double-report path must not jam the host: further calls pass.
  assert.equal(breaker.inspect("c.example.com").state, "closed");
});

test("probe success closes the breaker and resets the failure counter", async () => {
  const clock = fakeClock();
  const breaker = createBreaker({ now: clock.now });
  const failing = async () => {
    throw new Error("down");
  };
  for (let index = 0; index < PARSE_BREAKER_FAILURE_THRESHOLD; index++) await breaker.run("d.example.com", failing);
  clock.advance(PARSE_BREAKER_COOLDOWN_MS);

  assert.equal((await breaker.run("d.example.com", async () => "back")).ok, true);
  assert.equal(breaker.inspect("d.example.com").state, "closed");

  let calls = 0;
  for (let index = 0; index < PARSE_BREAKER_FAILURE_THRESHOLD; index++) {
    await breaker.run("d.example.com", async () => {
      calls += 1;
      return "ok";
    });
  }
  assert.equal(calls, 3, "three good calls after a success all reach the work");
});

test("probe failure re-opens with a doubled cooldown, and the expiry is exact", async () => {
  const clock = fakeClock();
  const breaker = createBreaker({ now: clock.now });
  const failing = async () => {
    throw new Error("still down");
  };
  for (let index = 0; index < PARSE_BREAKER_FAILURE_THRESHOLD; index++) await breaker.run("e.example.com", failing);
  assert.equal(breaker.inspect("e.example.com").retryAfterMs, PARSE_BREAKER_COOLDOWN_MS);

  clock.advance(PARSE_BREAKER_COOLDOWN_MS);
  const probe = await breaker.run("e.example.com", failing);
  assert.equal(probe.ok, false);
  if (!probe.ok) assert.equal(probe.retryAfterMs, PARSE_BREAKER_COOLDOWN_MS * 2);

  const doubled = breaker.inspect("e.example.com");
  assert.equal(doubled.state, "open");
  assert.equal(doubled.retryAfterMs, PARSE_BREAKER_COOLDOWN_MS * 2);
  assert.equal(doubled.cooldownMs, PARSE_BREAKER_COOLDOWN_MS * 2);

  // Exactness: 1 ms before the new expiry it is still shut, at the expiry it opens.
  clock.advance(PARSE_BREAKER_COOLDOWN_MS * 2 - 1);
  assert.equal(breaker.inspect("e.example.com").state, "open");
  clock.advance(1);
  assert.equal(breaker.inspect("e.example.com").state, "half-open");
});

test("the cooldown doubling stops at the cap", async () => {
  const clock = fakeClock();
  const breaker = createBreaker({ now: clock.now });
  const failing = async () => {
    throw new Error("permanently down");
  };
  for (let index = 0; index < PARSE_BREAKER_FAILURE_THRESHOLD; index++) await breaker.run("f.example.com", failing);

  const seen: number[] = [];
  for (let round = 0; round < 8; round++) {
    seen.push(breaker.inspect("f.example.com").cooldownMs);
    clock.advance(breaker.inspect("f.example.com").retryAfterMs);
    await breaker.run("f.example.com", failing);
  }
  assert.deepEqual(seen, [60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000, 1_800_000]);
  assert.equal(breaker.inspect("f.example.com").cooldownMs, PARSE_BREAKER_MAX_COOLDOWN_MS, "never past the cap");
});

test("a success between failures resets the consecutive count", async () => {
  const clock = fakeClock();
  const breaker = createBreaker({ now: clock.now });
  const failing = async () => {
    throw new Error("flaky");
  };

  await breaker.run("g.example.com", failing);
  await breaker.run("g.example.com", failing);
  assert.equal(breaker.inspect("g.example.com").failures, 2);
  assert.equal(breaker.inspect("g.example.com").state, "closed");

  assert.equal((await breaker.run("g.example.com", async () => "ok")).ok, true);
  assert.equal(breaker.inspect("g.example.com").failures, 0);

  await breaker.run("g.example.com", failing);
  await breaker.run("g.example.com", failing);
  assert.equal(breaker.inspect("g.example.com").state, "closed", "count restarted, threshold not reached");
});

test("the probe grace releases a caller that never reports back", async () => {
  const clock = fakeClock();
  const breaker = createBreaker({ now: clock.now, probeGraceMs: 5_000 });
  const failing = async () => {
    throw new Error("down");
  };
  for (let index = 0; index < PARSE_BREAKER_FAILURE_THRESHOLD; index++) await breaker.run("h.example.com", failing);
  clock.advance(PARSE_BREAKER_COOLDOWN_MS);

  // Take a probe and never report it: the host must not stay jammed forever.
  assert.equal(breaker.allow("h.example.com").allow, true);
  assert.equal(breaker.allow("h.example.com").allow, false);
  clock.advance(5_000);
  assert.equal(breaker.allow("h.example.com").allow, true);
});

// ---------------------------------------------------------------------------
// Service integration: the explicit message, and the budget that must survive
// ---------------------------------------------------------------------------

/** A downloader that fails for one host and succeeds for another, counting calls. */
function countingDownloader(failingHosts: string[]) {
  const calls: string[] = [];
  const download = async (url: string) => {
    calls.push(url);
    const host = parseHostOf(url);
    if (failingHosts.includes(host)) return { ok: false as const, error: "yt-dlp 返回 502" };
    return { ok: true as const, title: "一条视频", media: [{ name: "cover.jpg", bytes: new Uint8Array([1, 2]), kind: "image" as const }] };
  };
  return { download, calls };
}

test("an open breaker answers 该站暂不支持, and that is not the rate-limit message", async () => {
  const h = await makeRuntime();
  const spy = countingDownloader(["www.bilibili.com"]);
  h.rt.parseDownloader = spy.download;

  const url = "https://www.bilibili.com/video/BV1";
  for (let index = 0; index < PARSE_BREAKER_FAILURE_THRESHOLD; index++) {
    const outcome = await runParseJob(h.rt, { id: 0, chatId: -1001, messageId: 5, url, site: "bilibili" });
    assert.equal(outcome.ok, false);
    // The failure that opens the breaker already says it is pausing.
    if (index === PARSE_BREAKER_FAILURE_THRESHOLD - 1) assert.match(outcome.error, /已暂停 1 分钟/);
  }
  assert.equal(spy.calls.length, 3);

  const blocked = await runParseJob(h.rt, { id: 0, chatId: -1001, messageId: 6, url, site: "bilibili" });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /该站暂不支持/);
  assert.match(blocked.error, /连续失败已暂停/);
  assert.equal(spy.calls.length, 3, "a refused parse must not touch the network");

  // The two messages must be tellable apart by an admin reading the log.
  const rateLimit = "本小时解析次数已用完（上限 1 次），稍后再试。";
  assert.doesNotMatch(blocked.error, /次数已用完|本小时/);
  assert.notEqual(parseBlockedNotice("www.bilibili.com", 60_000), rateLimit);
});

test("the blocked message reaches the chat through the real command path", async () => {
  const h = await makeRuntime();
  h.rt.parseDownloader = countingDownloader(["www.bilibili.com"]).download;

  for (let index = 0; index < PARSE_BREAKER_FAILURE_THRESHOLD + 1; index++) {
    await handleMessage(h.rt, command(`/parse https://www.bilibili.com/video/BV${index}`, { from: user(500) }));
  }
  const texts = h.fake.all("sendMessage").map((call) => String(call.body.text));
  assert.equal(texts.length, PARSE_BREAKER_FAILURE_THRESHOLD + 1, "one reply per command, none silent");
  assert.match(texts.at(-1) ?? "", /该站暂不支持/);
});

test("host A being blocked does not block host B through the service", async () => {
  const h = await makeRuntime();
  const spy = countingDownloader(["www.bilibili.com"]);
  h.rt.parseDownloader = spy.download;

  for (let index = 0; index < PARSE_BREAKER_FAILURE_THRESHOLD; index++) {
    await runParseJob(h.rt, { id: 0, chatId: -1001, messageId: 5, url: "https://www.bilibili.com/video/BV1", site: "bilibili" });
  }
  const other = await runParseJob(h.rt, { id: 0, chatId: -1001, messageId: 6, url: "https://x.com/telegram/status/1", site: "twitter" });
  assert.equal(other.ok, true);
  assert.equal(other.sent, 1);
});

test("the per-chat hourly budget still refuses the call after the limit, before any work", async () => {
  let fetches = 0;
  const h = await makeRuntime({
    fetchImpl: async () => {
      fetches += 1;
      throw new Error("offline");
    },
  });
  await h.rt.saveConfig(-1001, { parsePerHour: 1, keywords: [] });

  await handleMessage(h.rt, command("/parse https://www.bilibili.com/video/BV1", { from: user(500) }));
  await handleMessage(h.rt, command("/parse https://www.bilibili.com/video/BV2", { from: user(500) }));

  const texts = h.fake.all("sendMessage").map((call) => String(call.body.text));
  assert.ok(texts.some((text) => /次数已用完/.test(text)), "the (limit+1)th call is refused");
  assert.equal(fetches, 1, "the refused call never reached the network");
  assert.equal(texts.some((text) => /该站暂不支持/.test(text)), false, "a budget refusal is not a site block");
});

test("a downloader that throws becomes a failed parse with its own reason, and still counts for the breaker", async () => {
  const h = await makeRuntime();
  h.rt.parseDownloader = async () => {
    throw new Error("sharp: unsupported image format");
  };

  const outcome = await runParseJob(h.rt, { id: 0, chatId: -1001, messageId: 5, url: "https://www.bilibili.com/video/BV1", site: "bilibili" });
  assert.equal(outcome.ok, false, "a throw must not escape the job");
  assert.match(outcome.error, /unsupported image format/);
  assert.equal(parseBreakerFor(h.rt).inspect("www.bilibili.com").failures, 1, "a throw is still a host failure");
});

test("an audio download is delivered as a document, not as a photo", async () => {
  const h = await makeRuntime();
  h.rt.parseDownloader = async () => ({
    ok: true,
    title: "一首歌",
    media: [{ name: "track.mp3", bytes: new Uint8Array([1, 2, 3]), kind: "audio" }],
  });
  await runParseJob(h.rt, { id: 0, chatId: -1001, messageId: 5, url: "https://www.bilibili.com/video/BV1", site: "bilibili" });

  const documents = h.fake.all("sendDocument");
  assert.equal(documents.length, 1, "an audio file must not be sent through sendPhoto");
  assert.equal(documents[0].file?.filename, "track.mp3");
  assert.equal(h.fake.count("sendPhoto"), 0);
  assert.equal(documents[0].body.caption, "一首歌");
});

test("a row whose URL has no host skips the breaker instead of sharing one bucket", async () => {
  const h = await makeRuntime();
  const spy = countingDownloader(["www.bilibili.com"]);
  h.rt.parseDownloader = spy.download;

  // Garbage in the job row: no host to key on, so the work still runs.
  const outcome = await runParseJob(h.rt, { id: 0, chatId: -1001, messageId: 5, url: "乱写", site: "" });
  assert.equal(outcome.ok, true);
  assert.equal(spy.calls.length, 1);
  assert.equal(parseHostOf("乱写"), "");
});

test("the breaker state is per runtime, so one test's ban cannot leak", async () => {
  const first = await makeRuntime();
  const second = await makeRuntime();
  first.rt.parseDownloader = countingDownloader(["www.bilibili.com"]).download;
  second.rt.parseDownloader = countingDownloader(["www.bilibili.com"]).download;

  for (let index = 0; index < PARSE_BREAKER_FAILURE_THRESHOLD; index++) {
    await runParseJob(first.rt, { id: 0, chatId: -1001, messageId: 5, url: "https://www.bilibili.com/video/BV1", site: "bilibili" });
  }
  assert.equal(parseBreakerFor(first.rt).inspect("www.bilibili.com").state, "open");
  assert.equal(parseBreakerFor(second.rt).inspect("www.bilibili.com").state, "closed");
});

// ---------------------------------------------------------------------------
// Audio tags: the real ffmpeg/ffprobe, a synthetic sine wave, a real round trip
// ---------------------------------------------------------------------------

/** `null` when the binary is there, or the reason it is not. */
async function missingBinary(bin: string): Promise<string | null> {
  try {
    await execFileAsync(bin, ["-version"]);
    return null;
  } catch (err) {
    return `本机没有 ${bin}：${err instanceof Error ? err.message : String(err)}`;
  }
}

/** A 1 s 440 Hz sine wave, plus a 64×64 cover, both generated locally. */
async function makeAudioFixture(dir: string, ext: string): Promise<string> {
  const path = join(dir, `track.${ext}`);
  await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", path]);
  return path;
}

async function makeCover(dir: string): Promise<string> {
  const path = join(dir, "cover.jpg");
  await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64", "-frames:v", "1", path]);
  return path;
}

test("a downloaded mp3 gets title/artist/album and a cover, and ffprobe reads them back", async (t) => {
  const missing = (await missingBinary("ffmpeg")) ?? (await missingBinary("ffprobe"));
  if (missing) return t.skip(missing);

  const dir = await mkdtemp(join(tmpdir(), "fw-audio-"));
  try {
    const input = await makeAudioFixture(dir, "mp3");
    const cover = await makeCover(dir);
    const output = join(dir, "tagged.mp3");

    const result = await embedAudioMetadata({ inputPath: input, outputPath: output, tags: { title: "边关月", artist: "无名氏", album: "测试专辑" }, coverPath: cover });
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    if (!result.ok) return;

    // Read the tags the same way the production code and a music player do.
    const check = await probeAudio(output);
    assert.ok(check, "ffprobe must still see an audio file");
    assert.equal(check.tags.title, "边关月");
    assert.equal(check.tags.artist, "无名氏");
    assert.equal(check.tags.album, "测试专辑");

    // The cover really is an attached picture stream, not a trailer.
    const streams = JSON.parse(
      (await execFileAsync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", output])).stdout,
    ) as { streams: { codec_type?: string; disposition?: { attached_pic?: number } }[] };
    assert.ok(
      streams.streams.some((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic === 1),
      "an attached_pic stream must carry the cover",
    );

    // And the bytes handed back to the sender are the tagged file, not the original.
    const bytes = await readFile(output);
    assert.deepEqual(Buffer.from(result.bytes), bytes);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("an m4a takes the same tags (a different container, the same guarantee)", async (t) => {
  const missing = (await missingBinary("ffmpeg")) ?? (await missingBinary("ffprobe"));
  if (missing) return t.skip(missing);

  const dir = await mkdtemp(join(tmpdir(), "fw-audio-"));
  try {
    const input = await makeAudioFixture(dir, "m4a");
    const cover = await makeCover(dir);
    const output = join(dir, "tagged.m4a");
    const result = await embedAudioMetadata({ inputPath: input, outputPath: output, tags: { title: "M4A 标题" }, coverPath: cover });
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    if (!result.ok) return;
    const check = await probeAudio(output);
    assert.equal(check?.tags.title, "M4A 标题");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("a container that cannot hold a cover still gets its tags (fail-degraded, not fail)", async (t) => {
  const missing = (await missingBinary("ffmpeg")) ?? (await missingBinary("ffprobe"));
  if (missing) return t.skip(missing);

  const dir = await mkdtemp(join(tmpdir(), "fw-audio-"));
  try {
    const input = await makeAudioFixture(dir, "opus");
    const cover = await makeCover(dir);
    const output = join(dir, "tagged.opus");
    const result = await embedAudioMetadata({ inputPath: input, outputPath: output, tags: { title: "奥格标题" }, coverPath: cover });
    assert.equal(result.ok, true, result.ok ? "" : result.error);
    if (!result.ok) return;
    const check = await probeAudio(output);
    assert.equal(check?.tags.title, "奥格标题", "Ogg keeps tags on the stream; the probe must see them");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("a non-audio file is refused by the tagger, so the download path keeps it untouched", async (t) => {
  const missing = await missingBinary("ffmpeg");
  if (missing) return t.skip(missing);
  if (await missingBinary("ffprobe")) return t.skip("本机没有 ffprobe");

  const dir = await mkdtemp(join(tmpdir(), "fw-audio-"));
  try {
    const image = join(dir, "cover.png");
    await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=32x32", "-frames:v", "1", image]);
    const before = await readFile(image);

    const result = await embedAudioMetadata({ inputPath: image, outputPath: join(dir, "out.mp3"), tags: { title: "不该发生" } });
    assert.equal(result.ok, false, "a PNG is not audio");
    assert.deepEqual(await readFile(image), before, "the input is never modified");
    assert.equal(await probeAudio(image), null, "probeAudio agrees it is not audio");
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("a corrupt file fails open instead of throwing", async (t) => {
  if (await missingBinary("ffmpeg")) return t.skip("本机没有 ffmpeg");
  if (await missingBinary("ffprobe")) return t.skip("本机没有 ffprobe");

  const dir = await mkdtemp(join(tmpdir(), "fw-audio-"));
  try {
    const fake = join(dir, "broken.mp3");
    await writeFile(fake, "not really an mp3");
    const result = await embedAudioMetadata({ inputPath: fake, outputPath: join(dir, "out.mp3"), tags: { title: "x" } });
    assert.equal(result.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------
// The command-level pre-check (wired in `cmdParse`, not in the service)
// ---------------------------------------------------------------------------

test("a command against a blocked host is answered before the hourly budget is spent", async () => {
  const h = await makeRuntime();
  const spy = countingDownloader(["www.bilibili.com"]);
  h.rt.parseDownloader = spy.download;
  // Budget of exactly one. If the blocked-host pre-check ran after `allowParse`,
  // the blocked command would eat the only slot and the healthy host afterwards
  // would be refused with "次数已用完" — that is the failure this pins down.
  await h.rt.saveConfig(-1001, { parsePerHour: 1 });

  // Open the breaker through the service (which is not budgeted), so the test is
  // about the command's ordering and not about accumulating failures through it.
  for (let index = 0; index < PARSE_BREAKER_FAILURE_THRESHOLD; index++) {
    await runParseJob(h.rt, {
      id: 0,
      chatId: -1001,
      messageId: 5,
      url: `https://www.bilibili.com/video/BV${index}`,
      site: "bilibili",
    });
  }
  assert.equal(parseBreakerFor(h.rt).inspect("www.bilibili.com").state, "open", "the breaker is open before the command runs");
  const before = spy.calls.length;
  h.fake.reset();

  await handleMessage(h.rt, command("/parse https://www.bilibili.com/video/BVblocked", { from: user(500) }));
  const texts = h.fake.all("sendMessage").map((call) => String(call.body.text));

  assert.equal(texts.length, 1, "the admin gets exactly one answer, not silence");
  assert.match(texts[0], /该站暂不支持/, "the block is named explicitly");
  assert.match(texts[0], /原消息保留/, "and the user is told nothing was touched");
  assert.doesNotMatch(texts[0], /次数已用完|本小时/, "it is not the budget message");
  assert.equal(spy.calls.length, before, "no download was attempted for a blocked host");

  // The budget slot survived: a healthy host on the same budget still works.
  h.fake.reset();
  await handleMessage(h.rt, command("/parse https://x.com/telegram/status/1", { from: user(500) }));
  const healthy = h.fake.all("sendMessage").map((call) => String(call.body.text));
  assert.ok(!healthy.some((text) => /次数已用完/.test(text)), "the blocked call did not consume the hourly budget");
  assert.ok(spy.calls.length > before, "the healthy host actually reached the downloader");
});

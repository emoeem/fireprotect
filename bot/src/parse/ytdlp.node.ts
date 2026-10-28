/**
 * yt-dlp-backed media fetch. **Node only.**
 *
 * `yt-dlp` is the mature answer to "give me the media behind this page": it
 * already knows 1800 sites, keeps up with their changes, and shelling out to a
 * binary is cheaper than reimplementing four extractors that rot monthly.
 *
 * The Worker must never import this file — it spawns processes and loads
 * `sharp`. `context.ts` takes the downloader as an injected function, exactly
 * like `sliceImage`, so the Worker dependency graph stays clean (verified by
 * `wrangler deploy --dry-run` and the `node:` grep in `npm run verify`).
 *
 * Boundaries that are enforced here, not in the caller:
 *  - 40 MB per file: Telegram's bot upload cap is 50 MB, and a 4K video is not
 *    worth a failed upload after two minutes of downloading;
 *  - 90 s total: a slow site must not pin the queue;
 *  - long screenshots are sliced here, because this is where the pixels and the
 *    dimension probe already are.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import sharp from "sharp";
import type { ParseMedia, ParseResult } from "./service.ts";
import { publicHttpUrl } from "../url-guard.ts";

export const MAX_VIDEO_BYTES = 40 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const PROBE_TIMEOUT_MS = 20_000;
export const DOWNLOAD_TIMEOUT_MS = 90_000;
/** ffprobe/ffmpeg on a local file: seconds, not minutes. Kept short so tagging never becomes the slow path. */
export const TAG_TIMEOUT_MS = 20_000;
/** Slice when the image is taller than this multiple of its width. */
export const LONG_RATIO = 3;
export const LONG_MIN_HEIGHT = 2_400;

type YtdlpMeta = {
  _type?: string;
  title?: string;
  description?: string;
  thumbnail?: string;
  thumbnails?: { url?: string; preference?: number }[];
  url?: string;
  webpage_url?: string;
  entries?: YtdlpMeta[];
  filesize_approx?: number;
  duration?: number;
  // Music metadata yt-dlp already reports for audio sources. `uploader` is the
  // last resort: an audio post on a video site carries no `artist`, and "who
  // posted it" still beats an empty tag.
  artist?: string;
  album?: string;
  creator?: string;
  uploader?: string;
  channel?: string;
  track?: string;
};

/**
 * Spawn a binary with a hard timeout and collect stdout.
 *
 * Shared by `yt-dlp`, `ffprobe` and `ffmpeg` so the timeout/kill/stderr
 * handling exists once. No shell is involved: the binary and its arguments go
 * to the process as an argv array. `stderr` is capped because ffmpeg on a
 * corrupt file can print megabytes of frame errors, and the last line is what
 * we quote.
 */
function spawnBin(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value: { ok: true; stdout: string } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, error: `${bin} 超过 ${Math.round(timeoutMs / 1000)} 秒` });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      // A metadata dump is a few hundred KB; anything past 8 MB is not ours.
      if (stdout.length < 8 * 1024 * 1024) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4_000) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => finish({ ok: false, error: `无法启动 ${bin}：${err.message}` }));
    child.on("close", (code) => {
      if (code === 0) return finish({ ok: true, stdout });
      const line = stderr.split("\n").filter(Boolean).pop() ?? `退出码 ${code}`;
      finish({ ok: false, error: line.replace(/^ERROR:\s*/i, "").slice(0, 200) });
    });
  });
}

function run(args: string[], timeoutMs: number): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  return spawnBin("yt-dlp", args, timeoutMs);
}

function bestThumbnail(meta: YtdlpMeta): string {
  if (Array.isArray(meta.thumbnails) && meta.thumbnails.length) {
    const sorted = [...meta.thumbnails].filter((entry) => entry.url).sort((a, b) => (b.preference ?? 0) - (a.preference ?? 0));
    if (sorted[0]?.url) return sorted[0].url;
  }
  return meta.thumbnail ?? "";
}

async function fetchBytes(url: string, limit: number): Promise<Uint8Array | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { "user-agent": "Mozilla/5.0" } });
    if (!response.ok) return null;
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.byteLength > limit ? null : buffer;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Split a long screenshot into readable strips; returns [original] otherwise. */
export async function sliceLongImage(bytes: Uint8Array, name: string): Promise<ParseMedia[]> {
  try {
    const meta = await sharp(bytes).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (!width || !height) return [{ name, bytes, kind: "image" }];
    if (height < LONG_MIN_HEIGHT || height / width < LONG_RATIO) return [{ name, bytes, kind: "image" }];
    const sliceHeight = Math.min(Math.max(Math.round(width * 1.8), 800), 2000);
    const total = Math.ceil(height / sliceHeight);
    const out: ParseMedia[] = [];
    for (let index = 0; index < Math.min(total, 10); index++) {
      const top = index * sliceHeight;
      const h = Math.min(sliceHeight, height - top);
      if (h <= 0) break;
      const slice = await sharp(bytes).extract({ left: 0, top, width, height: h }).jpeg({ quality: 86 }).toBuffer();
      out.push({ name: `${name.replace(/\.[a-z0-9]+$/i, "")}-${index + 1}of${Math.min(total, 10)}.jpg`, bytes: new Uint8Array(slice), kind: "image" });
    }
    return out.length ? out : [{ name, bytes, kind: "image" }];
  } catch {
    return [{ name, bytes, kind: "image" }];
  }
}

/**
 * Fetch what a share link points at.
 *
 * Order is "cheapest that gives a real result": metadata first (one request),
 * then the cover image, then the video only if it is small enough to upload.
 * A pure image post therefore never downloads a video, and a 4K upload
 * degrades to "cover + link" instead of failing after ninety seconds.
 */
export async function fetchWithYtdlp(rawUrl: string): Promise<ParseResult> {
  // Chat-supplied, so it ends up in a subprocess argv: only a public http(s)
  // URL passes, which also rules out the "-starts-with-a-flag" trick.
  const url = publicHttpUrl(rawUrl);
  if (!url) return { ok: false, error: "链接不是可访问的 http(s) 地址" };
  const probe = await run(["-J", "--no-warnings", "--no-playlist", "--socket-timeout", "8", url], PROBE_TIMEOUT_MS);
  if (!probe.ok) return { ok: false, error: probe.error };

  let meta: YtdlpMeta;
  try {
    meta = JSON.parse(probe.stdout) as YtdlpMeta;
  } catch {
    return { ok: false, error: "yt-dlp 返回的元数据无法解析" };
  }

  const entries = Array.isArray(meta.entries) && meta.entries.length ? meta.entries.slice(0, 9) : [meta];
  const media: ParseMedia[] = [];
  let index = 0;
  /**
   * The cover bytes already in hand. Reused as the embedded album art so a
   * single-track audio post costs no extra request.
   */
  let firstCover: Uint8Array | null = null;

  for (const entry of entries) {
    index += 1;
    // Thumbnail URLs come from the page's own metadata, i.e. from the remote
    // site: they get the same gate before this process fetches them.
    const thumb = publicHttpUrl(bestThumbnail(entry));
    if (thumb) {
      const bytes = await fetchBytes(thumb, MAX_IMAGE_BYTES);
      if (bytes) {
        if (!firstCover) firstCover = bytes;
        media.push(...(await sliceLongImage(bytes, `cover-${index}.jpg`)));
      }
    }
    if (media.length >= 9) break;
  }

  const single = entries[0];
  const looksLikeVideo = Boolean(single && (single.duration ?? 0) > 0) && !Array.isArray(meta.entries);
  if (looksLikeVideo) {
    const dir = await mkdtemp(join(tmpdir(), "fwparse-"));
    try {
      const target = join(dir, "media.%(ext)s");
      // Cap the resolution instead of filtering on `filesize`: DASH formats
      // usually have no known size, so `[filesize<40M]` silently matches
      // nothing and the whole download is skipped. 720p is the right default
      // for a chat bot anyway — 1080p60 on 哔哩哔哩 needs premium cookies.
      const args = [
        "-f",
        "bv*[height<=720]+ba/b[height<=720]/b",
        "--max-filesize",
        String(MAX_VIDEO_BYTES),
        "--no-playlist",
        "--no-warnings",
        "--socket-timeout",
        "10",
        "--merge-output-format",
        "mp4",
        "-o",
        target,
        url,
      ];
      const download = await run(args, DOWNLOAD_TIMEOUT_MS);
      if (download.ok) {
        for (const name of await readdir(dir)) {
          const path = join(dir, name);
          let bytes: Uint8Array = new Uint8Array(await readFile(path));
          if (bytes.byteLength > MAX_VIDEO_BYTES || bytes.byteLength === 0) continue;
          const kind = mediaKind(name);
          // An audio-only download gets its tags and cover written in before it
          // leaves: Telegram shows title/artist from the file itself, and an
          // untagged mp3 arrives as a nameless blob in the chat.
          if (kind === "audio") {
            const tagged = await tagAudio(path, name, dir, single ?? meta, firstCover);
            if (tagged) bytes = tagged;
          }
          media.push({ name: kind === "video" ? "video.mp4" : name, bytes, kind });
        }
      } else if (!media.length) {
        return { ok: false, error: download.error };
      }
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  if (!media.length) return { ok: false, error: "没有取到可发送的媒体" };
  return { ok: true, title: String(meta.title ?? "").slice(0, 200), media: media.slice(0, 10) };
}

// ---------------------------------------------------------------------------
// Audio: tags and cover
// ---------------------------------------------------------------------------

/**
 * Extensions that can only be audio.
 *
 * `.webm`/`.mp4` are absent on purpose: they hold video far more often than
 * music here, and a container that *might* be video is judged by ffprobe
 * instead — see `probeAudio`.
 */
const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|flac|opus|oga|ogg|wav|weba)$/i;

function mediaKind(name: string): ParseMedia["kind"] {
  if (/\.(mp4|webm|mkv|mov)$/i.test(name)) return "video";
  if (AUDIO_EXT.test(name)) return "audio";
  return "image";
}

type FfprobeJson = {
  format?: { format_name?: string; tags?: Record<string, string> };
  streams?: { codec_type?: string; disposition?: { attached_pic?: number }; tags?: Record<string, string> }[];
};

export type AudioProbe = { format: string; tags: Record<string, string> };

/**
 * `ffprobe -show_format -show_streams -of json`, reduced to what we need.
 *
 * Returns `null` for anything that is not audio-only: a file with a real video
 * stream is a video, and wrapping tags around it would relabel a clip as music.
 * An embedded cover counts as a video stream too — hence `attached_pic`.
 */
export async function probeAudio(path: string): Promise<AudioProbe | null> {
  const res = await spawnBin("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", path], TAG_TIMEOUT_MS);
  if (!res.ok) return null;
  let json: FfprobeJson;
  try {
    json = JSON.parse(res.stdout) as FfprobeJson;
  } catch {
    return null;
  }
  const streams = json.streams ?? [];
  const hasAudio = streams.some((stream) => stream.codec_type === "audio");
  const hasRealVideo = streams.some((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1);
  if (!hasAudio || hasRealVideo) return null;
  const tags: Record<string, string> = {};
  // Ogg/Opus keep title/artist on the *stream*, not on the container, so a
  // format-only read reports an untagged file and the verification below would
  // throw away a perfectly good tag write. Container tags still win, and only
  // audio streams are read: the cover stream carries `title=Album cover`, which
  // would otherwise masquerade as the track title.
  for (const stream of streams) {
    if (stream.codec_type !== "audio") continue;
    for (const [key, value] of Object.entries(stream.tags ?? {})) tags[key.toLowerCase()] = String(value);
  }
  for (const [key, value] of Object.entries(json.format?.tags ?? {})) tags[key.toLowerCase()] = String(value);
  return { format: String(json.format?.format_name ?? ""), tags };
}

export type AudioTags = { title: string; artist: string; album: string };

/**
 * `-map`/codec flags per container.
 *
 * The three families need three different invocations and there is no single
 * one that works: `-id3v2_version` is an ID3 option (mp3 only), the MP4 and
 * FLAC muxers need `attached_pic` to accept a still image at all, and an Ogg
 * stream cannot carry a picture — trying the mp3 command on a `.m4a` fails with
 * "Could not find tag for codec mjpeg". All three verified on this machine.
 */
function embedArgs(inputPath: string, outputPath: string, tags: AudioTags, coverPath: string | undefined, format: string): string[] {
  const meta: string[] = [];
  if (tags.title) meta.push("-metadata", `title=${tags.title}`);
  if (tags.artist) meta.push("-metadata", `artist=${tags.artist}`);
  if (tags.album) meta.push("-metadata", `album=${tags.album}`);

  const base = ["-y", "-hide_banner", "-loglevel", "error", "-i", inputPath];
  if (!coverPath) return [...base, "-map", "0", "-c", "copy", ...meta, outputPath];

  const streams = ["-map", "0", "-map", "1", "-c", "copy"];
  if (format.includes("mp3")) streams.push("-id3v2_version", "3");
  if (format.includes("mp4") || format.includes("mov") || format.includes("flac")) streams.push("-disposition:v", "attached_pic");
  streams.push("-metadata:s:v", "title=Album cover", "-metadata:s:v", "comment=Cover (front)");
  return [...base, "-i", coverPath, ...streams, ...meta, outputPath];
}

/**
 * Write title/artist/album (and cover art, when the container allows it) into
 * an audio file.
 *
 * **Fail-open by contract.** Every failure — ffmpeg or ffprobe missing, a
 * container that will not take tags, a codec `-c copy` rejects, a timeout —
 * returns `{ ok: false }` and the caller keeps the file exactly as downloaded.
 * Tagging is a nicety; it must never turn a successful download into a failed
 * parse, so nothing here throws and nothing here deletes the input.
 */
export async function embedAudioMetadata(options: {
  inputPath: string;
  outputPath: string;
  tags: Partial<AudioTags>;
  /** Album art. Omitted or unreadable → tags only. */
  coverPath?: string;
}): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; error: string }> {
  const probed = await probeAudio(options.inputPath);
  if (!probed) return { ok: false, error: "不是纯音频文件" };

  // Page metadata wins; the file's own tags fill the gaps. yt-dlp sometimes
  // already wrote `artist` and losing it to an empty `creator` would be a
  // regression, not a default.
  const tags: AudioTags = {
    title: String(options.tags.title ?? "").trim() || probed.tags.title || "",
    artist: String(options.tags.artist ?? "").trim() || probed.tags.artist || "",
    album: String(options.tags.album ?? "").trim() || probed.tags.album || "",
  };

  const withCover = options.coverPath ? embedArgs(options.inputPath, options.outputPath, tags, options.coverPath, probed.format) : null;
  const tagsOnly = embedArgs(options.inputPath, options.outputPath, tags, undefined, probed.format);

  // Try the cover, fall back to tags-only: the cover is the part that depends
  // on the container, and a tagged track without art still beats no track.
  for (const args of withCover ? [withCover, tagsOnly] : [tagsOnly]) {
    const res = await spawnBin("ffmpeg", args, TAG_TIMEOUT_MS);
    if (!res.ok) continue;
    const check = await probeAudio(options.outputPath);
    if (!check) continue;
    // A silent tag write would ship an untagged file and call it done.
    if (tags.title && check.tags.title !== tags.title) continue;
    try {
      return { ok: true, bytes: new Uint8Array(await readFile(options.outputPath)) };
    } catch {
      return { ok: false, error: "读取标注后的音频失败" };
    }
  }
  return { ok: false, error: "写入音频标签失败" };
}

/** Tags a downloaded audio file should carry, from the page's own metadata. */
function audioTagsFor(meta: YtdlpMeta): Partial<AudioTags> {
  return {
    title: meta.title || meta.track || "",
    artist: meta.artist || meta.creator || meta.uploader || meta.channel || "",
    album: meta.album || "",
  };
}

/**
 * Tag one downloaded file, inside the temp dir that is about to be deleted.
 *
 * Returns the tagged bytes, or `null` for "keep the original" — the whole point
 * of the fail-open contract above. Deliberately swallows everything: this is
 * called on the download path, where a throw would lose a file that downloaded
 * fine.
 */
async function tagAudio(path: string, name: string, dir: string, meta: YtdlpMeta, cover: Uint8Array | null): Promise<Uint8Array | null> {
  try {
    let coverPath: string | undefined;
    if (cover && cover.byteLength > 0) {
      coverPath = join(dir, `cover${basename(name, extname(name))}.jpg`);
      await writeFile(coverPath, cover);
    }
    const outputPath = join(dir, `tagged${basename(name, extname(name))}${extname(name)}`);
    const result = await embedAudioMetadata({
      inputPath: path,
      outputPath,
      tags: audioTagsFor(meta),
      coverPath,
    });
    return result.ok ? result.bytes : null;
  } catch {
    // ffmpeg/ffprobe missing, temp dir unwritable, anything else: the original
    // file is still on disk and still uploadable, so this is not a parse error.
    return null;
  }
}


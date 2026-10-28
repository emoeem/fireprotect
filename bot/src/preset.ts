/**
 * First-activation defaults.
 *
 * A freshly added bot that ships with "everything off" is a bot that does
 * nothing until someone reads the docs. The preset below is what a group gets
 * on first contact: strict enough to stop the obvious flood, loose enough that
 * a normal member never notices (no keyword filter, no external calls, no
 * logging to a channel the group has not chosen).
 *
 * It is written once per chat and then owned by the group; `/set` and the
 * console change it from there. The console can also edit the preset itself,
 * which is stored at `preset:global` and applied to chats that have never been
 * initialised.
 */
import type { Runtime } from "./context.ts";
import { getPreset, savePreset } from "./store-preset.ts";
import type { ChatConfig } from "./rules.ts";

export const PRESET: Partial<ChatConfig> = {
  captcha: true,
  captchaMode: "button",
  captchaTimeout: 900,
  captchaKick: true,
  welcome: true,
  deleteJoinMessages: true,
  // 5 messages in 10 seconds: high enough for a lively argument, low enough to
  // catch a paste-flood before it fills the screen.
  floodLimit: 5,
  floodWindow: 10,
  // 12 joins in 30 seconds is not a friend group arriving. The raid path
  // notifies the admins and flips captcha on if the group had it off.
  joinRateMax: 12,
  joinRateWindow: 30,
  joinRateAction: "notify",
  warnLimit: 3,
  strikes: [
    { at: 1, action: "mute", minutes: 60 },
    { at: 2, action: "mute", minutes: 1440 },
    { at: 3, action: "ban", minutes: 0 },
  ],
  newbieHours: 24,
  newbieBlocks: ["links"],
  // No keywords by default: a wrong default keyword deletes innocent messages
  // in a group whose language the operator never told us about.
  keywords: [],
  cas: false,
  federation: false,
  logChatId: "",
  locks: ["links"],
};

const INIT = (chatId: number) => `init:${chatId}`;

/**
 * Apply the preset the first time this chat is seen.
 *
 * Three states, in order: already initialised (KV marker), a config the group
 * wrote before the marker existed (leave it alone), and a brand-new chat
 * (write the preset). The marker is per chat and survives isolate restarts.
 */
export async function ensureChat(rt: Runtime, chatId: number): Promise<boolean> {
  const memory = rt.initialized;
  if (memory.has(chatId)) return false;

  const marked = await rt.store.get(INIT(chatId)).catch(() => "1");
  if (marked) {
    memory.add(chatId);
    return false;
  }

  const existing = await rt.store.get(`rules:${chatId}`).catch(() => null);
  if (!existing) {
    const custom = await getPreset(rt);
    const merged = { ...PRESET, ...custom };
    await rt.saveConfig(chatId, merged as Record<string, unknown>);
  }
  await rt.store.put(INIT(chatId), "1").catch(() => undefined);
  memory.add(chatId);
  return !existing;
}

export type PresetView = { preset: Partial<ChatConfig>; effective: Partial<ChatConfig> };

export async function readPreset(rt: Runtime): Promise<PresetView> {
  const custom = await getPreset(rt);
  return { preset: custom, effective: { ...PRESET, ...custom } };
}

export async function writePreset(rt: Runtime, patch: Record<string, unknown>): Promise<string> {
  return savePreset(rt, patch);
}

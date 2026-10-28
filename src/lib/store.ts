import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  applyPreset,
  defaultCommands,
  defaultConfig,
  type BotCommands,
  type BotConfig,
  type PresetId,
} from "./bot-config.ts";

const STORAGE_VERSION = 2;

/**
 * A stored config is untrusted input: it may predate a field, or a nested
 * object (commands) may be missing entirely, which used to make the generated
 * preview throw. Fill every level from the defaults instead of trusting the
 * blob, and keep the user's own values where they exist.
 */
function mergeConfig(saved: unknown): BotConfig {
  const raw = (saved ?? {}) as Partial<BotConfig>;
  return {
    ...defaultConfig,
    ...raw,
    commands: { ...defaultCommands, ...(raw.commands ?? {}) },
  };
}

type BotStore = {
  config: BotConfig;
  patch: (partial: Partial<BotConfig>) => void;
  patchCommands: (partial: Partial<BotCommands>) => void;
  applyPreset: (id: PresetId) => void;
  reset: () => void;
};

export const useBotStore = create<BotStore>()(
  persist(
    (set) => ({
      config: defaultConfig,
      patch: (partial) => set((state) => ({ config: { ...state.config, ...partial } })),
      patchCommands: (partial) =>
        set((state) => ({
          config: { ...state.config, commands: { ...state.config.commands, ...partial } },
        })),
      applyPreset: (id) => set((state) => ({ config: applyPreset(id, state.config) })),
      reset: () =>
        set((state) => ({
          config: applyPreset("gate", {
            ...defaultConfig,
            adminIds: state.config.adminIds,
            webhookSecret: state.config.webhookSecret,
            workerHost: state.config.workerHost,
          }),
        })),
    }),
    {
      name: "flareward-v1",
      version: STORAGE_VERSION,
      skipHydration: true,
      migrate: (persisted) => {
        const state = (persisted ?? {}) as { config?: BotConfig };
        return { ...state, config: mergeConfig(state.config) };
      },
      merge: (persisted, current) => {
        const state = (persisted ?? {}) as { config?: BotConfig };
        return { ...current, config: mergeConfig(state.config) };
      },
    },
  ),
);

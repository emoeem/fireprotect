import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  applyPreset,
  defaultConfig,
  type BotCommands,
  type BotConfig,
  type PresetId,
} from "./bot-config";

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
    { name: "flareward-v1", skipHydration: true },
  ),
);

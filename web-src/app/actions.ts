import type { AppState } from "./state.js";

export type AppActions = {
  getMonacoApi: () => Record<string, unknown> | null;
  setMonacoApi: (value: Record<string, unknown> | null) => void;
  getWorkspaceRootKey: () => string | null;
  setWorkspaceRootKey: (value: string | null) => void;
};

export const createAppActions = (state: AppState): AppActions => ({
  getMonacoApi: () => state.monacoApi,
  setMonacoApi: (value) => {
    state.monacoApi = value;
  },
  getWorkspaceRootKey: () => state.workspaceRootKey,
  setWorkspaceRootKey: (value) => {
    state.workspaceRootKey = value;
  },
});

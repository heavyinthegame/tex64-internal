export type AppState = {
  monacoApi: Record<string, unknown> | null;
  workspaceRootKey: string | null;
};

export const createAppState = (): AppState => ({
  monacoApi: null,
  workspaceRootKey: null,
});

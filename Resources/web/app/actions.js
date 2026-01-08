export const createAppActions = (state) => ({
    getMonacoApi: () => state.monacoApi,
    setMonacoApi: (value) => {
        state.monacoApi = value;
    },
    getWorkspaceRootKey: () => state.workspaceRootKey,
    setWorkspaceRootKey: (value) => {
        state.workspaceRootKey = value;
    },
});

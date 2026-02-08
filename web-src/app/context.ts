import type { DomRefs } from "./dom.js";
import type { BridgeWindow } from "./types.js";
import type { createViewer } from "./viewer.js";

type ViewerApi = ReturnType<typeof createViewer>;

export type AppContext = {
  dom: DomRefs;
  bridgeWindow: BridgeWindow;
  viewers: {
    primary: ViewerApi;
    secondary: ViewerApi;
  };
};

export const createAppContext = (context: AppContext): AppContext => context;

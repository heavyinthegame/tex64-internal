// Side-effect import: ensure math-wysiwyg core is bundled for Blocks math input.
import "../../math/wysiwyg/math-wysiwyg.js";

export type { BlockInputApi } from "./input-ui/types.js";

export { initBlockInputUi } from "./input-ui/init.js";


import { parseBlocks } from "../web-src/block-editor-app/adapter/blockParser";

const inputs = [
  "\\maketitle",
  "\\maketitle\n",
  "\\maketitle \n",
  "Before\n\\maketitle\nAfter",
  "\\newpage",
  "raw \\newpage textual",
  "\\clearpage"
];

inputs.forEach((input, i) => {
  console.log(`\n--- Test Case ${i + 1} ---`);
  console.log(`Input: "${input.replace(/\n/g, '\\n')}"`);
  try {
    const blocks = parseBlocks(input);
    blocks.forEach(b => {
      console.log(`  Block: [${b.type}] "${b.snippet.replace(/\n/g, '\\n')}"`);
    });
  } catch (e) {
    console.error("  Error:", e);
  }
});

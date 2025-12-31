import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import esbuild from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const resolveWithExtensions = (basePath) => {
  const extensions = [".tsx", ".ts", ".jsx", ".js", ".json"];
  for (const ext of extensions) {
    const candidate = `${basePath}${ext}`;
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
    for (const ext of extensions) {
      const candidate = path.join(basePath, `index${ext}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return basePath;
};

const aliasPlugin = {
  name: "alias",
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => ({
      path: resolveWithExtensions(
        path.join(rootDir, "web-src", "block-editor-app", args.path.slice(2)),
      ),
    }));
  },
};

await esbuild.build({
  entryPoints: [path.join(rootDir, "web-src", "block-editor-app", "index.tsx")],
  bundle: true,
  outfile: path.join(rootDir, "Resources", "web", "block-editor.js"),
  format: "iife",
  platform: "browser",
  target: ["es2019"],
  tsconfig: path.join(rootDir, "web-src", "block-editor-app", "tsconfig.json"),
  jsx: "automatic",
  jsxImportSource: "react",
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  plugins: [aliasPlugin],
});

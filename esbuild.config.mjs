import builtins from "builtin-modules";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import esbuild from "esbuild";
import process from "node:process";

const prod = process.argv[2] === "production";
const helperModuleName = "ghostterm-embedded-helper";
const helperPath = join(process.cwd(), "bin", "ghostterm-pty");

const embeddedHelperPlugin = {
  name: "ghostterm-embedded-helper",
  setup(build) {
    build.onResolve({ filter: /^ghostterm-embedded-helper$/ }, () => ({
      namespace: helperModuleName,
      path: helperModuleName
    }));
    build.onLoad({ filter: /.*/, namespace: helperModuleName }, async () => {
      const helper = await readFile(helperPath);
      const helperSha256 = createHash("sha256").update(helper).digest("hex");
      return {
        contents: [
          `export const helperBase64 = ${JSON.stringify(helper.toString("base64"))};`,
          `export const helperSha256 = ${JSON.stringify(helperSha256)};`,
          `export const helperSize = ${helper.byteLength};`
        ].join("\n"),
        loader: "js"
      };
    });
  }
};

const context = await esbuild.context({
  banner: {
    js: "/* GhostTerm Obsidian plugin */"
  },
  bundle: true,
  entryPoints: ["src/main.ts"],
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins
  ],
  format: "cjs",
  logLevel: "info",
  outfile: "dist/main.js",
  platform: "node",
  plugins: [embeddedHelperPlugin],
  sourcemap: prod ? false : "inline",
  target: "es2022",
  treeShaking: true
});

if (prod) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
  console.log("Watching GhostTerm plugin sources...");
}

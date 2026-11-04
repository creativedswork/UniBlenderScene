import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

await mkdir("dist", { recursive: true });
const bundle = await build({
  entryPoints: ["web/widget.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  write: false,
});
const source = (await readFile("web/widget.html", "utf8"))
  .replace("<!--WIDGET_SCRIPT-->", () => `<script type="module">${bundle.outputFiles[0]!.text.replace(/<\/script/gi, "<\\/script")}</script>`);
await writeFile(resolve("dist/widget.html"), source);
console.log("Built dist/widget.html");

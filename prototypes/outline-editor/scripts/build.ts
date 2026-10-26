/** 构建：把原型页面打包到 dist/（一个 main.js + index.html + style.css）。 */
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, "dist");
mkdirSync(out, { recursive: true });
const r = await Bun.build({
	entrypoints: [join(root, "src/app/main.ts")],
	outdir: out,
	target: "browser",
	sourcemap: "linked",
	minify: process.argv.includes("--minify"),
});
if (!r.success) {
	for (const l of r.logs) console.error(l);
	process.exit(1);
}
copyFileSync(join(root, "src/app/index.html"), join(out, "index.html"));
copyFileSync(join(root, "src/app/style.css"), join(out, "style.css"));
console.log(`built ${r.outputs.map((o) => o.path.replace(`${root}/`, "")).join(", ")}`);

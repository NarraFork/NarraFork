/** 构建：把原型页面打包到 dist/（一个 main.js + index.html + style.css）。 */
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const out = join(root, "dist");
mkdirSync(out, { recursive: true });
// 页面和节点测量的 Worker 分开打包（各自一个文件，放在 dist/ 根下）
const outputs: string[] = [];
for (const entry of ["src/app/main.ts", "src/mindmap/measure-worker.ts"]) {
	const r = await Bun.build({
		entrypoints: [join(root, entry)],
		outdir: out,
		target: "browser",
		sourcemap: "linked",
		minify: process.argv.includes("--minify"),
	});
	if (!r.success) {
		for (const l of r.logs) console.error(l);
		process.exit(1);
	}
	for (const o of r.outputs) outputs.push(o.path.replace(`${root}/`, ""));
}
copyFileSync(join(root, "src/app/index.html"), join(out, "index.html"));
copyFileSync(join(root, "src/app/style.css"), join(out, "style.css"));
console.log(`built ${outputs.join(", ")}`);

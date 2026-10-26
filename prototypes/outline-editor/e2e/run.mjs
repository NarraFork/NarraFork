// 运行全部浏览器验收项，结果写到 results/e2e.json，并打印摘要。
// 用法：node e2e/run.mjs [项编号...]，例如 node e2e/run.mjs 1 3
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeEnv } from "./lib.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const all = {
	0: "./t0-keys.mjs",
	1: "./t1-ime.mjs",
	3: "./t3-clipboard.mjs",
	4: "./t4-undo.mjs",
	5: "./t5-concurrency.mjs",
	6: "./t6-embed.mjs",
	7: "./t7-perf.mjs",
	8: "./t8-stitch.mjs",
};
const pick = process.argv.slice(2).filter((x) => all[x]);
const ids = pick.length ? pick : Object.keys(all);
const results = [];
for (const id of ids) {
	const mod = await import(all[id]);
	const t0 = Date.now();
	const item = await mod.run();
	item.ms = Date.now() - t0;
	results.push(item);
	const failed = item.checks.filter((c) => !c.ok);
	console.log(
		`\n[${item.id}] ${item.title}：${item.status}（${item.checks.length} 条检查，失败 ${failed.length}，${item.ms} ms）`,
	);
	for (const c of failed)
		console.log(`  ✗ ${c.name}\n    ${JSON.stringify(c.info)?.slice(0, 600)}`);
	for (const n of item.notes) console.log(`  · ${n}`);
	if (Object.keys(item.metrics).length) console.log(`  metrics: ${JSON.stringify(item.metrics)}`);
}
await closeEnv();
const dir = join(here, "..", "results");
mkdirSync(dir, { recursive: true });
writeFileSync(
	join(dir, pick.length ? `e2e-${ids.join("-")}.json` : "e2e.json"),
	JSON.stringify(
		{
			at: new Date().toISOString(),
			items: results.map((r) => ({
				id: r.id,
				title: r.title,
				status: r.status,
				ms: r.ms,
				checks: r.checks,
				metrics: r.metrics,
				notes: r.notes,
			})),
		},
		null,
		"\t",
	),
);
const bad = results.filter((r) => r.status !== "通过");
process.exitCode = bad.length ? 1 : 0;

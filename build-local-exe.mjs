/**
 * build-local-exe.mjs — 本地 Windows x64 exe 构建。
 *
 * 这是 `scripts/build-cross-platform.ts`（README「从源码运行」与 docs/BUILD.md 的正规流程）的
 * 薄封装，不再自建第二套编译命令。原因：编译入口清单只有一个权威来源——官方脚本把主入口和
 * 全部 worker 模块都列为 `bun build --compile` 的入口：
 *
 *   db-worker/worker-entry · model-history-worker · editor-document-worker ·
 *   memory-snapshot-worker · memory-profile-worker · share-preview-worker ·
 *   request-recorder-worker · revert-transaction-manifest-worker ·
 *   legacy-sync-worker · legacy-import-worker
 *
 * `new Worker(new URL(...))` 的说明符不会被打包器跟进，所以任何没被列成入口的 worker 都不在
 * 二进制里，编译版会在该功能上静默失败（历史上就漏过 model-history-worker，表现为每次发送
 * 消息都报 "Model history read-only worker failed"）。手写这份清单迟早会再次漏掉，因此这里
 * 只调用官方脚本。
 *
 * 用法：
 *   bun build-local-exe.mjs                    # 完整构建（含前端重建）
 *   SKIP_FRONTEND=1 bun build-local-exe.mjs    # 跳过前端重建（前端源码未变时更快）
 *   BUILD_SUFFIX=fix55 bun build-local-exe.mjs # 产物改名，保留上一次的 exe
 *   bun build-local-exe.mjs --skip-frontend    # 参数直接透传给官方脚本
 *
 * 发布用的签名、zstd 增量与 latest.yml 后处理不在这里做，走官方发布流程。
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { delimiter, dirname, join, relative } from "node:path";

const ROOT = import.meta.dir;
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).version ?? "0.0.0";
const PRODUCED = join(ROOT, "dist", `narrafork-${VERSION}-windows-x64.exe`);
const SUFFIX = process.env.BUILD_SUFFIX?.trim();
const passthrough = process.argv.slice(2);
const skipFrontend = process.env.SKIP_FRONTEND === "1" || passthrough.includes("--skip-frontend");

function walkDir(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) out.push(...walkDir(p));
		else out.push(p);
	}
	return out;
}

/**
 * 前端在构建期烘焙 `${version}+${commit}`，`/api/health` 回报的是同一个字符串。完整构建由官方
 * 脚本重建前端，天然匹配；跳过前端重建时 dist/frontend 可能是更早的产物，那样打包出的 UI 与
 * 自己的服务端永远对不上：每次打开都会出现“服务端已更新”横幅，且刷新消不掉。这里直接拒绝。
 */
function assertFrontendMatchesBuild() {
	const frontendDir = join(ROOT, "dist", "frontend");
	if (!existsSync(join(frontendDir, "index.html"))) {
		throw new Error("dist/frontend 缺失：先运行 `bun run build`，或去掉 SKIP_FRONTEND 重建前端。");
	}
	const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT })
		.toString()
		.trim();
	const expected = commit ? `${VERSION}+${commit}` : VERSION;
	const bakedPattern = /\d+\.\d+\.\d+\+[0-9a-f]{7,40}\b/;
	let baked;
	for (const file of walkDir(frontendDir)) {
		if (!file.endsWith(".js")) continue;
		baked = bakedPattern.exec(readFileSync(file, "utf-8"))?.[0];
		if (baked) break;
	}
	if (baked !== expected) {
		throw new Error(
			`dist/frontend 不是本次构建的产物：烘焙版本 ${baked ?? "未找到"}，本次需要 ${expected}。\n` +
				"去掉 SKIP_FRONTEND（或先运行 `bun run build`）重建前端。",
		);
	}
}

if (skipFrontend) assertFrontendMatchesBuild();

// 用当前 bun 可执行文件而不是 PATH 里的 `bun`：Windows 上 PATH 里通常只有 npm 的包装脚本
// （bun.cmd / 无扩展名 shim），原生子进程无法直接执行它（spawn ENOENT）。
//
// 同样的原因，构建前端时 Vite 的 plugin-ui-runtime 会 spawn("bun") 生成插件运行时；把当前
// bun 所在目录前置进 PATH，保证它在 Windows 上也能被原生解析到。
const args = ["scripts/build-cross-platform.ts", "--platform=windows-x64", ...passthrough];
const env = {
	...process.env,
	PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
};
const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit", env });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (!existsSync(PRODUCED)) throw new Error(`构建产物缺失：${relative(ROOT, PRODUCED)}`);

if (SUFFIX) {
	const renamed = join(ROOT, "dist", `narrafork-${VERSION}-windows-x64-${SUFFIX}.exe`);
	renameSync(PRODUCED, renamed);
	const metadata = `${PRODUCED}.metadata.json`;
	if (existsSync(metadata)) renameSync(metadata, `${renamed}.metadata.json`);
	console.log(`✓ 产物已改名：${relative(ROOT, renamed)}`);
} else {
	console.log(`✓ 构建完成：${relative(ROOT, PRODUCED)}`);
}

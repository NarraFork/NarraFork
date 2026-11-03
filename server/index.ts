import { DB_INTEGRITY_WORKER_FLAG } from "./db/integrity-protocol";
import { DB_SNAPSHOT_WORKER_FLAG } from "./db/snapshot-protocol";
import { captureManagerTokenFromEnv } from "./lib/manager-token";
import { neutralizeAmbientProxyEnv } from "./lib/net/proxy-env";
import { waitForPreviousServerShutdown } from "./lib/restart-handoff";
import { parseRevealActivation } from "./lib/reveal-protocol";
import { isCompiledRuntime } from "./lib/runtime-target";
import { WATCHER_WORKER_FLAG } from "./lib/watcher/worker-protocol";
import { shouldRunManager } from "./manager/launch-mode";
import { PLUGIN_RUNTIME_WORKER_FLAG } from "./plugin-runtime-worker";

// Must run before ANY outbound fetch. Bun's fetch honours ambient HTTP(S)_PROXY
// even when a request explicitly asks for a direct connection, so the ambient
// values are snapshotted and blanked here to make the configured proxy policy
// the single authority. See lib/net/proxy-env.ts.
neutralizeAmbientProxyEnv();
// 管理器令牌只留在本进程内存里。放在拉起任何子进程之前，终端和 Bash 就复制不到它。
captureManagerTokenFromEnv();

if (parseRevealActivation(process.argv)) {
	// `narrafork://` activation (Windows "reveal in Explorer"): a short-lived client of the running
	// server, so it never touches settings, the database or the port. See lib/reveal-protocol.ts.
	const { runRevealProtocolClient } = await import("./lib/reveal-protocol-client");
	await runRevealProtocolClient(process.argv).catch(async (error) => {
		const { logger } = await import("./lib/logger");
		logger.warn("Reveal protocol activation failed", { error: String(error) });
	});
	process.exit(0);
} else if (process.argv.includes(DB_INTEGRITY_WORKER_FLAG)) {
	// Read-only integrity probe subprocess. Must be checked before anything else: importing ./main
	// (or the watcher worker) would open the database read-write and take the instance lock.
	await import("./db/integrity-probe-worker");
} else if (process.argv.includes(DB_SNAPSHOT_WORKER_FLAG)) {
	// 导出快照构建子进程：只读源库、只写目标库，同样必须在 ./main 之前分流。
	await import("./db/snapshot-builder-worker");
} else if (process.argv.includes(WATCHER_WORKER_FLAG)) {
	await import("./lib/watcher/parcel-watcher-worker");
} else if (process.argv.includes(PLUGIN_RUNTIME_WORKER_FLAG)) {
	// Self-hosted plugin runtime: the host binary embeds the Bun runtime, so
	// local-process plugins are spawned as this same exe in plugin mode —
	// before ./main, so no instance lock / DB / HTTP server. Loads the plugin
	// entry, which owns the stdio RPC channel.
	await import("./plugin-runtime-worker").then((m) => m.runPluginRuntimeWorker());
} else if (
	shouldRunManager({
		argv: process.argv,
		platform: process.platform,
		compiled: isCompiledRuntime(),
	})
) {
	// 图形化管理器不监听端口，所以不做"上一次服务退出等待"。
	// 真正的服务由管理器以 `--serve` 子进程拉起（更新交接环境只交给第一个子进程），那一步会做该等待。
	// 管理器接不了这次交接（已有面板实例等）时返回 "serve"，本进程改走服务模式完成交接。
	const mode = await import("./manager/main").then((manager) => manager.runManager());
	if (mode === "serve") await runServer();
} else {
	// 源码启动（bun run dev / start）以及 `--serve` 子进程走服务模式。
	await runServer();
}

async function runServer(): Promise<void> {
	const handoffOk = await waitForPreviousServerShutdown();
	if (!handoffOk) {
		process.exit(1);
	}
	await import("./main");
}

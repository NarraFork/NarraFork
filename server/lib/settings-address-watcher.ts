import { type FSWatcher, readFileSync, watch } from "node:fs";
import { logger } from "./logger";
import { getNarraforkHome, getNarraforkPath } from "./narrafork-home";

/**
 * 监听 settings.json 中 server 段的监听地址变化，触发 HTTP 监听器热重绑。
 *
 * 这是管理器面板（以及任何外部编辑）修改监听配置的生效通道。PATCH /api/settings
 * 的保存路径也写同一个文件，因此触发前先用调用方提供的 isCurrent 比对
 * "文件值 vs 当前运行配置"，一致则跳过，避免同一次变更被重绑两次。
 */

const DEBOUNCE_MS = 300;

export type ListenAddress = { host: string; port: number };

export interface ServerAddressWatcherOptions {
	/** 文件里的地址是否已经是当前运行中的配置（一致则不触发重绑）。 */
	isCurrent: (address: ListenAddress) => boolean;
	/** 文件地址与基线不同且尚未生效时调用；调用方负责 reload 设置并触发重绑。 */
	onChanged: (address: ListenAddress) => void;
}

function readListenAddress(): ListenAddress | undefined {
	try {
		const raw = readFileSync(getNarraforkPath("settings.json"), "utf8");
		const parsed = JSON.parse(raw) as { server?: { host?: unknown; port?: unknown } };
		const host = typeof parsed.server?.host === "string" ? parsed.server.host : undefined;
		const port = typeof parsed.server?.port === "number" ? parsed.server.port : undefined;
		if (!host || !port || !Number.isInteger(port) || port <= 0) return undefined;
		return { host, port };
	} catch {
		// 文件缺失、半写入或暂不可读：忽略，等下一次文件事件。
		return undefined;
	}
}

/** 启动 settings.json 监听地址热重载；返回 false 表示未能启动（文件不可读）。 */
export function startServerAddressWatcher(options: ServerAddressWatcherOptions): boolean {
	const initial = readListenAddress();
	if (!initial) {
		logger.warn("settings.json 缺少有效的监听地址，地址热重载监听未启动");
		return false;
	}
	let baseline: ListenAddress = initial;
	let timer: ReturnType<typeof setTimeout> | undefined;
	// 监听目录而不是文件：saveSettings 走"写临时文件再 rename"的原子替换，
	// 单文件 watcher 在替换后会失去句柄。
	let watcher: FSWatcher | undefined;
	try {
		watcher = watch(getNarraforkHome(), (_event, filename) => {
			if (filename && filename !== "settings.json") return;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = undefined;
				const next = readListenAddress();
				if (!next) return;
				if (next.host === baseline.host && next.port === baseline.port) return;
				baseline = next;
				if (options.isCurrent(next)) {
					logger.info("settings.json 监听地址与运行配置一致，跳过热重绑", next);
					return;
				}
				logger.info("settings.json 监听地址变化，触发热重绑", next);
				options.onChanged(next);
			}, DEBOUNCE_MS);
		});
	} catch (error) {
		logger.error("settings.json 地址监听启动失败", { error: String(error) });
		return false;
	}
	// watcher 不应阻止进程退出。
	(watcher as { unref?: () => void }).unref?.();
	logger.info("settings.json 地址热重载监听已启动", baseline);
	return true;
}

/**
 * settings.json 的通用配置变化监听。
 *
 * 管理器面板与手工编辑会直接改写 settings.json，这类改动不经过 PATCH /api/settings，
 * 服务端内存里的配置不会自己更新 —— 不重载的话，面板改的实例名、主题色、打开方式要等
 * 重启服务才生效。监听地址由 startServerAddressWatcher 单独负责热重绑，这里只重载配置。
 *
 * 与地址监听同样的理由：写入是"写临时文件再 rename"的原子替换，必须监听目录而不是文件，
 * 否则 watcher 在替换后会盯住已被删除的旧句柄。
 */

import { type FSWatcher, watch } from "node:fs";
import { logger } from "./logger";
import { getNarraforkHome } from "./narrafork-home";

/** 合并连续写入（一次保存可能触发多个文件事件）。 */
const DEBOUNCE_MS = 300;

/** 开始监听；返回停止函数。目录不可用时返回 no-op。 */
export function startSettingsFileWatcher(onChange: () => void): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let watcher: FSWatcher | undefined;
	try {
		watcher = watch(getNarraforkHome(), (_event, filename) => {
			if (filename && filename !== "settings.json") return;
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = undefined;
				onChange();
			}, DEBOUNCE_MS);
		});
	} catch (error) {
		logger.warn("settings.json 配置变化监听未启动", { error: String(error) });
		return () => {};
	}
	return () => {
		if (timer) clearTimeout(timer);
		watcher?.close();
		watcher = undefined;
	};
}

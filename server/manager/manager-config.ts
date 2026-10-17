/**
 * 管理器的配置读写。
 *
 * 监听地址/端口直接读写 NarraFork 自己的 settings.json —— 前端设置页改的就是同一份配置，
 * 所以两边天然同步：面板保存后前端看得到，前端改了面板也能通过 mtime 轮询回显。
 *
 * 写入在 settings.lock 内重新读取、只改自己的字段，再写临时文件并原子改名。
 * 这样和正在运行的服务同时保存时，不会用旧快照盖掉对方刚写入的键。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { withSettingsFileLock } from "../lib/settings-file-lock";
import { resolveNarraforkHome } from "./backend-process";
import { isManagerLang, type ManagerLang } from "./manager-i18n";

export interface ServerAddress {
	host: string;
	port: number;
	tls: boolean;
}

const DEFAULT_ADDRESS: ServerAddress = { host: "127.0.0.1", port: 7779, tls: false };

function settingsPath(): string {
	return join(resolveNarraforkHome(), "settings.json");
}

/** 读取监听地址；文件缺失或不可解析时回落到默认值。 */
export function readServerAddress(): ServerAddress {
	try {
		const raw = JSON.parse(readFileSync(settingsPath(), "utf8")) as {
			server?: { host?: string; port?: number; tls?: { enabled?: boolean } };
		};
		return {
			host:
				typeof raw.server?.host === "string" && raw.server.host
					? raw.server.host
					: DEFAULT_ADDRESS.host,
			port: typeof raw.server?.port === "number" ? raw.server.port : DEFAULT_ADDRESS.port,
			tls: raw.server?.tls?.enabled === true,
		};
	} catch {
		return { ...DEFAULT_ADDRESS };
	}
}

/** 只覆盖 server.host / server.port，其余字段原样保留。返回是否写入成功。 */
export function writeServerAddress(address: Pick<ServerAddress, "host" | "port">): boolean {
	try {
		withSettingsFileLock(resolveNarraforkHome(), () => {
			const path = settingsPath();
			const raw = existsSync(path)
				? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
				: {};
			const server = (
				typeof raw.server === "object" && raw.server !== null ? raw.server : {}
			) as Record<string, unknown>;
			raw.server = { ...server, host: address.host, port: address.port };
			const temporary = `${path}.manager.tmp`;
			writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
			renameSync(temporary, path);
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * 面板关注的那部分 NarraFork 配置。
 *
 * 与监听地址走同一份 settings.json：写入时读整份、只改这几个字段、再原子写回，
 * 因此前端设置页与面板永远看到同一份值。
 */
export interface NarraForkSettings {
	openBrowser: "off" | "browser" | "app";
	/** 实例显示名；空表示使用默认名 NarraFork。 */
	brandName: string;
	/** 图标与强调色（#rrggbb）；空表示使用默认 indigo。 */
	brandColor: string;
}

/** 与 server/lib/settings/defaults.ts 的默认值保持一致。 */
const DEFAULT_NARRAFORK_SETTINGS: NarraForkSettings = {
	openBrowser: "browser",
	brandName: "",
	brandColor: "",
};

export function readNarraForkSettings(): NarraForkSettings {
	try {
		const raw = JSON.parse(readFileSync(settingsPath(), "utf8")) as {
			server?: { openBrowser?: unknown };
			branding?: { name?: unknown; iconColor?: unknown };
		};
		const mode = raw.server?.openBrowser;
		return {
			openBrowser:
				mode === "off" || mode === "app" || mode === "browser"
					? mode
					: DEFAULT_NARRAFORK_SETTINGS.openBrowser,
			brandName: typeof raw.branding?.name === "string" ? raw.branding.name : "",
			brandColor: typeof raw.branding?.iconColor === "string" ? raw.branding.iconColor : "",
		};
	} catch {
		return { ...DEFAULT_NARRAFORK_SETTINGS };
	}
}

/** 只覆盖传入的字段，其余配置（含面板不认识的键）原样保留；空串表示删除该键回到默认。 */
export function writeNarraForkSettings(patch: Partial<NarraForkSettings>): boolean {
	try {
		withSettingsFileLock(resolveNarraforkHome(), () => {
			const path = settingsPath();
			const raw = existsSync(path)
				? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
				: {};
			if (patch.openBrowser !== undefined) {
				const server = (
					typeof raw.server === "object" && raw.server !== null ? raw.server : {}
				) as Record<string, unknown>;
				raw.server = { ...server, openBrowser: patch.openBrowser };
			}
			if (patch.brandName !== undefined || patch.brandColor !== undefined) {
				const branding = (
					typeof raw.branding === "object" && raw.branding !== null ? raw.branding : {}
				) as Record<string, unknown>;
				if (patch.brandName !== undefined) {
					if (patch.brandName) branding.name = patch.brandName;
					else delete branding.name;
				}
				if (patch.brandColor !== undefined) {
					if (patch.brandColor) branding.iconColor = patch.brandColor;
					else delete branding.iconColor;
				}
				raw.branding = branding;
			}
			const temporary = `${path}.manager.tmp`;
			writeFileSync(temporary, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
			renameSync(temporary, path);
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * 管理器自己的偏好（与 NarraFork 的 settings 分开存，避免污染它的 schema 与迁移）。
 * 关闭行为、界面语言、启动方式 + 上次的窗口尺寸（下次启动恢复，首次用最小尺寸）。
 */
export interface ManagerPreferences {
	askOnClose: boolean;
	closeAction: "exit" | "minimize";
	/** 面板界面语言；存在管理器自己的配置里，不写入 NarraFork。 */
	language: ManagerLang;
	/** 启动管理端时不显示窗口，只留托盘图标。 */
	startMinimized: boolean;
	/** 管理端启动后自动启动项目（后端服务）。 */
	autoStartBackend: boolean;
	/** 最近一次窗口客户区尺寸；未设置时用最小窗口尺寸启动。 */
	windowWidth?: number;
	windowHeight?: number;
}

const DEFAULT_PREFERENCES: ManagerPreferences = {
	askOnClose: true,
	closeAction: "exit",
	language: "zh-CN",
	startMinimized: false,
	autoStartBackend: false,
};

function preferencesPath(): string {
	return join(resolveNarraforkHome(), "manager.json");
}

export function readPreferences(): ManagerPreferences {
	try {
		const raw = JSON.parse(readFileSync(preferencesPath(), "utf8")) as Partial<ManagerPreferences>;
		const preferences: ManagerPreferences = {
			askOnClose:
				typeof raw.askOnClose === "boolean" ? raw.askOnClose : DEFAULT_PREFERENCES.askOnClose,
			closeAction: raw.closeAction === "minimize" ? "minimize" : "exit",
			language: isManagerLang(raw.language) ? raw.language : DEFAULT_PREFERENCES.language,
			startMinimized:
				typeof raw.startMinimized === "boolean"
					? raw.startMinimized
					: DEFAULT_PREFERENCES.startMinimized,
			autoStartBackend:
				typeof raw.autoStartBackend === "boolean"
					? raw.autoStartBackend
					: DEFAULT_PREFERENCES.autoStartBackend,
		};
		if (typeof raw.windowWidth === "number" && raw.windowWidth > 0) {
			preferences.windowWidth = Math.floor(raw.windowWidth);
		}
		if (typeof raw.windowHeight === "number" && raw.windowHeight > 0) {
			preferences.windowHeight = Math.floor(raw.windowHeight);
		}
		return preferences;
	} catch {
		return { ...DEFAULT_PREFERENCES };
	}
}

export function writePreferences(preferences: ManagerPreferences): boolean {
	try {
		const path = preferencesPath();
		mkdirSync(dirname(path), { recursive: true });
		const temporary = `${path}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(preferences, null, 2)}\n`, "utf8");
		renameSync(temporary, path);
		return true;
	} catch {
		return false;
	}
}

/** settings.json 的最近修改时间（毫秒）；文件不存在时返回 0。 */
export function settingsMtime(): number {
	try {
		return statSync(settingsPath()).mtimeMs;
	} catch {
		return 0;
	}
}

/**
 * 轮询 settings.json 的 mtime，变化时回调；返回停止函数。
 *
 * 用 mtime 而不是内容比较：配置文件可能有几十 KB，每几秒全量读一次没有必要。
 */
export function watchSettings(onChange: () => void, intervalMs = 3000): () => void {
	let last = settingsMtime();
	const timer = setInterval(() => {
		const current = settingsMtime();
		if (current !== last) {
			last = current;
			onChange();
		}
	}, intervalMs);
	return () => clearInterval(timer);
}

/**
 * The startup failures a person can fix, each with what to do about it.
 *
 * Messages are shown to every browser that opens the status page, so pids and paths go into
 * `command` or `detail`, which only a browser on the server itself receives. Commands are for the
 * platform NarraFork runs on (PowerShell on Windows, sh elsewhere) and must work pasted as is.
 */

import { NETSH_EXCLUDED_PORT_COMMAND } from "../windows-excluded-ports";
import { StartupError } from "./startup-error";

const IS_WINDOWS = process.platform === "win32";

/** Quote a path for the shell the command is meant for. */
export function quotePath(path: string, windows = IS_WINDOWS): string {
	return windows ? `'${path.replaceAll("'", "''")}'` : `'${path.replaceAll("'", `'\\''`)}'`;
}

/** Another NarraFork process holds the data directory's instance lock. */
export class InstanceLockedError extends StartupError {
	constructor(
		readonly pid: number,
		/** Names the pid, lock file and holder. The Windows manager parses it from stderr. */
		detail: string,
	) {
		super({
			message: {
				en: "Another NarraFork is already using this data directory. Stop it, then start again.",
				zh: "另一个 NarraFork 正在使用这个数据目录。先停止它，再重新启动。",
			},
			command: IS_WINDOWS ? `Stop-Process -Id ${pid}` : `kill ${pid}`,
			detail,
		});
		this.name = "InstanceLockedError";
	}
}

export function settingsUnreadable(path: string, reason: string): StartupError {
	return new StartupError({
		message: {
			en: `settings.json is not valid JSON (${reason}). Fix the file, then start again.`,
			zh: `settings.json 不是有效的 JSON（${reason}）。修正这个文件后再启动。`,
		},
		command: IS_WINDOWS ? `notepad ${quotePath(path)}` : `"\${EDITOR:-nano}" ${quotePath(path)}`,
	});
}

export function databaseUpgradeFailed(error: unknown): StartupError {
	return new StartupError({
		message: {
			en: "Upgrading the database failed, so NarraFork did not start. The details below say why.",
			zh: "数据库升级失败，NarraFork 没有启动。原因见下方详细信息。",
		},
		detail: error instanceof Error ? (error.stack ?? error.message) : String(error),
	});
}

/** The port was given explicitly (`--port`, `PORT`), so NarraFork does not move to another one. */
export function portUnavailable(port: number, reservedRange?: string): StartupError {
	if (reservedRange) {
		return new StartupError({
			message: {
				en: `Port ${port} is reserved by Windows (range ${reservedRange}); no program is using it. Start with --port=<port> outside the reserved ranges.`,
				zh: `端口 ${port} 被 Windows 保留（范围 ${reservedRange}），没有程序占用它。用 --port=<端口> 换一个保留范围之外的端口启动。`,
			},
			command: NETSH_EXCLUDED_PORT_COMMAND,
		});
	}
	return new StartupError({
		message: {
			en: `Port ${port} is already in use. Stop the program using it, or start with --port=<port>.`,
			zh: `端口 ${port} 已被占用。停止占用它的程序，或用 --port=<端口> 换一个端口启动。`,
		},
		command: IS_WINDOWS
			? `Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object OwningProcess`
			: `lsof -nP -iTCP:${port} -sTCP:LISTEN`,
	});
}

/** An update's replacement process could not confirm the previous server had shut down. */
export function handoffFailed(): StartupError {
	return new StartupError({
		message: {
			en: "The updated NarraFork could not take over from the previous one, so it did not start. Start NarraFork again.",
			zh: "更新后的 NarraFork 没能从上一个实例接管，因此没有启动。请重新启动 NarraFork。",
		},
	});
}

export function noPortAvailable(attempted: string, reservedRanges?: string): StartupError {
	return new StartupError({
		message: {
			en: `No free port was found (tried ${attempted}). Start with --port=<port>.`,
			zh: `找不到可用端口（试过 ${attempted}）。用 --port=<端口> 指定一个端口启动。`,
		},
		...(reservedRanges && {
			command: NETSH_EXCLUDED_PORT_COMMAND,
			detail: `Windows reserved TCP ranges: ${reservedRanges}`,
		}),
	});
}

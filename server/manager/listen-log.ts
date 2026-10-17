export type ServiceLogEvent =
	| { kind: "address"; protocol: "http" | "https"; host: string; port: number }
	| { kind: "lock"; pid: number };

const ADDRESS_LINE = /running on (https?):\/\/(\[[^\]]+\]|[^:/\s]+):(\d+)/;
const LOCK_LINE = /Another NarraFork process \(pid (\d+)\) is already using/;

/**
 * 从服务 stdout/stderr 的一行里取出监听地址或实例锁冲突。
 *
 * 启动和热重绑都打同一句 `running on http(s)://host:port`（可能嵌在 JSON 日志里）。
 * 只认这一句，避免把别的端口数字误当成监听地址。
 */
export function parseServiceLogLine(line: string): ServiceLogEvent | undefined {
	const conflict = line.match(LOCK_LINE);
	if (conflict) {
		const pid = Number.parseInt(conflict[1] ?? "", 10);
		if (Number.isFinite(pid) && pid > 0) return { kind: "lock", pid };
	}
	const match = line.match(ADDRESS_LINE);
	if (!match) return undefined;
	const port = Number.parseInt(match[3] ?? "", 10);
	if (!Number.isFinite(port) || port <= 0) return undefined;
	return {
		kind: "address",
		protocol: match[1] === "https" ? "https" : "http",
		host: match[2] ?? "",
		port,
	};
}

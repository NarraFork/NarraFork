import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

type LogLevel = "debug" | "info" | "warn" | "error";

const narraforkDir = resolve(homedir(), ".narrafork");
mkdirSync(narraforkDir, { recursive: true });
const logPath = resolve(narraforkDir, "server.log");

const consoleMethods: Record<LogLevel, (msg: string) => void> = {
	debug: (msg) => console.debug(msg),
	info: (msg) => console.info(msg),
	warn: (msg) => console.warn(msg),
	error: (msg) => console.error(msg),
};

function pad(value: number, length = 2): string {
	return String(value).padStart(length, "0");
}

function formatLocalTimestamp(date = new Date()): string {
	const offsetMinutes = -date.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const absOffsetMinutes = Math.abs(offsetMinutes);
	const offsetHours = Math.floor(absOffsetMinutes / 60);
	const offsetRemainderMinutes = absOffsetMinutes % 60;

	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
		date.getHours(),
	)}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(offsetHours)}:${pad(offsetRemainderMinutes)}`;
}

function log(level: LogLevel, message: string, data?: Record<string, unknown>) {
	const entry = JSON.stringify({ ts: formatLocalTimestamp(), level, msg: message, ...data });
	consoleMethods[level](entry);
	try {
		appendFileSync(logPath, `${entry}\n`);
	} catch {
		// Silently ignore file write failures to avoid cascading errors
	}
}

export const logger = {
	debug: (msg: string, data?: Record<string, unknown>) => log("debug", msg, data),
	info: (msg: string, data?: Record<string, unknown>) => log("info", msg, data),
	warn: (msg: string, data?: Record<string, unknown>) => log("warn", msg, data),
	error: (msg: string, data?: Record<string, unknown>) => log("error", msg, data),
};

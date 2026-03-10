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

function log(level: LogLevel, message: string, data?: Record<string, unknown>) {
	const entry = JSON.stringify({ ts: new Date().toISOString(), level, msg: message, ...data });
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

/**
 * Simple logger for the update server.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

let minLevel: LogLevel = "info";

function formatTime(): string {
	return new Date().toISOString();
}

function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
	if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

	const prefix = `[${formatTime()}] [${level.toUpperCase()}]`;
	const suffix = data ? ` ${JSON.stringify(data)}` : "";

	switch (level) {
		case "error":
			console.error(`${prefix} ${message}${suffix}`);
			break;
		case "warn":
			console.warn(`${prefix} ${message}${suffix}`);
			break;
		default:
			console.log(`${prefix} ${message}${suffix}`);
	}
}

export const logger = {
	debug: (msg: string, data?: Record<string, unknown>) => log("debug", msg, data),
	info: (msg: string, data?: Record<string, unknown>) => log("info", msg, data),
	warn: (msg: string, data?: Record<string, unknown>) => log("warn", msg, data),
	error: (msg: string, data?: Record<string, unknown>) => log("error", msg, data),
	setLevel: (level: LogLevel) => {
		minLevel = level;
	},
};

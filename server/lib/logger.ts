import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { getNarraforkHome } from "./narrafork-home";

type LogLevel = "debug" | "info" | "warn" | "error";

const narraforkDir = getNarraforkHome();
mkdirSync(narraforkDir, { recursive: true, mode: 0o700 });
const logPath = resolve(narraforkDir, "server.log");

const LEVEL_PRIORITY: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

const consoleMethods: Record<LogLevel, (msg: string) => void> = {
	debug: (msg) => console.debug(msg),
	info: (msg) => console.info(msg),
	warn: (msg) => console.warn(msg),
	error: (msg) => console.error(msg),
};

const DEFAULT_LOG_LEVEL: LogLevel = "info";
const DEFAULT_MAX_LOG_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_LOG_FILES = 5;

let currentLogBytes = readCurrentLogSize();

function parseLogLevel(value: string | undefined): LogLevel {
	if (value === "debug" || value === "info" || value === "warn" || value === "error") {
		return value;
	}
	return DEFAULT_LOG_LEVEL;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readCurrentLogSize(): number {
	try {
		return statSync(logPath).size;
	} catch {
		return 0;
	}
}

const configuredLevel = parseLogLevel(process.env.NARRAFORK_LOG_LEVEL);
const maxLogBytes = parsePositiveInt(process.env.NARRAFORK_LOG_MAX_BYTES, DEFAULT_MAX_LOG_BYTES);
const maxLogFiles = parseNonNegativeInt(process.env.NARRAFORK_LOG_MAX_FILES, DEFAULT_MAX_LOG_FILES);

function shouldLog(level: LogLevel): boolean {
	return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[configuredLevel];
}

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

function rotateLogsIfNeeded(nextBytes: number): void {
	if (maxLogBytes <= 0 || currentLogBytes + nextBytes <= maxLogBytes) return;
	try {
		if (maxLogFiles <= 0) {
			if (existsSync(logPath)) unlinkSync(logPath);
			currentLogBytes = 0;
			return;
		}

		const oldest = `${logPath}.${maxLogFiles}`;
		if (existsSync(oldest)) unlinkSync(oldest);

		for (let i = maxLogFiles - 1; i >= 1; i--) {
			const from = `${logPath}.${i}`;
			const to = `${logPath}.${i + 1}`;
			if (existsSync(from)) renameSync(from, to);
		}

		if (existsSync(logPath)) renameSync(logPath, `${logPath}.1`);
		currentLogBytes = 0;
	} catch {
		// If rotation fails, refresh the size so we don't repeatedly retry on a stale value.
		currentLogBytes = readCurrentLogSize();
	}
}

function log(level: LogLevel, message: string, data?: Record<string, unknown>) {
	if (!shouldLog(level)) return;

	const entry = JSON.stringify({ ts: formatLocalTimestamp(), level, msg: message, ...data });
	consoleMethods[level](entry);
	try {
		const line = `${entry}\n`;
		const bytes = Buffer.byteLength(line, "utf-8");
		rotateLogsIfNeeded(bytes);
		appendFileSync(logPath, line);
		currentLogBytes += bytes;
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

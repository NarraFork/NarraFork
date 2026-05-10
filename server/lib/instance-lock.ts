import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "./logger";

const ALLOW_MULTIPLE_ENV = "NARRAFORK_ALLOW_MULTIPLE";
const LOCK_STATE_KEY = Symbol.for("narrafork.instanceLock");
const WINDOWS_PID_CHECK_TIMEOUT_MS = 1500;
const WINDOWS_PID_CHECK_MAX_BUFFER = 64 * 1024;

interface InstanceLockPayload {
	pid: number;
	token: string;
	dbPath: string;
	startedAt: string;
	argv: string[];
}

interface InstanceLockState {
	path: string | null;
	token: string | null;
	acquired: boolean;
}

function lockState(): InstanceLockState {
	// biome-ignore lint/suspicious/noExplicitAny: global symbol storage survives hot reload
	const g = globalThis as any;
	if (!g[LOCK_STATE_KEY]) {
		g[LOCK_STATE_KEY] = { path: null, token: null, acquired: false } satisfies InstanceLockState;
	}
	return g[LOCK_STATE_KEY] as InstanceLockState;
}

function readLockPayload(path: string): InstanceLockPayload | null {
	try {
		const raw = readFileSync(path, "utf8").trim();
		if (!raw) return null;
		const payload = JSON.parse(raw) as Partial<InstanceLockPayload>;
		if (typeof payload.pid !== "number" || typeof payload.token !== "string") return null;
		return {
			pid: payload.pid,
			token: payload.token,
			dbPath: String(payload.dbPath ?? ""),
			startedAt: String(payload.startedAt ?? ""),
			argv: Array.isArray(payload.argv) ? payload.argv.map(String) : [],
		};
	} catch {
		return null;
	}
}

function parseCsvLine(line: string): string[] {
	const fields: string[] = [];
	let current = "";
	let inQuotes = false;

	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === '"') {
			if (inQuotes && line[i + 1] === '"') {
				current += '"';
				i++;
			} else {
				inQuotes = !inQuotes;
			}
		} else if (char === "," && !inQuotes) {
			fields.push(current);
			current = "";
		} else {
			current += char;
		}
	}
	fields.push(current);

	return fields.map((field) => field.trim().replace(/^\uFEFF/, ""));
}

function isPidAliveByWindowsTasklist(pid: number): boolean | null {
	const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
		encoding: "utf8",
		maxBuffer: WINDOWS_PID_CHECK_MAX_BUFFER,
		timeout: WINDOWS_PID_CHECK_TIMEOUT_MS,
		windowsHide: true,
	});

	if (result.error || result.status === null) {
		logger.warn("Failed to check Windows process liveness with tasklist", {
			pid,
			error: result.error ? String(result.error) : null,
			status: result.status,
			signal: result.signal,
		});
		return null;
	}

	if (result.status !== 0) {
		logger.warn("tasklist returned a non-zero status while checking process liveness", {
			pid,
			status: result.status,
			stderr: String(result.stderr ?? "").slice(0, 200),
		});
		return null;
	}

	for (const line of String(result.stdout ?? "").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const fields = parseCsvLine(trimmed);
		if (fields[1] === String(pid)) return true;
	}

	return false;
}

function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;

	if (process.platform === "win32") {
		const tasklistResult = isPidAliveByWindowsTasklist(pid);
		if (tasklistResult !== null) return tasklistResult;
	}

	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "ESRCH") return false;
		return true;
	}
}

function writeLockFile(path: string, payload: InstanceLockPayload): void {
	const fd = openSync(path, "wx");
	try {
		writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	} finally {
		closeSync(fd);
	}
}

export function getInstanceLockPath(dbPath: string): string {
	return join(dirname(dbPath), "narrafork.lock");
}

export function acquireInstanceLock(dbPath: string): void {
	if (process.env[ALLOW_MULTIPLE_ENV] === "1") {
		logger.warn("NarraFork instance lock bypassed by environment override", {
			env: ALLOW_MULTIPLE_ENV,
			dbPath,
		});
		return;
	}

	const path = getInstanceLockPath(dbPath);
	const state = lockState();
	if (state.acquired && state.path === path) return;

	mkdirSync(dirname(path), { recursive: true });
	const token = randomUUID();
	const payload: InstanceLockPayload = {
		pid: process.pid,
		token,
		dbPath,
		startedAt: new Date().toISOString(),
		argv: process.argv.slice(0, 8),
	};

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeLockFile(path, payload);
			state.path = path;
			state.token = token;
			state.acquired = true;
			logger.info("NarraFork instance lock acquired", { path, pid: process.pid, dbPath });
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code !== "EEXIST") throw err;
		}

		const existing = existsSync(path) ? readLockPayload(path) : null;
		if (existing?.pid === process.pid) {
			state.path = path;
			state.token = existing.token;
			state.acquired = true;
			logger.info("Reusing NarraFork instance lock for current process", {
				path,
				pid: process.pid,
			});
			return;
		}

		if (existing && isPidAlive(existing.pid)) {
			const message =
				`Another NarraFork process (pid ${existing.pid}) is already using ${dbPath}. ` +
				`Stop that process first, or set ${ALLOW_MULTIPLE_ENV}=1 only for advanced debugging.`;
			logger.error("NarraFork instance lock is held by a live process", {
				path,
				dbPath,
				ownerPid: existing.pid,
				ownerStartedAt: existing.startedAt,
				ownerArgv: existing.argv,
			});
			throw new Error(message);
		}

		try {
			unlinkSync(path);
			logger.warn("Removed stale NarraFork instance lock", {
				path,
				dbPath,
				ownerPid: existing?.pid ?? null,
			});
		} catch (unlinkErr) {
			if ((unlinkErr as NodeJS.ErrnoException)?.code !== "ENOENT") throw unlinkErr;
		}
	}

	throw new Error(`Failed to acquire NarraFork instance lock at ${path}`);
}

export function releaseInstanceLock(): void {
	const state = lockState();
	if (!state.acquired || !state.path || !state.token) return;

	try {
		const existing = existsSync(state.path) ? readLockPayload(state.path) : null;
		if (existing?.pid === process.pid && existing.token === state.token) {
			unlinkSync(state.path);
			logger.info("NarraFork instance lock released", { path: state.path, pid: process.pid });
		}
	} catch (err) {
		logger.warn("Failed to release NarraFork instance lock", {
			path: state.path,
			error: String(err),
		});
	} finally {
		state.path = null;
		state.token = null;
		state.acquired = false;
	}
}

// Register synchronously: exit handlers cannot await cleanup.
// biome-ignore lint/suspicious/noExplicitAny: global symbol storage survives hot reload
const g = globalThis as any;
const EXIT_HANDLER_KEY = Symbol.for("narrafork.instanceLock.exitHandler");
if (!g[EXIT_HANDLER_KEY]) {
	g[EXIT_HANDLER_KEY] = true;
	process.on("exit", () => releaseInstanceLock());
}

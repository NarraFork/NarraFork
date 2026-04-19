import { spawn } from "node:child_process";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db";
import { hooks } from "../db/schema";
import { eventBus } from "../lib/event-bus";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";

// === Types ===

export type HookEvent = "PreToolUse" | "PostToolUse";

export interface HookInput {
	hook_event_name: HookEvent;
	narrator_id?: string;
	chapter_id?: string;
	project_id?: string;
	cwd?: string;
	tool_name?: string;
	tool_input?: Record<string, unknown>;
	tool_use_id?: string;
	// PostToolUse extras
	tool_output?: string;
	tool_is_error?: boolean;
}

export interface HookResult {
	outcome: "success" | "blocked" | "error";
	/** Blocking reason (exit code 2 for command, decision=block for http) */
	reason?: string;
	/** Stdout / response body for informational hooks */
	output?: string;
}

// === CRUD ===

export const hookService = {
	async list(projectId?: string | null) {
		if (projectId) {
			return db
				.select()
				.from(hooks)
				.where(eq(hooks.projectId, projectId))
				.orderBy(hooks.sortOrder, hooks.createdAt);
		}
		// Global hooks (projectId IS NULL)
		return db
			.select()
			.from(hooks)
			.where(isNull(hooks.projectId))
			.orderBy(hooks.sortOrder, hooks.createdAt);
	},

	async listAll() {
		return db.select().from(hooks).orderBy(hooks.sortOrder, hooks.createdAt);
	},

	async get(id: string) {
		const [row] = await db.select().from(hooks).where(eq(hooks.id, id));
		return row ?? null;
	},

	async create(data: {
		projectId?: string;
		event: HookEvent;
		matcher?: string;
		type: "command" | "http";
		command?: string;
		url?: string;
		headers?: Record<string, string>;
		timeout?: number;
		enabled?: boolean;
		sortOrder?: number;
	}) {
		const now = new Date().toISOString();
		const id = generateId();
		await db.insert(hooks).values({
			id,
			projectId: data.projectId ?? null,
			event: data.event,
			matcher: data.matcher ?? "",
			type: data.type,
			command: data.command ?? null,
			url: data.url ?? null,
			headers: data.headers ?? null,
			prompt: null,
			model: null,
			timeout: data.timeout ?? 30,
			enabled: data.enabled ?? true,
			sortOrder: data.sortOrder ?? 0,
			createdAt: now,
			updatedAt: now,
		});
		return this.get(id);
	},

	async update(
		id: string,
		data: Partial<{
			event: HookEvent;
			matcher: string;
			type: "command" | "http";
			command: string | null;
			url: string | null;
			headers: Record<string, string> | null;
			timeout: number;
			enabled: boolean;
			sortOrder: number;
		}>,
	) {
		const now = new Date().toISOString();
		await db
			.update(hooks)
			.set({ ...data, updatedAt: now })
			.where(eq(hooks.id, id));
		return this.get(id);
	},

	async delete(id: string) {
		await db.delete(hooks).where(eq(hooks.id, id));
	},

	// === Execution ===

	/**
	 * Get all enabled hooks matching an event + optional project scope.
	 * Returns global hooks + project-specific hooks, sorted by sortOrder.
	 */
	async getMatchingHooks(event: HookEvent, projectId?: string, toolName?: string) {
		const conditions = [eq(hooks.event, event), eq(hooks.enabled, true)];

		// Get global + project hooks
		const allHooks = await db
			.select()
			.from(hooks)
			.where(and(...conditions))
			.orderBy(hooks.sortOrder, hooks.createdAt);

		return allHooks.filter((h) => {
			// Scope: global (null projectId) or matching project
			if (h.projectId && h.projectId !== projectId) return false;
			// Matcher: empty matches all, otherwise must match tool name
			if (h.matcher && h.matcher !== toolName) return false;
			return true;
		});
	},

	/**
	 * Execute a single hook and return the result.
	 */
	async executeHook(hook: typeof hooks.$inferSelect, input: HookInput): Promise<HookResult> {
		const start = Date.now();
		let result: HookResult;

		try {
			switch (hook.type) {
				case "command":
					result = await executeCommandHook(hook.command ?? "", input, hook.timeout);
					break;
				case "http":
					result = await executeHttpHook(hook.url ?? "", input, hook.headers, hook.timeout);
					break;
				default:
					result = { outcome: "error", reason: `Unknown hook type: ${hook.type}` };
			}
		} catch (err) {
			result = {
				outcome: "error",
				reason: err instanceof Error ? err.message : String(err),
			};
		}

		const durationMs = Date.now() - start;

		eventBus.emit({
			type: "hook:executed",
			hookId: hook.id,
			event: hook.event,
			hookType: hook.type,
			outcome: result.outcome,
			narratorId: input.narrator_id,
			durationMs,
		});

		logger.debug("Hook executed", {
			hookId: hook.id,
			event: hook.event,
			type: hook.type,
			outcome: result.outcome,
			durationMs,
		});

		return result;
	},

	/**
	 * Run all matching hooks for an event. For PreToolUse (blocking),
	 * returns the first blocking result. For PostToolUse (non-blocking),
	 * runs all hooks and returns success.
	 *
	 * Return value semantics:
	 * - `{ outcome: "success" }` — all hooks passed (or no hooks matched)
	 * - `{ outcome: "blocked", reason }` — a PreToolUse hook explicitly blocked the tool call
	 * - `{ outcome: "error", reason }` — at least one hook errored; the flow is NOT blocked
	 *   (fail-open). Callers should only act on "blocked" to deny tool execution.
	 */
	async runHooks(
		event: HookEvent,
		input: HookInput,
		projectId?: string,
		toolName?: string,
	): Promise<HookResult> {
		const matchingHooks = await this.getMatchingHooks(event, projectId, toolName);
		if (matchingHooks.length === 0) return { outcome: "success" };

		const isBlocking = event === "PreToolUse";
		let lastError: HookResult | undefined;

		for (const hook of matchingHooks) {
			const result = await this.executeHook(hook, input);
			if (isBlocking && result.outcome === "blocked") {
				return result;
			}
			if (result.outcome === "error") {
				lastError = result;
				logger.warn("Hook execution error (non-blocking)", {
					hookId: hook.id,
					event: hook.event,
					type: hook.type,
					reason: result.reason,
				});
			}
		}

		// Surface the last error so callers can distinguish "all ok" from
		// "completed with errors" — even though the overall flow is not blocked.
		return lastError ?? { outcome: "success" };
	},
};

// === Command hook executor ===

function executeCommandHook(
	command: string,
	input: HookInput,
	timeout: number,
): Promise<HookResult> {
	return new Promise((resolve) => {
		const proc = spawn("bash", ["-c", command], {
			stdio: ["pipe", "pipe", "pipe"],
			timeout: timeout * 1000,
			cwd: input.cwd || undefined,
		});

		// Cap captured output to avoid unbounded memory growth from chatty commands
		const MAX_CAPTURE = 64 * 1024;
		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (data: Buffer) => {
			if (stdout.length < MAX_CAPTURE) stdout += data.toString();
		});
		proc.stderr.on("data", (data: Buffer) => {
			if (stderr.length < MAX_CAPTURE) stderr += data.toString();
		});

		// Send input JSON via stdin (ignore EPIPE if process exits before write completes)
		proc.stdin.on("error", () => {});
		proc.stdin.write(JSON.stringify(input));
		proc.stdin.end();

		proc.on("close", (code) => {
			if (code === 0) {
				resolve({ outcome: "success", output: stdout.trim() });
			} else if (code === 2) {
				resolve({ outcome: "blocked", reason: stderr.trim() || stdout.trim() });
			} else {
				resolve({
					outcome: "error",
					reason: stderr.trim() || `Exit code ${code}`,
				});
			}
		});

		proc.on("error", (err) => {
			resolve({ outcome: "error", reason: err.message });
		});
	});
}

// === HTTP hook executor ===

async function executeHttpHook(
	url: string,
	input: HookInput,
	headers?: Record<string, string> | null,
	timeout?: number,
): Promise<HookResult> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), (timeout ?? 30) * 1000);

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...headers,
			},
			body: JSON.stringify(input),
			signal: controller.signal,
		});

		clearTimeout(timer);

		const text = await response.text();
		let body: Record<string, unknown> = {};
		try {
			body = JSON.parse(text);
		} catch {
			// Non-JSON response
		}

		if (!response.ok) {
			return {
				outcome: "error",
				reason: `HTTP ${response.status}: ${text.slice(0, 500)}`,
			};
		}

		if (body.decision === "block") {
			return {
				outcome: "blocked",
				reason: typeof body.reason === "string" ? body.reason : "Blocked by webhook",
			};
		}

		return { outcome: "success", output: text.slice(0, 2000) };
	} catch (err) {
		clearTimeout(timer);
		return {
			outcome: "error",
			reason: err instanceof Error ? err.message : String(err),
		};
	}
}

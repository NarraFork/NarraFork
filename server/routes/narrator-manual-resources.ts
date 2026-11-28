import { type Context, Hono } from "hono";
import { createSession } from "../lib/browser/session";
import { AppError, ValidationError } from "../lib/errors";
import { requireNarratorAccess } from "../lib/narrator-access";
import {
	MANUAL_RESOURCE_BODY_LIMIT,
	manualBackgroundTaskSchema,
	manualBrowserSessionSchema,
} from "../lib/validators/manual-narrator-resources";
import { createManualBackgroundTask } from "../services/manual-background-task";
import { tryAcquireFinalUpdateExecution } from "../services/update-coordinator";

export const narratorManualResourceRoutes = new Hono();

/** Bound bytes even when Content-Length is missing or dishonest. */
async function readManualResourceRequest(c: Context): Promise<unknown> {
	const reader = c.req.raw.body?.getReader();
	if (!reader) throw new ValidationError("A JSON request body is required");
	const bytes = new Uint8Array(MANUAL_RESOURCE_BODY_LIMIT);
	let size = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			if (chunk.value.byteLength > bytes.length - size) {
				void reader.cancel().catch(() => {});
				throw new AppError("The creation request is too large", 413, "REQUEST_TOO_LARGE");
			}
			bytes.set(chunk.value, size);
			size += chunk.value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
	} catch {
		throw new ValidationError("The request body must be valid JSON");
	}
}

narratorManualResourceRoutes.post("/:id/background-tasks", async (c) => {
	const narratorId = c.req.param("id");
	await requireNarratorAccess(c, narratorId, "write");
	const parsed = manualBackgroundTaskSchema.safeParse(await readManualResourceRequest(c));
	if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid task");
	const userId = c.get("user").sub;
	const signal = c.req.raw.signal;
	signal.throwIfAborted();
	const task = await createManualBackgroundTask({
		...parsed.data,
		narratorId,
		userId,
		signal,
		authorizeDispatch: async () => {
			await requireNarratorAccess(c, narratorId, "write");
			signal.throwIfAborted();
		},
	});
	return c.json(task, 201);
});

narratorManualResourceRoutes.post("/:id/browser-sessions", async (c) => {
	const narratorId = c.req.param("id");
	await requireNarratorAccess(c, narratorId, "write");
	const parsed = manualBrowserSessionSchema.safeParse(await readManualResourceRequest(c));
	if (!parsed.success)
		throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid browser session");
	await requireNarratorAccess(c, narratorId, "write");
	c.req.raw.signal.throwIfAborted();
	const lease = tryAcquireFinalUpdateExecution("ordinary", narratorId);
	if (!lease)
		throw new AppError(
			"The server is preparing an update; try again later",
			503,
			"UPDATE_IN_PROGRESS",
		);
	try {
		const { url, ttlMs } = parsed.data;
		const session = await createSession(narratorId, url, true, ttlMs, false, undefined, {
			managedManual: true,
		});
		return c.json({ id: session.id }, 201);
	} finally {
		lease.release();
	}
});

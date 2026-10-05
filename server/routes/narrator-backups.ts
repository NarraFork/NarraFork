import { type Context, Hono } from "hono";
import { AppError, ValidationError } from "../lib/errors";
import { narratorPrincipalOf } from "../lib/narrator-access";
import {
	narratorBackupRequestSchema,
	narratorRestoreRequestSchema,
} from "../lib/validators/narrator-backups";
import { getAuthPrincipal } from "../middleware/auth";
import { narratorBackupJobs } from "../services/narrator-backup/runtime";

export const narratorBackupRoutes = new Hono();
function actor(c: Context) {
	if (getAuthPrincipal(c)?.type !== "session")
		throw new AppError(
			"Backups require first-party session authentication",
			403,
			"BACKUP_SESSION_REQUIRED",
		);
	return narratorPrincipalOf(c);
}
async function boundedJson(c: Context): Promise<unknown> {
	const declared = Number(c.req.header("content-length") ?? 0);
	if (declared > 1024 * 1024) throw new ValidationError("Backup request exceeds byte limit");
	const reader = c.req.raw.body?.getReader();
	if (!reader) throw new ValidationError("Missing backup request");
	// One fixed buffer also bounds allocation overhead for adversarial one-byte chunks.
	const body = Buffer.alloc(1024 * 1024);
	let bytes = 0;
	let rejectRead: ((error: Error) => void) | undefined;
	const abort = () => {
		void reader.cancel().catch(() => {});
		rejectRead?.(new ValidationError("Backup request cancelled or timed out"));
	};
	const timer = setTimeout(abort, 60_000);
	const signal = c.req.raw.signal;
	signal.addEventListener("abort", abort, { once: true });
	try {
		for (;;) {
			if (signal.aborted) throw new ValidationError("Backup request cancelled or timed out");
			const result = await new Promise<Awaited<ReturnType<typeof reader.read>>>(
				(resolve, reject) => {
					rejectRead = reject;
					reader.read().then(resolve, reject);
				},
			);
			rejectRead = undefined;
			if (result.done) break;
			bytes += result.value.length;
			if (bytes > body.length) throw new ValidationError("Backup request exceeds byte limit");
			body.set(result.value, bytes - result.value.length);
		}
		return JSON.parse(body.subarray(0, bytes).toString("utf8"));
	} catch (error) {
		void reader.cancel().catch(() => {});
		throw error;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		reader.releaseLock();
	}
}
narratorBackupRoutes.post("/plan", async (c) => {
	const principal = actor(c);
	const request = narratorBackupRequestSchema.safeParse(await boundedJson(c));
	if (!request.success) throw new ValidationError(request.error.message);
	return c.json(
		await narratorBackupJobs.planNarratorBackup(principal, request.data, c.req.raw.signal),
	);
});
narratorBackupRoutes.post("/exports", async (c) => {
	const principal = actor(c);
	const request = narratorBackupRequestSchema.safeParse(await boundedJson(c));
	if (!request.success) throw new ValidationError(request.error.message);
	return c.json(await narratorBackupJobs.exportNarratorBackup(principal, request.data), 202);
});
narratorBackupRoutes.get("/jobs/:jobId", (c) =>
	c.json(narratorBackupJobs.getJob(actor(c), c.req.param("jobId"))),
);
narratorBackupRoutes.delete("/jobs/:jobId", (c) =>
	c.json(narratorBackupJobs.cancelJob(actor(c), c.req.param("jobId"))),
);
narratorBackupRoutes.post("/artifacts", async (c) => {
	const principal = actor(c);
	if (c.req.header("content-type") !== "application/octet-stream" || !c.req.raw.body)
		throw new ValidationError("A raw SQLite application/octet-stream artifact is required");
	return c.json(
		await narratorBackupJobs.uploadArtifact(principal, c.req.raw.body, c.req.raw.signal),
		201,
	);
});
narratorBackupRoutes.get("/artifacts/:artifactId/download", async (c) => {
	const stream = await narratorBackupJobs.download(
		actor(c),
		c.req.param("artifactId"),
		c.req.raw.signal,
	);
	return new Response(stream, {
		headers: {
			"Content-Type": "application/octet-stream",
			"Content-Disposition": 'attachment; filename="narrator-backup.sqlite"',
			"Cache-Control": "private, no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
});
narratorBackupRoutes.delete("/artifacts/:artifactId", async (c) => {
	await narratorBackupJobs.deleteArtifact(actor(c), c.req.param("artifactId"));
	return c.json({ deleted: true });
});
narratorBackupRoutes.post("/preview", async (c) => {
	const principal = actor(c);
	const request = narratorRestoreRequestSchema.safeParse(await boundedJson(c));
	if (!request.success) throw new ValidationError(request.error.message);
	return c.json(
		await narratorBackupJobs.previewNarratorRestore(principal, request.data, c.req.raw.signal),
	);
});
narratorBackupRoutes.post("/restore", async (c) => {
	const principal = actor(c);
	const request = narratorRestoreRequestSchema.safeParse(await boundedJson(c));
	if (!request.success) throw new ValidationError(request.error.message);
	return c.json(
		await narratorBackupJobs.restoreNarratorState(principal, request.data, c.req.raw.signal),
		201,
	);
});

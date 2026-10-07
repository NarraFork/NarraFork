import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { z } from "zod";
import { activeDatabaseBackend, db } from "../db";
import { fileChangeScopes, remoteTreeCaptures } from "../db/schema";
import { AppError, ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";
import { narratorPrincipalOf, requireNarratorAccess } from "../lib/narrator-access";
import { remoteRecoveryProvenance } from "../middleware/remote-recovery-provenance";
import {
	getRemoteWorkspaceHistoryRuntime,
	type RemoteWorkspaceHistoryRuntime,
} from "../services/remote-workspace-history-runtime";
import { RemoteWorkspaceRestoreService } from "../services/remote-workspace-restore-service";

const nanoid = z.string().regex(/^[A-Za-z0-9_-]{21}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const diskString = z
	.string()
	.min(1)
	.max(8192)
	.refine((value) => !value.includes("\0"));
const cursorSchema = z
	.object({ version: z.literal(1), createdAt: z.string().min(1).max(64), id: nanoid })
	.strict();
const listSchema = z
	.object({
		limit: z
			.string()
			.regex(/^(?:[1-9]|[12][0-9]|3[0-2])$/)
			.default("32")
			.transform(Number),
		cursor: z
			.string()
			.min(1)
			.max(256)
			.regex(/^[A-Za-z0-9_-]+$/)
			.optional(),
	})
	.strict();
const previewSchema = z
	.object({
		captureId: nanoid,
		idempotencyKey: z
			.string()
			.min(1)
			.max(128)
			.regex(/^[A-Za-z0-9_-]+$/),
	})
	.strict();
const applySchema = z
	.object({
		planHash: digest,
		confirmation: z
			.object({
				kind: z.literal("snapshot_restore"),
				captureId: nanoid,
				deviceId: z
					.string()
					.min(1)
					.max(128)
					.refine((value) => !value.includes("\0")),
				root: diskString,
				rootIdentity: diskString,
				treeDigest: digest,
			})
			.strict(),
	})
	.strict();
const services = new WeakMap<RemoteWorkspaceHistoryRuntime, RemoteWorkspaceRestoreService>();
const bodyBytes = 64 * 1024;

function validated<T>(schema: z.ZodType<T>, input: unknown): T {
	const parsed = schema.safeParse(input);
	if (!parsed.success) throw new ValidationError("Invalid workspace snapshot request");
	return parsed.data;
}
function decodeCursor(value: string | undefined) {
	if (!value) return undefined;
	try {
		const bytes = Buffer.from(value, "base64url");
		if (bytes.toString("base64url") !== value) throw new Error("Noncanonical cursor");
		const cursor = validated(cursorSchema, JSON.parse(bytes.toString("utf8")));
		if (encodeCursor(cursor) !== value) throw new Error("Noncanonical cursor payload");
		return cursor;
	} catch {
		throw new ValidationError("Invalid workspace snapshot cursor");
	}
}
function encodeCursor(value: { createdAt: string; id: string }) {
	return Buffer.from(
		JSON.stringify({ version: 1, createdAt: value.createdAt, id: value.id }),
	).toString("base64url");
}
function supportedDatabase() {
	if (activeDatabaseBackend !== "sqlite")
		throw new AppError(
			"Workspace snapshot control requires a supported database",
			503,
			"UNSUPPORTED_DATABASE",
		);
}

/** Bounded streaming decode, including chunked bodies with no Content-Length. */
async function readBody(c: Context): Promise<unknown> {
	const tooLarge = () =>
		new AppError(
			"Workspace snapshot request exceeds the byte limit",
			413,
			"WORKSPACE_SNAPSHOT_REQUEST_TOO_LARGE",
		);
	const length = c.req.header("content-length");
	if (length && Number(length) > bodyBytes) throw tooLarge();
	const reader = c.req.raw.body?.getReader();
	if (!reader) throw new ValidationError("Invalid workspace snapshot JSON body");
	const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(60_000)]);
	const cancel = () => {
		void reader.cancel(signal.reason).catch(() => {});
	};
	signal.addEventListener("abort", cancel, { once: true });
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			signal.throwIfAborted();
			const chunk = await reader.read();
			signal.throwIfAborted();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > bodyBytes) {
				void reader.cancel().catch(() => {});
				throw tooLarge();
			}
			chunks.push(chunk.value);
		}
	} catch (error) {
		if (c.req.raw.signal.aborted) throw error;
		if (signal.aborted)
			throw new AppError(
				"Workspace snapshot request exceeded its time budget",
				409,
				"WORKSPACE_SNAPSHOT_RESTORE_UNAVAILABLE",
			);
		throw error;
	} finally {
		signal.removeEventListener("abort", cancel);
		reader.releaseLock();
	}
	try {
		return JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)),
		);
	} catch {
		throw new ValidationError("Invalid workspace snapshot JSON body");
	}
}
async function restorePhase<T>(
	c: Context,
	phase: "preview" | "apply" | "recover",
	run: (
		service: RemoteWorkspaceRestoreService,
		signal: AbortSignal,
		markMutationDispatch: () => void,
	) => Promise<T>,
) {
	const started = performance.now();
	const signal = AbortSignal.any([
		c.req.raw.signal,
		AbortSignal.timeout(phase === "preview" ? 60_000 : 180_000),
	]);
	let errorCode: string | undefined;
	let possibleMutationDispatch = false;
	const markMutationDispatch = () => {
		possibleMutationDispatch = true;
	};
	try {
		supportedDatabase();
		signal.throwIfAborted();
		const registry = await getRemoteWorkspaceHistoryRuntime();
		let service = services.get(registry);
		if (!service) {
			service = new RemoteWorkspaceRestoreService({ registry, timeoutMs: 180_000 });
			services.set(registry, service);
		}
		const result = await run(service, signal, markMutationDispatch);
		signal.throwIfAborted();
		await requireNarratorAccess(c, c.req.param("id") ?? "", "write");
		signal.throwIfAborted();
		return result;
	} catch (error) {
		if (c.req.raw.signal.aborted) throw error;
		if (possibleMutationDispatch) {
			errorCode = "WORKSPACE_SNAPSHOT_RESTORE_OUTCOME_UNKNOWN";
			throw new AppError(
				"Workspace snapshot restore outcome is unknown; retain the original restore receipt and recover that operation",
				409,
				errorCode,
			);
		}
		if (error instanceof DOMException && error.name === "AbortError") throw error;
		if (error instanceof AppError) {
			errorCode = error.code;
			throw error;
		}
		errorCode = "WORKSPACE_SNAPSHOT_RESTORE_UNAVAILABLE";
		throw new AppError(
			"Workspace snapshot restore is unavailable; source, permissions, policy or operation state must be revalidated",
			409,
			errorCode,
		);
	} finally {
		const elapsedMs = Math.round(performance.now() - started);
		if (errorCode || elapsedMs > 250)
			logger.warn("Workspace snapshot restore control", {
				narratorId: c.req.param("id"),
				phase,
				elapsedMs,
				errorCode,
			});
	}
}

export const narratorWorkspaceSnapshotRoutes = new Hono();
narratorWorkspaceSnapshotRoutes.use("/:id/workspace-snapshot-restores/*", remoteRecoveryProvenance);
for (const path of ["/:id/workspace-snapshots", "/:id/workspace-snapshot-restores/*"]) {
	narratorWorkspaceSnapshotRoutes.use(path, async (c, next) => {
		c.header("Cache-Control", "no-store");
		await next();
	});
}
narratorWorkspaceSnapshotRoutes.get("/:id/workspace-snapshots", async (c) => {
	const narratorId = validated(nanoid, c.req.param("id"));
	supportedDatabase();
	await requireNarratorAccess(c, narratorId, "read");
	const input = validated(listSchema, c.req.query());
	const cursor = decodeCursor(input.cursor);
	const capture = remoteTreeCaptures;
	// Never decode descriptor/receipt payloads into JS. Nested CASE bounds JSON parsing too.
	const treeDigest = sql<
		string | null
	>`case when length(cast(${capture.descriptorJson} as blob)) <= 16384 then case when json_valid(${capture.descriptorJson}) then case when json_type(${capture.descriptorJson}, '$.digest') = 'text' and length(json_extract(${capture.descriptorJson}, '$.digest')) = 64 then json_extract(${capture.descriptorJson}, '$.digest') end end end`;
	const rows = db
		.select({
			id: capture.id,
			deviceId: capture.deviceId,
			root: fileChangeScopes.canonicalRoot,
			rootIdentity: capture.rootIdentity,
			treeDigest,
			sourceInstanceId: capture.sourceInstanceId,
			scopeId: capture.scopeId,
			contextKey: capture.contextKey,
			workspaceRevision: capture.workspaceRevision,
			originProjectId: capture.originProjectId,
			originContextVersion: capture.originContextVersion,
			state: capture.state,
			edge: capture.edge,
			createdAt: capture.createdAt,
		})
		.from(capture)
		.leftJoin(
			fileChangeScopes,
			and(
				eq(fileChangeScopes.id, capture.scopeId),
				eq(fileChangeScopes.sourceInstanceId, capture.sourceInstanceId),
				eq(fileChangeScopes.deviceId, capture.deviceId),
				eq(fileChangeScopes.workspaceInstanceId, capture.workspaceInstanceId),
			),
		)
		.where(
			and(
				eq(capture.narratorId, narratorId),
				or(
					eq(capture.actorSubjectKey, `human:${narratorPrincipalOf(c).userId}`),
					// Automatic tool-edge captures carry this exact narrator actor, not its owner.
					eq(capture.actorSubjectKey, `narrator:${narratorId}`),
				),
				cursor
					? or(
							lt(capture.createdAt, cursor.createdAt),
							and(eq(capture.createdAt, cursor.createdAt), lt(capture.id, cursor.id)),
						)
					: undefined,
			),
		)
		.orderBy(desc(capture.createdAt), desc(capture.id))
		.limit(input.limit + 1)
		.all();
	const items = rows.slice(0, input.limit).map((row) => {
		const treeDigest =
			row.treeDigest && digest.safeParse(row.treeDigest).success ? row.treeDigest : null;
		const reason =
			row.originContextVersion !== 1
				? "legacy_origin_unknown"
				: row.deviceId === "local"
					? "local_capture_unsupported"
					: row.state !== "complete"
						? "capture_incomplete"
						: !treeDigest
							? "tree_digest_unavailable"
							: !row.root
								? "original_scope_unavailable"
								: undefined;
		return { ...row, treeDigest, restorableCandidate: !reason, ...(reason ? { reason } : {}) };
	});
	await requireNarratorAccess(c, narratorId, "read");
	return c.json({
		items,
		...(rows.length > input.limit ? { nextCursor: encodeCursor(items[items.length - 1]) } : {}),
	});
});
narratorWorkspaceSnapshotRoutes.post("/:id/workspace-snapshot-restores/preview", async (c) => {
	const narratorId = validated(nanoid, c.req.param("id"));
	supportedDatabase();
	await requireNarratorAccess(c, narratorId, "write");
	const body = validated(previewSchema, await readBody(c));
	const result = await restorePhase(c, "preview", (service, signal) =>
		service.prepare({
			principal: narratorPrincipalOf(c),
			narratorId,
			...body,
			signal,
		}),
	);
	const { id, status, planHash, coverageComplete, expiresAt } = result.plan;
	return c.json({
		plan: { id, status, planHash, coverageComplete, expiresAt },
		origin: result.origin,
		confirmation: result.confirmation,
		requiresExplicitSnapshotRestore: result.requiresExplicitSnapshotRestore,
		files: result.files,
		totalFileCount: result.totalFileCount,
		hasMore: result.hasMore,
	});
});
for (const phase of ["apply", "recover"] as const) {
	narratorWorkspaceSnapshotRoutes.post(
		`/:id/workspace-snapshot-restores/:planId/${phase}`,
		async (c) => {
			const narratorId = validated(nanoid, c.req.param("id"));
			const planId = validated(nanoid, c.req.param("planId"));
			supportedDatabase();
			await requireNarratorAccess(c, narratorId, "write");
			const body = validated(applySchema, await readBody(c));
			const result = await restorePhase(c, phase, (service, signal, markMutationDispatch) => {
				const input = {
					principal: narratorPrincipalOf(c),
					narratorId,
					planId,
					...body,
					signal,
				};
				return phase === "apply"
					? service.apply({ ...input, onMutationDispatch: markMutationDispatch })
					: service.recover(input);
			});
			// Recovery state is not success, and private service diagnostics never leave this boundary.
			return c.json(
				{
					planId: result.planId,
					status: result.status,
					restoredFileCount: result.restoredFileCount,
					...(result.nativeOperationId ? { nativeOperationId: result.nativeOperationId } : {}),
					...(result.reason ? { reason: "WORKSPACE_SNAPSHOT_RESTORE_UNAVAILABLE" } : {}),
				},
				result.status === "recovery_required" ? 409 : 200,
			);
		},
	);
}

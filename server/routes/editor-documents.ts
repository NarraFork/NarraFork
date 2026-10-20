import { lstat, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { readQuery } from "@server/db/worker-read";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import type { z } from "zod";
import { EDITOR_METADATA_MAX_BYTES } from "../../shared/editor-document";
import { db } from "../db";
import { chapters, projects, users } from "../db/schema";
import { AppError, NotFoundError, zodValidationError } from "../lib/errors";
import { checkWriteBoundary, describeWriteRefusal } from "../lib/fs-write-boundary";
import { requireNarratorAccess } from "../lib/narrator-access";
import { validateAccessTokenById } from "../lib/oauth-provider";
import { getHome } from "../lib/platform";
import { settings } from "../lib/settings";
import {
	commitEditorUploadSchema,
	createEditorDocumentSchema,
	createEditorDraftAnchorSchema,
	createEditorUploadSchema,
	editorRawChunkSchema,
	editorRawOpenSchema,
	editorRawSealSchema,
	editorRecoveryScopeSchema,
	editorUploadChunkSchema,
} from "../lib/validators/editor-documents";
import type { AuthPrincipal } from "../middleware/auth";
import { RemoteBackend } from "../services/device-remote-backend";
import { readLegacyFilePanel } from "../services/editor-document-panel";
import {
	editorRuntimeUnavailable,
	getEditorDocumentService,
} from "../services/editor-document-runtime";
import {
	type EditorActor,
	type EditorBinding,
	EditorDocumentError,
	type EditorDocumentService,
	editorRecoveryKey,
	editorResourceKey,
} from "../services/editor-document-service";
import { rejectEditorSymlinks } from "../services/editor-document-worker";
import {
	authorizeEditorOperationDevice,
	authorizeEditorReferenceContext,
	authorizeEditorReferenceTarget,
} from "../services/file-reference-service";
import { loadNarratorForAccess } from "../services/narrator-acl";
import { resolveNarratorSessionCwd } from "../services/narrator-cwd";

/** Bounded raw metadata reading also covers chunked requests with no Content-Length. */
export async function readEditorMetadata<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
	const declared = request.headers.get("content-length");
	if (declared && (!/^\d+$/.test(declared) || Number(declared) > EDITOR_METADATA_MAX_BYTES))
		throw new AppError("Editor metadata exceeds 32 KiB", 413, "EDITOR_METADATA_TOO_LARGE");
	const reader = request.body?.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (reader) {
			const chunk = await reader.read();
			if (chunk.done) break;
			size += chunk.value.byteLength;
			if (size > EDITOR_METADATA_MAX_BYTES)
				throw new AppError("Editor metadata exceeds 32 KiB", 413, "EDITOR_METADATA_TOO_LARGE");
			chunks.push(chunk.value);
		}
	} catch (error) {
		void reader?.cancel().catch(() => {});
		throw error;
	}
	let body: unknown;
	try {
		body = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
	} catch {
		throw new AppError("Invalid editor JSON metadata", 400, "VALIDATION_ERROR");
	}
	const parsed = schema.safeParse(body);
	if (!parsed.success) throw zodValidationError(parsed.error);
	return parsed.data;
}
export function editorActor(c: Context): ReturnType<typeof editorActorForSubject> {
	return editorActorForSubject(
		{
			userId: c.get("user").sub,
			auth: c.get("auth"),
			narratorId: c.req.param("id") ?? "",
			locale: c.req.header("accept-language")?.startsWith("zh") ? "zh-CN" : "en",
		},
		c.req.raw.signal,
	);
}

/** Rebuildable verified identity only: never retain a request, bearer or Hono context. */
export function editorActorForSubject(
	subject: { userId: string; narratorId: string; locale?: "en" | "zh-CN"; auth?: AuthPrincipal },
	signal?: AbortSignal,
): EditorActor & Required<Pick<EditorActor, "authorizeOperation">> {
	const requireAccess = async (need: "read" | "write") => {
		const user = await db.query.users.findFirst({
			where: eq(users.id, subject.userId),
			columns: { role: true, tokenVersion: true },
		});
		if (!user) throw new NotFoundError("User", subject.userId);
		const auth = subject.auth;
		if (
			auth?.type === "session" &&
			(auth.user.sub !== subject.userId ||
				auth.user.exp <= Date.now() / 1000 ||
				(auth.user.sv ?? 0) !== user.tokenVersion)
		)
			throw new AppError("Editor authorization expired", 403, "EDITOR_IDENTITY_CHANGED");
		if (auth?.type === "oauth") {
			const live = await validateAccessTokenById(auth.oauth.tokenId);
			if (
				!live ||
				live.userId !== subject.userId ||
				live.tokenId !== auth.oauth.tokenId ||
				live.clientId !== auth.oauth.clientId ||
				live.oauthClientId !== auth.oauth.oauthClientId ||
				live.grantId !== auth.oauth.grantId ||
				live.refreshFamilyId !== auth.oauth.refreshFamilyId ||
				!auth.oauth.scopes.every((scope) => live.scopes.includes(scope))
			)
				throw new AppError("Editor authorization expired", 403, "EDITOR_IDENTITY_CHANGED");
		}
		return loadNarratorForAccess(
			subject.narratorId,
			{
				userId: subject.userId,
				isAdmin: user.role === "admin",
			},
			need,
		);
	};
	const actor: EditorActor & Required<Pick<EditorActor, "authorizeOperation">> = {
		...subject,
		signal,
		async authorizeOperation(deviceId) {
			await requireAccess("read");
			await authorizeEditorOperationDevice(actor.narratorId, actor.userId, deviceId);
		},
		async authorize(input, need, operationSignal = signal) {
			operationSignal?.throwIfAborted();
			const narrator = await requireAccess(need);
			operationSignal?.throwIfAborted();
			const device = input.deviceId ?? narrator.defaultDeviceId ?? "local";
			if (device !== "local" && input.protocol === "raw-v2") {
				const context = await authorizeEditorReferenceContext(
					narrator.id,
					actor.userId,
					input.path,
					device,
					need,
				);
				const backend = context.backend;
				if (!(backend instanceof RemoteBackend) || !backend.supportsEditorRawRead)
					throw new AppError(
						"Upgrade the executor: editor.raw-read.v1 is required; no host fallback is permitted",
						422,
						"EDITOR_PROVIDER_UNSUPPORTED",
					);
				const contextKey = JSON.stringify([
					narrator.workspaceRevision,
					narrator.workspaceContext?.contextKey,
					narrator.defaultDeviceId,
					narrator.chapterId,
				]);
				const root = await backend.editorRootIdentity(operationSignal);
				if (need === "write" && !backend.supportsEditorDurableWrite)
					throw new AppError(
						"Upgrade the executor: editor.durable-write.v1 is required",
						422,
						"EDITOR_PROVIDER_UNSUPPORTED",
					);
				const binding: EditorBinding = {
					workspaceRevision: narrator.workspaceRevision,
					deviceId: device,
					cwd: root.canonicalRoot,
					projectId: null,
					lexicalPath:
						context.target.lexicalPath ??
						backend.paths.resolve(backend.defaultCwd ?? "", input.path),
					canonicalPath: context.target.canonicalPath as string,
					outsideRoots: false,
					writeConfirmationRequired: context.editorNeedsConfirmation,
					contextKey,
					workspaceIdentity: root.rootIdentity,
					pathFlavor: backend.pathFlavor,
					runtimeGeneration: backend.runtimeGeneration,
					runtimeEpoch: root.runtimeEpoch,
				};
				binding.rawSource = backend.editorRawSource(
					{
						deviceId: device,
						pathFlavor: backend.pathFlavor,
						canonicalPath: binding.canonicalPath,
						workspaceIdentity: root.rootIdentity,
						runtimeEpoch: root.runtimeEpoch,
						runtimeGeneration: backend.runtimeGeneration,
						fencingToken: backend.runtimeGeneration,
					},
					editorResourceKey(actor, input, binding),
				);
				binding.writeTarget = {
					backend,
					rootIdentity: root.rootIdentity,
					runtime: {
						runtimeEpoch: root.runtimeEpoch,
						runtimeGeneration: backend.runtimeGeneration,
					},
					currentRuntime: () =>
						backend.supportsEditorDurableWrite
							? { runtimeEpoch: root.runtimeEpoch, runtimeGeneration: backend.runtimeGeneration }
							: null,
					assertParent: async (signal) => {
						const parent = await backend.editorWriteRpc().call<{ isDirectory: boolean }>(
							"fs.stat",
							{
								path: backend.paths.dirname(binding.canonicalPath),
								editorIdentity: true,
								editorRoot: root.canonicalRoot,
							},
							signal,
						);
						if (!parent.isDirectory)
							throw new AppError(
								"Editor target parent must already exist",
								409,
								"EDITOR_APPLY_REJECTED",
							);
					},
				};
				return binding;
			}
			if (device !== "local")
				throw new AppError(
					"Remote editor transfers are unsupported; use the existing read-only entry",
					422,
					"EDITOR_REMOTE_UNSUPPORTED",
				);
			// cwd is an optional override: chapter narrators normally inherit their worktree.
			// Resolve it on every request so moving/dormant worktrees invalidate old bindings.
			const chapter = narrator.chapterId
				? await readQuery(
						db.query.chapters.findFirst({
							where: eq(chapters.id, narrator.chapterId),
							columns: { projectId: true, worktreePath: true },
						}),
					)
				: undefined;
			if (narrator.chapterId && !chapter) throw new NotFoundError("Chapter", narrator.chapterId);
			const projectId = chapter?.projectId ?? narrator.contextProjectId ?? null;
			const project = projectId
				? await readQuery(
						db.query.projects.findFirst({
							where: eq(projects.id, projectId),
							columns: { gitPath: true },
						}),
					)
				: undefined;
			if (projectId && !project) throw new NotFoundError("Project", projectId);
			const cwd = resolveNarratorSessionCwd(
				narrator.cwd,
				chapter?.worktreePath,
				project?.gitPath,
				getHome(),
			);
			const lexicalPath = resolve(cwd, input.path);
			try {
				await rejectEditorSymlinks(lexicalPath);
			} catch {
				throw new AppError(
					"Symbolic links or unresolvable paths cannot be edited",
					403,
					"EDITOR_WRITE_REFUSED",
				);
			}
			const decision = checkWriteBoundary(lexicalPath, [
				cwd,
				...(settings.paths.extraWritableDirs ?? []),
			]);
			if (!decision.physicalPath || (!decision.allowed && !decision.confirmable))
				throw new AppError(
					describeWriteRefusal(decision.reason ?? "unresolvable"),
					403,
					"EDITOR_WRITE_REFUSED",
				);
			if (input.origin === "reference") {
				const canonical = await authorizeEditorReferenceTarget(
					narrator.id,
					actor.userId,
					lexicalPath,
				);
				if (canonical !== decision.physicalPath)
					throw new AppError("Editor source identity changed", 403, "EDITOR_IDENTITY_CHANGED");
			}
			const canonicalRoot = await realpath(cwd);
			const root = await lstat(canonicalRoot, { bigint: true });
			return {
				workspaceRevision: narrator.workspaceRevision,
				contextKey: JSON.stringify([
					narrator.workspaceRevision,
					narrator.workspaceContext?.contextKey,
					narrator.defaultDeviceId,
					narrator.chapterId,
					chapter?.worktreePath,
				]),
				workspaceIdentity: JSON.stringify([canonicalRoot, String(root.dev), String(root.ino)]),
				pathFlavor: process.platform === "win32" ? ("windows" as const) : ("posix" as const),
				cwd,
				lexicalPath,
				canonicalPath: decision.physicalPath,
				outsideRoots: !decision.allowed,
				projectId,
			};
		},
	};
	return actor;
}
export function createEditorDocumentRoutes(
	getService: () => EditorDocumentService = getEditorDocumentService,
) {
	const routes = new Hono();
	// Do not install a wildcard narrator middleware here: it would affect unrelated chat routes.
	const protect = async (c: Context) => {
		if (!c.get("user")?.sub) throw new AppError("Authentication required", 401, "UNAUTHORIZED");
		c.header("Cache-Control", "no-store");
		await requireNarratorAccess(c, c.req.param("id") ?? "", "read");
	};
	// Draft/receipt metadata stays in the verified original-device namespace, even
	// offline. This does not reopen a target or turn a remote path into Host IO.
	const draftOwner = async (c: Context, scope: { deviceId?: string }) => {
		const actor = editorActor(c);
		await actor.authorizeOperation(scope.deviceId ?? "local");
		return actor;
	};
	const base = "/:id/editor-documents";
	routes.use(`${base}/*`, async (c, next) => {
		if (
			(c.req.method === "GET" && /\/editor-documents\/(info|page)$/.test(c.req.path)) ||
			/\/editor-documents\/[^/]+\/raw-reads(?:\/[^/]+)?$/.test(c.req.path)
		) {
			// The panel operation budgets access checks together with metadata/IO.
			if (!c.get("user")?.sub) throw new AppError("Authentication required", 401, "UNAUTHORIZED");
			c.header("Cache-Control", "no-store");
		} else await protect(c);
		await next();
	});
	routes.use(base, async (c, next) => {
		await protect(c);
		await next();
	});
	routes.onError((error, c) => {
		if (error instanceof EditorDocumentError)
			return c.json(
				{ error: error.message, code: error.code, ...error.data },
				error.statusCode as 409,
			);
		if (error instanceof AppError)
			return c.json({ error: error.message, code: error.code }, error.statusCode as 400);
		throw error;
	});
	const localPanelDevice = (c: Context) => {
		const deviceId = c.req.query("deviceId");
		if (deviceId !== undefined && deviceId !== "local")
			throw new AppError("Legacy panels are local only", 422, "EDITOR_REMOTE_UNSUPPORTED");
	};
	routes.get(`${base}/capabilities`, async (c) => {
		const parsed = createEditorDocumentSchema.safeParse({ ...c.req.query(), protocol: "raw-v2" });
		if (!parsed.success) throw zodValidationError(parsed.error);
		const input = parsed.data,
			actor = editorActor(c),
			device = input.deviceId ?? "local";
		let readMode: "raw-v2" | "bounded-preview" = "raw-v2";
		if (device !== "local") {
			const context = await authorizeEditorReferenceContext(
				actor.narratorId,
				actor.userId,
				input.path,
				device,
				"read",
			);
			const backend = context.backend;
			if (!(backend instanceof RemoteBackend))
				throw new AppError("Execution device unavailable", 422, "EDITOR_PROVIDER_UNSUPPORTED");
			if (!backend.supportsEditorRawRead) {
				if (
					!backend.supportsFsStatResolvedPath ||
					!backend.supportsFsReadAtomicResolvedPath ||
					!backend.supportsFsReadBounded
				)
					throw new AppError(
						"Upgrade the executor: safe bounded filesystem reads are required",
						422,
						"EDITOR_PROVIDER_UNSUPPORTED",
					);
				readMode = "bounded-preview";
			} else await actor.authorize(input, "read", c.req.raw.signal);
		} else await actor.authorize(input, "read", c.req.raw.signal);
		await actor.authorizeOperation(device);
		await protect(c);
		return c.json({ protocols: ["text-v1", "raw-v2"], readMode });
	});
	routes.get(`${base}/info`, async (c) => {
		localPanelDevice(c);
		return c.json(
			await readLegacyFilePanel(editorActor(c), c.req.query("path"), undefined, c.req.raw.signal),
		);
	});
	routes.get(`${base}/page`, async (c) => {
		localPanelDevice(c);
		const rawOffset = c.req.query("offset");
		if (!rawOffset || !/^\d+$/.test(rawOffset))
			throw new AppError("Byte offset is required", 400, "VALIDATION_ERROR");
		return c.json(
			await readLegacyFilePanel(
				editorActor(c),
				c.req.query("path"),
				Number(rawOffset),
				c.req.raw.signal,
			),
		);
	});
	routes.get(`${base}/recovery-scope`, async (c) => {
		const parsed = editorRecoveryScopeSchema.safeParse(c.req.query());
		if (!parsed.success) throw zodValidationError(parsed.error);
		// Match the owner namespace minted on the original transfer without opening today's
		// path, creating a document, or depending on an unexpired transfer session. Current
		// verified principal + narrator ACL authorize private draft/receipt discovery only.
		const scope = {
			recoveryKey: editorRecoveryKey(await draftOwner(c, parsed.data), {
				...parsed.data,
				path: "",
			}),
		};
		await draftOwner(c, parsed.data);
		await protect(c);
		return c.json(scope);
	});
	routes.post(`${base}/draft-anchors`, async (c) => {
		await protect(c);
		const input = await readEditorMetadata(c.req.raw, createEditorDraftAnchorSchema);
		const anchor = await getService().createDraftAnchor(await draftOwner(c, input), input);
		await draftOwner(c, input);
		await protect(c);
		return c.json(anchor);
	});
	routes.get(`${base}/draft-anchors/:anchorId`, async (c) => {
		await protect(c);
		const parsed = editorRecoveryScopeSchema.safeParse(c.req.query());
		if (!parsed.success) throw zodValidationError(parsed.error);
		const id = c.req.param("anchorId");
		if (!/^[a-f0-9-]{36}$/.test(id))
			throw new AppError("Invalid draft anchor", 400, "VALIDATION_ERROR");
		const anchor = await getService().draftAnchors.get(
			editorRecoveryKey(await draftOwner(c, parsed.data), { ...parsed.data, path: "" }),
			id,
		);
		await draftOwner(c, parsed.data);
		await protect(c);
		return c.json(anchor);
	});
	routes.delete(`${base}/draft-anchors/:anchorId`, async (c) => {
		await protect(c);
		const parsed = editorRecoveryScopeSchema.safeParse(c.req.query());
		if (!parsed.success) throw zodValidationError(parsed.error);
		const id = c.req.param("anchorId");
		if (!/^[a-f0-9-]{36}$/.test(id))
			throw new AppError("Invalid draft anchor", 400, "VALIDATION_ERROR");
		const result = await getService().draftAnchors.release(
			editorRecoveryKey(await draftOwner(c, parsed.data), { ...parsed.data, path: "" }),
			id,
		);
		await draftOwner(c, parsed.data);
		await protect(c);
		return c.json(result);
	});
	for (const action of ["publish", "claim"] as const)
		routes.post(`${base}/draft-anchors/:anchorId/${action}`, async (c) => {
			await protect(c);
			const scope = await readEditorMetadata(c.req.raw, editorRecoveryScopeSchema);
			const id = c.req.param("anchorId");
			if (!/^[a-f0-9-]{36}$/.test(id))
				throw new AppError("Invalid draft anchor", 400, "VALIDATION_ERROR");
			const anchor = await getService().draftAnchors[action](
				editorRecoveryKey(await draftOwner(c, scope), { ...scope, path: "" }),
				id,
			);
			await draftOwner(c, scope);
			await protect(c);
			return c.json(anchor);
		});
	routes.post(base, async (c) =>
		c.json(
			await getService().create(
				editorActor(c),
				await readEditorMetadata(c.req.raw, createEditorDocumentSchema),
				c.req.raw.signal,
			),
		),
	);
	routes.get(`${base}/:docId/disk-state`, async (c) => {
		const state = await getService().diskState(
			editorActor(c),
			c.req.param("docId"),
			c.req.raw.signal,
		);
		// Reauthorization boundary: a revoked narrator cannot publish a late disk observation.
		await protect(c);
		return c.json(state);
	});
	routes.post(`${base}/:docId/raw-reads`, async (c) => {
		const input = await readEditorMetadata(c.req.raw, editorRawOpenSchema);
		return c.json(
			await getService().rawOpen(
				editorActor(c),
				c.req.param("docId"),
				input.versionHandle,
				c.req.raw.signal,
			),
		);
	});
	routes.post(`${base}/:docId/raw-reads/:readId`, async (c) => {
		const input = await readEditorMetadata(c.req.raw, editorRawChunkSchema);
		const chunk = await getService().rawChunk(
			editorActor(c),
			c.req.param("docId"),
			c.req.param("readId"),
			input.offset,
			input.maxBytes,
		);
		return new Response(chunk.bytes as Uint8Array<ArrayBuffer>, {
			headers: {
				"Content-Type": "application/octet-stream",
				"Cache-Control": "no-store",
				"X-Editor-EOF": chunk.eof ? "1" : "0",
				"X-Content-Type-Options": "nosniff",
			},
		});
	});
	routes.delete(`${base}/:docId/raw-reads/:readId`, async (c) => {
		await getService().rawClose(editorActor(c), c.req.param("docId"), c.req.param("readId"));
		return c.body(null, 204);
	});
	routes.get(`${base}/:docId/content`, async (c) => {
		const version = c.req.query("version");
		if (!version || version.length > 128)
			throw new AppError("Version handle is required", 400, "VALIDATION_ERROR");
		const stream = await getService().content(
			editorActor(c),
			c.req.param("docId"),
			version,
			c.req.raw.signal,
		);
		return new Response(stream, {
			headers: {
				"Content-Type": "application/octet-stream",
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
	});
	routes.post(`${base}/:docId/uploads`, async (c) =>
		c.json(
			await getService().createUpload(
				editorActor(c),
				c.req.param("docId"),
				await readEditorMetadata(c.req.raw, createEditorUploadSchema),
			),
		),
	);
	routes.get(`${base}/:docId/uploads/:uploadId`, async (c) => {
		const status = await getService().uploadStatus(
			editorActor(c),
			c.req.param("docId"),
			c.req.param("uploadId"),
		);
		await protect(c);
		return c.json(status);
	});
	routes.put(`${base}/:docId/uploads/:uploadId`, async (c) => {
		if (c.req.header("content-type")?.split(";")[0].trim() !== "application/octet-stream")
			throw new AppError(
				"Upload requires application/octet-stream",
				415,
				"EDITOR_INVALID_MEDIA_TYPE",
			);
		const rawLength = c.req.header("content-length");
		if (rawLength !== undefined && !/^\d+$/.test(rawLength))
			throw new AppError("Invalid Content-Length", 400, "VALIDATION_ERROR");
		return c.json(
			await getService().put(
				editorActor(c),
				c.req.param("docId"),
				c.req.param("uploadId"),
				c.req.raw.body,
				rawLength === undefined ? undefined : Number(rawLength),
				c.req.raw.signal,
			),
		);
	});
	routes.put(`${base}/:docId/uploads/:uploadId/chunks/:seq`, async (c) => {
		if (c.req.header("content-type") !== "application/octet-stream")
			throw new AppError("Chunk requires octet-stream", 415, "EDITOR_INVALID_MEDIA_TYPE");
		const numeric = (value: string | undefined) =>
			value && /^\d+$/.test(value) ? Number(value) : NaN;
		const parsed = editorUploadChunkSchema.safeParse({
			seq: numeric(c.req.param("seq")),
			offset: numeric(c.req.header("x-editor-offset")),
			bytes: numeric(c.req.header("x-editor-bytes")),
			digest: c.req.header("x-editor-digest"),
		});
		if (!parsed.success) throw zodValidationError(parsed.error);
		return c.json(
			await getService().putChunk(
				editorActor(c),
				c.req.param("docId"),
				c.req.param("uploadId"),
				parsed.data,
				c.req.raw.body,
				c.req.raw.signal,
			),
		);
	});
	routes.post(`${base}/:docId/uploads/:uploadId/seal`, async (c) =>
		c.json(
			await getService().sealRaw(
				editorActor(c),
				c.req.param("docId"),
				c.req.param("uploadId"),
				await readEditorMetadata(c.req.raw, editorRawSealSchema),
				c.req.raw.signal,
			),
		),
	);
	routes.post(`${base}/:docId/uploads/:uploadId/commit`, async (c) =>
		c.json(
			await getService().commit(
				editorActor(c),
				c.req.param("docId"),
				c.req.param("uploadId"),
				await readEditorMetadata(c.req.raw, commitEditorUploadSchema),
			),
		),
	);
	routes.delete(`${base}/:docId/uploads/:uploadId`, async (c) =>
		c.json(
			await getService().cancelUpload(
				editorActor(c),
				c.req.param("docId"),
				c.req.param("uploadId"),
			),
		),
	);
	routes.delete(`${base}/:docId`, async (c) =>
		c.json(await getService().remove(editorActor(c), c.req.param("docId"))),
	);
	routes.get("/:id/editor-operations/:operationId", async (c) => {
		await protect(c);
		const operationId = c.req.param("operationId");
		if (operationId.length > 128)
			throw new AppError("Invalid operation id", 400, "VALIDATION_ERROR");
		try {
			const receipt = await getService().operation(editorActor(c), operationId);
			// A startup/recovery lookup may wait: revoked narrator access must not publish a queued receipt.
			await protect(c);
			return c.json(receipt);
		} catch (error) {
			editorRuntimeUnavailable(error);
		}
	});
	return routes;
}
export const editorDocumentRoutes = createEditorDocumentRoutes();

import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { type Context, Hono } from "hono";
import type { z } from "zod";
import { EDITOR_METADATA_MAX_BYTES } from "../../shared/editor-document";
import { AppError, zodValidationError } from "../lib/errors";
import { checkWriteBoundary, describeWriteRefusal } from "../lib/fs-write-boundary";
import { requireNarratorAccess } from "../lib/narrator-access";
import { settings } from "../lib/settings";
import {
	commitEditorUploadSchema,
	createEditorDocumentSchema,
	createEditorUploadSchema,
} from "../lib/validators/editor-documents";
import { remoteEditorSessionProvenance } from "../middleware/remote-recovery-provenance";
import {
	editorRuntimeUnavailable,
	getEditorDocumentService,
} from "../services/editor-document-runtime";
import {
	type EditorActor,
	EditorDocumentError,
	type EditorDocumentService,
} from "../services/editor-document-service";
import { rejectEditorSymlinks } from "../services/editor-document-worker";
import { authorizeEditorReferenceTarget } from "../services/file-reference-service";
import { narratorDeviceWorkspaceService } from "../services/narrator-device-workspace-service";
import { resolveNarratorProjectId } from "../services/narrator-project";
import { authorizeRemoteEditorBinding } from "../services/remote-editor-access";
import { assertNarratorOriginalWorkspaceAuthority } from "../services/workspace-artifact-access";
import { assertWorkspaceSelectionInstalled } from "../services/workspace-context-service";

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
export function editorActor(c: Context): EditorActor {
	const actor: EditorActor = {
		userId: c.get("user").sub,
		narratorId: c.req.param("id") ?? "",
		locale: c.req.header("accept-language")?.startsWith("zh") ? "zh-CN" : "en",
		async authorize(input, need, original) {
			const narrator = await requireNarratorAccess(c, actor.narratorId, need);
			if (!original) assertWorkspaceSelectionInstalled(narrator.id);
			const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(30_000)]);
			const device = original?.deviceId ?? input.deviceId ?? narrator.defaultDeviceId ?? "local";
			const source = original
				? original.workspaceContext
				: await narratorDeviceWorkspaceService.resolve(narrator.id, device, {
						userId: actor.userId,
					});
			if (!source || source.deviceId !== device)
				throw new EditorDocumentError(
					"EDITOR_IDENTITY_CHANGED",
					"Editor original source or configured device binding is unavailable",
					403,
				);
			const workspace = Object.freeze(structuredClone(source));
			const projectId = original ? original.projectId : await resolveNarratorProjectId(narrator);
			let proof: { assertStillCurrent(): void } | undefined;
			const authorizationGuard = async (required: "read" | "write") => {
				await requireNarratorAccess(c, narrator.id, required);
				if (original) {
					proof = await assertNarratorOriginalWorkspaceAuthority(narrator.id, workspace, {
						userId: actor.userId,
						signal,
						need: required,
						originalProjectId: projectId,
					});
				} else {
					await narratorDeviceWorkspaceService.assertCurrent(narrator.id, workspace, {
						userId: actor.userId,
					});
					proof = await assertNarratorOriginalWorkspaceAuthority(narrator.id, workspace, {
						userId: actor.userId,
						signal,
						need: required,
						originalProjectId: projectId,
					});
				}
			};
			const assertCreationCurrent = () => {
				signal.throwIfAborted();
				proof?.assertStillCurrent();
				if (!original) assertWorkspaceSelectionInstalled(narrator.id);
				if (!original)
					narratorDeviceWorkspaceService.assertCurrentSync(narrator.id, workspace, {
						userId: actor.userId,
					});
			};
			if (device !== "local") {
				const binding = await authorizeRemoteEditorBinding(
					actor,
					workspace,
					original ? { ...input, path: original.lexicalPath, deviceId: device } : input,
					need,
					{
						signal,
						authorizationGuard,
						original,
						originalProjectId: projectId,
						assertStillCurrent: assertCreationCurrent,
					},
				);
				assertCreationCurrent();
				return Object.freeze({
					...binding,
					workspaceContext: workspace,
					assertCreationCurrent: original ? undefined : assertCreationCurrent,
				});
			}
			await authorizationGuard(need);
			const cwd = workspace.cwd;
			const rootStat = await lstat(cwd);
			const rootIdentity = `${rootStat.dev}:${rootStat.ino}`;
			if (
				!rootStat.isDirectory() ||
				rootStat.isSymbolicLink() ||
				(original && original.rootIdentity !== rootIdentity)
			)
				throw new EditorDocumentError(
					"EDITOR_IDENTITY_CHANGED",
					"Original editor root identity changed",
					403,
				);
			const lexicalPath = original?.lexicalPath ?? resolve(cwd, input.path);
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
					c.get("user").sub,
					lexicalPath,
					workspace,
					projectId,
				);
				if (canonical !== decision.physicalPath)
					throw new AppError("Editor source identity changed", 403, "EDITOR_IDENTITY_CHANGED");
			}
			await authorizationGuard(need);
			proof = await assertNarratorOriginalWorkspaceAuthority(narrator.id, workspace, {
				userId: actor.userId,
				signal,
				need,
				originalProjectId: projectId,
				canonicalPath: decision.physicalPath,
			});
			assertCreationCurrent();
			return {
				deviceId: device,
				rootIdentity,
				workspaceContext: workspace,
				workspaceRevision: workspace.revision,
				contextKey: workspace.contextKey,
				assertCreationCurrent: original ? undefined : assertCreationCurrent,
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
	const base = "/:id/editor-documents";
	routes.use(base, remoteEditorSessionProvenance);
	routes.use(`${base}/*`, remoteEditorSessionProvenance);
	routes.use(`${base}/*`, async (c, next) => {
		await protect(c);
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
	routes.post(base, async (c) =>
		c.json(
			await getService().create(
				editorActor(c),
				await readEditorMetadata(c.req.raw, createEditorDocumentSchema),
				c.req.raw.signal,
			),
		),
	);
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
	routes.get(`${base}/:docId/uploads/:uploadId`, async (c) =>
		c.json(
			await getService().uploadStatus(
				editorActor(c),
				c.req.param("docId"),
				c.req.param("uploadId"),
			),
		),
	);
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
			return c.json(await getService().operation(editorActor(c), operationId));
		} catch (error) {
			editorRuntimeUnavailable(error);
		}
	});
	return routes;
}
export const editorDocumentRoutes = createEditorDocumentRoutes();

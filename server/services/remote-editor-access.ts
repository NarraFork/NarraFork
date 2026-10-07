import type { CreateEditorDocumentInput } from "@shared/editor-document";
import type { WorkspaceContext } from "@shared/workspace-context";
import { resolveBackend } from "../lib/agent/execution/registry";
import { AppError } from "../lib/errors";
import { resolveRemoteEditorRoot } from "./editor-document-runtime";
import {
	type EditorActor,
	type EditorBinding,
	EditorDocumentError,
} from "./editor-document-service";
import {
	createNarratorWorkspaceAttachmentAccess,
	createNarratorWorkspaceAttachmentSourceAccess,
} from "./workspace-artifact-access";

/** Human authority is live and independent from ordinary AI readOnly. OAuth ceilings still apply. */
export async function authorizeRemoteEditorBinding(
	actor: EditorActor,
	workspaceContext: WorkspaceContext,
	input: CreateEditorDocumentInput,
	need: "read" | "write",
	options: { signal: AbortSignal; authorizationGuard: (need: "read" | "write") => Promise<void> },
): Promise<EditorBinding> {
	const workspace = Object.freeze({ ...workspaceContext });
	const signal = options.signal;
	const backend = resolveBackend({ requested: workspace.deviceId });
	const generation = backend.runtimeGeneration;
	if (
		backend.kind !== "remote" ||
		(input.deviceId && input.deviceId !== workspace.deviceId) ||
		backend.pathFlavor !== workspace.pathFlavor
	)
		throw new EditorDocumentError(
			"EDITOR_IDENTITY_CHANGED",
			"Editor target is not the current remote workspace",
			403,
		);
	const lexicalPath = backend.paths.resolve(workspace.cwd, input.path);
	if (!backend.paths.contains(workspace.cwd, lexicalPath))
		throw new EditorDocumentError(
			"EDITOR_WRITE_REFUSED",
			"Remote editor path is outside its workspace",
			403,
		);
	await options.authorizationGuard(need);
	const path = await backend.resolvePathIdentity(lexicalPath, { signal, timeoutMs: 5_000 });
	if (
		path.runtimeGeneration !== generation ||
		!backend.paths.contains(workspace.cwd, path.canonicalPath) ||
		!backend.paths.equals(path.lexicalPath, path.canonicalPath)
	)
		throw new EditorDocumentError(
			"EDITOR_IDENTITY_CHANGED",
			"Remote editor symlink or canonical identity changed",
			403,
		);
	const stat = await backend.statFile(path.canonicalPath, { signal, timeoutMs: 5_000 });
	if (stat && !stat.isFile)
		throw new EditorDocumentError(
			"EDITOR_WRITE_REFUSED",
			"Remote editor requires a regular non-symlink file",
			403,
		);
	const readAccess = createNarratorWorkspaceAttachmentSourceAccess(
		actor.narratorId,
		workspace,
		path.canonicalPath,
		{
			userId: actor.userId,
			signal,
			authorizationGuard: () => options.authorizationGuard("read"),
		},
	);
	await readAccess.authorizeRead(path.canonicalPath, readAccess.backend, signal);
	const writeAccess = createNarratorWorkspaceAttachmentAccess(actor.narratorId, workspace, {
		userId: actor.userId,
		signal,
		authorizationGuard: () => options.authorizationGuard("write"),
	});
	let editable = true;
	let readOnlyReason: string | undefined;
	try {
		await writeAccess.authorizeWrite(path.canonicalPath, writeAccess.backend, signal);
	} catch (error) {
		if (need === "write" || !(error instanceof AppError) || error.statusCode !== 403) throw error;
		editable = false;
		readOnlyReason = error.message;
	}
	const binding: EditorBinding = {
		deviceId: workspace.deviceId,
		cwd: workspace.cwd,
		projectId: workspace.contextProjectId ?? null,
		lexicalPath,
		canonicalPath: path.canonicalPath,
		outsideRoots: false,
		workspaceRevision: workspace.revision,
		contextKey: workspace.contextKey,
		runtimeGeneration: generation,
		canonicalIdentity: path.canonicalPath,
		editable,
		readOnlyReason,
	};
	if (!backend.supportsRemoteHistory || !backend.remoteHistory)
		throw new EditorDocumentError(
			"EDITOR_REMOTE_UPGRADE_REQUIRED",
			"Executor upgrade required: history.v1 for journaled human editing",
			422,
		);
	const root = await resolveRemoteEditorRoot(actor, binding, signal);
	if (!root.rootIdentity || !Number.isSafeInteger(root.maxWriteBytes) || root.maxWriteBytes <= 0)
		throw new EditorDocumentError(
			"EDITOR_REMOTE_UNSUPPORTED",
			"Remote editor capability is not backed by a valid history endpoint",
			422,
		);
	binding.rootIdentity = root.rootIdentity;
	if (stat && stat.size > root.maxWriteBytes) {
		binding.editable = false;
		binding.readOnlyReason = "Executor upgrade required for chunked remote editor saves";
		if (need === "write")
			throw new EditorDocumentError("EDITOR_REMOTE_WRITE_TOO_LARGE", binding.readOnlyReason, 413);
	}
	await options.authorizationGuard(need);
	const live = resolveBackend({ requested: workspace.deviceId });
	const final = await backend.resolvePathIdentity(lexicalPath, { signal, timeoutMs: 5_000 });
	if (
		live.runtimeGeneration !== generation ||
		final.runtimeGeneration !== generation ||
		!backend.paths.equals(final.canonicalPath, path.canonicalPath)
	)
		throw new EditorDocumentError(
			"EDITOR_IDENTITY_CHANGED",
			"Remote editor endpoint changed during authorization",
			403,
		);
	return Object.freeze(binding);
}

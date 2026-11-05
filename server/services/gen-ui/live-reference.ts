/**
 * A `render({path})` app has to draw before its tool result exists: the call is what waits
 * for the reader, so the card cannot depend on the result. The browser therefore asks for
 * a preview while the call is still running, and the only thing available then is the
 * call's own arguments.
 *
 * That keeps the existing rule intact — no client-chosen paths — because the resolved
 * directory must still sit inside this workspace's GenUI directory. Anything else is
 * refused, so a live preview can never widen what `show`/`render` may reach.
 */
import { resolveBackend } from "@server/lib/agent/execution/registry";
import { GEN_UI_DIRECTORY, GEN_UI_ENTRY, type GenUiFileReference } from "@shared/gen-ui-files";
import {
	assertReferenceWorkspace,
	uiError,
	validateDirectory,
	workspaceKey,
	workspaceRoot,
} from "./files";

const TIMEOUT_MS = 10_000;

export async function resolveLiveGenUiReference(options: {
	narratorId: string;
	toolUseId: string;
	toolCallId: string;
	appPath: string;
}): Promise<GenUiFileReference> {
	const signal = AbortSignal.timeout(TIMEOUT_MS);
	const { workspaceContextService } = await import("@server/services/workspace-context-service");
	const workspace = structuredClone(await workspaceContextService.get(options.narratorId));
	signal.throwIfAborted();
	const backend = resolveBackend({ requested: workspace.deviceId });
	const root = await workspaceRoot(backend, workspace, signal);
	const uiRoot = backend.paths.resolve(root, GEN_UI_DIRECTORY);
	const { directory } = await validateDirectory(backend, workspace, options.appPath, signal);
	if (!backend.paths.contains(uiRoot, directory))
		throw uiError("A live app preview must stay inside the GenUI directory", 403);
	const reference: GenUiFileReference = {
		version: 1,
		toolUseId: options.toolUseId,
		toolCallId: options.toolCallId,
		deviceId: backend.deviceId,
		workspaceKey: workspaceKey(workspace),
		cwd: workspace.cwd,
		directory,
		entry: GEN_UI_ENTRY,
		title: backend.paths.basename(directory),
	};
	assertReferenceWorkspace(reference, workspace, backend);
	return reference;
}

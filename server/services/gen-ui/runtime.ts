import type { ExecutionBackend } from "@server/lib/agent/execution/backend";
import { getToolBackend } from "@server/lib/agent/execution/tool-backend";
import type { GenUiInput } from "@server/lib/agent/tools/gen-ui";
import type { ToolContext, ToolResult } from "@server/lib/agent/types";
import { generateId } from "@server/lib/id";
import { createExecutionTargetContext } from "@server/services/execution-policy/target-context";
import { LocalFileValidationError } from "@server/services/file-change-local-io";
import {
	assertLocalFileChangeAdmission,
	boundedFileHistory,
	executeLocalFileChange,
	type LocalFileChangeRequest,
	withFileHistoryNotice,
} from "@server/services/file-change-runtime";
import { withFileWrite } from "@server/services/file-write-queue";
import { GEN_UI_DIRECTORY, GEN_UI_ENTRY, type GenUiFileReference } from "@shared/gen-ui-files";
import { checkedIdentity, uiError, validateDirectory, workspaceKey, workspaceRoot } from "./files";
import { executeKitAction, type KitToolEnvironment, kitNoticeFor } from "./kit-runtime";

const TEMPLATE = `import { useState } from "react";
import { Button, Stack, Text, Title } from "@mantine/core";

export default function App() {
	const [count, setCount] = useState(0);
	return (
		<Stack p="md">
			<Title order={2}>GenUI</Title>
			<Text>Edit App.tsx, then show this directory again.</Text>
			<Button onClick={() => setCount(count + 1)}>Clicked {count} times</Button>
		</Stack>
	);
}
`;

export interface UiToolDependencies {
	nextId(): string;
	authorizeWrite(ctx: ToolContext, backend: ExecutionBackend, path: string): Promise<void>;
	authorizeRead(ctx: ToolContext, backend: ExecutionBackend, path: string): Promise<void>;
	admitCreate: typeof assertLocalFileChangeAdmission;
	change(request: LocalFileChangeRequest): Promise<ToolResult | undefined>;
	snapshot(ctx: ToolContext, backend: ExecutionBackend, path: string): Promise<void>;
	track(
		ctx: ToolContext,
		backend: ExecutionBackend,
		path: string,
		evidenceRecorded: boolean,
	): Promise<void>;
}
const defaults: UiToolDependencies = {
	nextId: generateId,
	admitCreate: assertLocalFileChangeAdmission,
	change: executeLocalFileChange,
	async authorizeWrite(ctx, backend, path) {
		const { executionPolicyEngine } = await import("@server/services/execution-policy/engine");
		const context = await createExecutionTargetContext({
			backend,
			target: {
				deviceId: backend.deviceId,
				backendKind: backend.kind,
				cwd: ctx.workspaceContext?.cwd ?? ctx.cwd,
				lexicalPath: path,
				canonicalPath: path,
				runtimeGeneration: ctx.executionTarget?.runtimeGeneration,
				selectionSource: "explicit",
			},
		});
		const policy = await executionPolicyEngine.compile(ctx.narratorId, context);
		if (policy.evaluatePath({ path, operation: "full" }).decision === "deny")
			throw uiError("File policy denies UI creation", 403);
	},
	async authorizeRead(ctx, backend, path) {
		const { fileReferenceService } = await import("@server/services/file-reference-service");
		const [target] = await fileReferenceService.resolveFileReferences(
			ctx.narratorId,
			ctx.userId ?? "",
			[{ deviceId: backend.deviceId, path }],
			ctx.signal,
		);
		if (!target || !backend.paths.equals(target.path, path))
			throw uiError("Read authorization identity changed", 409);
	},
	async snapshot(ctx, backend, path) {
		const { ensureFileSnapshot } = await import("@server/services/file-snapshot-service");
		await ensureFileSnapshot(
			ctx.narratorId,
			backend.deviceId,
			path,
			async () => ({ content: null, encoding: "utf-8", isBinary: false }),
			"required",
		);
	},
	async track(ctx, backend, path, evidenceRecorded) {
		const { trackFileChange } = await import("@server/lib/agent/tools/track-file-change");
		await trackFileChange(
			ctx,
			path,
			"write",
			backend,
			evidenceRecorded ? null : { added: TEMPLATE.split("\n").length - 1, removed: 0 },
			{ evidenceRecorded },
		);
	},
};

export async function executeGenUiTool(
	input: GenUiInput,
	ctx: ToolContext,
	dependencies: Partial<UiToolDependencies> = {},
): Promise<ToolResult> {
	const deps = { ...defaults, ...dependencies };
	const workspace = ctx.workspaceContext ? structuredClone(ctx.workspaceContext) : undefined;
	if (
		!ctx.userId ||
		!workspace ||
		!ctx.executionTarget ||
		!ctx.currentToolUseId ||
		!ctx.toolCallBinding
	)
		throw uiError("UI requires a frozen workspace and persistent tool identity", 409);
	const liveContext = ctx;
	const backend = getToolBackend(ctx);
	const target = Object.freeze({ ...ctx.executionTarget });
	const binding = Object.freeze({ ...ctx.toolCallBinding });
	const toolUseId = ctx.currentToolUseId;
	ctx = {
		...ctx,
		toolCallBinding: binding,
		executionTarget: target,
		workspaceContext: workspace,
		signal:
			input.action === "create"
				? AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)])
				: ctx.signal,
	};
	const check = async () => {
		ctx.signal.throwIfAborted();
		ctx.assertWorkspaceCurrent?.();
		await ctx.recheckAuthorization?.();
		await createExecutionTargetContext({ backend, target });
		if (liveContext.workspaceContext?.revision !== workspace.revision)
			throw uiError("Workspace changed during UI tool execution", 409);
		ctx.signal.throwIfAborted();
		ctx.assertFinalExecutionPermission?.();
	};
	await check();
	const kitEnvironment: KitToolEnvironment = {
		ctx,
		backend,
		workspace,
		check,
		authorizeRead: (path) => deps.authorizeRead(ctx, backend, path),
		authorizeWrite: (path) => deps.authorizeWrite(ctx, backend, path),
	};
	if (input.action === "inspect") {
		const { inspectGenUi } = await import("./inspect");
		return inspectGenUi(input, kitEnvironment);
	}
	if (input.action === "render" || input.action === "kit_status" || input.action === "kit_build")
		return executeKitAction(input, kitEnvironment);
	let directory: string;
	let fileMetadata: ToolResult["metadata"];
	if (input.action === "show") {
		const valid = await validateDirectory(backend, workspace, input.path, ctx.signal);
		directory = valid.directory;
		await deps.authorizeRead(ctx, backend, valid.entryPath);
	} else {
		if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,47}$/u.test(input.prefix))
			throw uiError("Invalid UI directory prefix", 400);
		if (!backend.mkdirExclusive)
			throw uiError(
				"Execution device needs an upgrade for exclusive directory creation; no local fallback",
			);
		const root = await workspaceRoot(backend, workspace, ctx.signal);
		const base = backend.paths.resolve(root, GEN_UI_DIRECTORY);
		if (
			!target.lexicalPath ||
			!target.canonicalPath ||
			!backend.paths.equals(base, target.lexicalPath) ||
			!backend.paths.equals(base, target.canonicalPath)
		)
			throw uiError("UI creation target differs from its frozen workspace", 409);
		// Validate the real persisted tool attempt before even allocating directories.
		await deps.admitCreate({ ctx, backend, toolName: "GenUI", filePath: base });
		for (const parent of [backend.paths.dirname(base), base]) {
			await checkedIdentity(backend, parent, ctx.signal);
			await deps.authorizeWrite(ctx, backend, parent);
			await check();
			await backend.mkdirExclusive(parent, { expectedResolvedPath: parent, signal: ctx.signal });
			if (!(await backend.statFile(parent, { signal: ctx.signal }))?.isDirectory)
				throw uiError("UI parent is not a directory");
		}
		directory = "";
		for (let attempt = 0; attempt < 8; attempt++) {
			const suffix = deps.nextId();
			if (!/^[A-Za-z0-9_-]{1,64}$/.test(suffix))
				throw uiError("Invalid generated directory identifier");
			const candidate = backend.paths.resolve(base, `${input.prefix}-${suffix}`);
			await checkedIdentity(backend, candidate, ctx.signal);
			await deps.authorizeWrite(ctx, backend, candidate);
			await check();
			if (
				await backend.mkdirExclusive(candidate, {
					expectedResolvedPath: candidate,
					signal: ctx.signal,
				})
			) {
				directory = candidate;
				break;
			}
		}
		if (!directory) throw uiError("Could not allocate a unique UI directory; retry", 409);
		const entry = backend.paths.resolve(directory, GEN_UI_ENTRY);
		await checkedIdentity(backend, entry, ctx.signal);
		await deps.authorizeWrite(ctx, backend, entry);
		await check();
		const recorded = await deps.change({
			ctx,
			backend,
			toolName: "GenUI",
			filePath: entry,
			exclusiveCreate: true,
			input,
			construct(before) {
				if (before.bytes !== null)
					throw new LocalFileValidationError("UI entry already exists; refusing overwrite");
				return {
					nextBytes: new TextEncoder().encode(TEMPLATE),
					lineStats: { added: TEMPLATE.split("\n").length - 1, removed: 0 },
					result: { output: `Created ${entry}` },
				};
			},
		});
		if (recorded) {
			fileMetadata = recorded.metadata;
		} else {
			if (backend.kind === "local")
				throw uiError("UI creation requires a bound local file-change journal", 409);
			// Same explicit compatibility boundary as remote Write/Edit: no v2
			// journal or exact rollback capability is claimed for this backend.
			await withFileWrite(
				{
					deviceId: backend.deviceId,
					pathFlavor: backend.pathFlavor as "posix" | "windows",
					canonicalPath: entry,
				},
				async () => {
					await boundedFileHistory(() => deps.snapshot(ctx, backend, entry)).catch(() => {});
					await check();
					await backend.writeFileBytes(entry, new TextEncoder().encode(TEMPLATE), {
						expectedResolvedPath: entry,
						exclusive: true,
						signal: ctx.signal,
						timeoutMs: 30_000,
					});
				},
				{ signal: ctx.signal },
			);
			fileMetadata = {
				diskOutcome: "applied",
				historyStatus: "unavailable",
				fileChangeHistoryUnavailable: true,
				fileChangeHistoryReason: "remote_journal_unsupported",
			};
		}
		try {
			await deps.track(ctx, backend, entry, Boolean(recorded));
		} catch {
			fileMetadata = { ...fileMetadata, historyStatus: "unavailable" };
		}
	}
	if (input.action === "show") await check();
	// Which kit the preview will compile against, and whether the user is being asked
	// to build one. Advisory: a kit problem must never fail a file preview.
	const kitNotice = await kitNoticeFor(kitEnvironment);
	const reference: GenUiFileReference = {
		version: 1,
		toolUseId,
		toolCallId: binding.toolCallId,
		deviceId: backend.deviceId,
		workspaceKey: workspaceKey(workspace),
		cwd: workspace.cwd,
		directory,
		entry: GEN_UI_ENTRY,
		title: backend.paths.basename(directory),
	};
	return withFileHistoryNotice(
		{
			output:
				input.action === "create"
					? `Created ${directory}/App.tsx. Edit it using ordinary file tools, then show this directory. The user sees nothing until you show it.`
					: `Shown: ${directory}/App.tsx. The user's browser builds the app from the files on disk when the card displays it, and runs it in the chat: build errors appear in the card and are not reported to you, and later edits change what a reopened card shows. Only the latest app starts by itself; an older one waits for the user to click Run. Calls to genUI.sendPrompt / submit / openLink reach you only after the user confirms them. \nInspect: ${JSON.stringify({ action: "inspect", toolUseId, toolCallId: binding.toolCallId })}`,
			title: reference.title,
			metadata: {
				...fileMetadata,
				genUi: reference,
				...(input.action === "show"
					? {
							genUiShow: {
								version: 1,
								shownAt: new Date().toISOString(),
								size: input.size ?? "md",
							},
						}
					: {}),
				...(kitNotice ? { genUiKit: kitNotice } : {}),
			},
		},
		ctx.locale,
	);
}

import { afterEach, describe, expect, mock, test } from "bun:test";
import { isSpecUri, normalizeSpecPath } from "../../../spec-uri";
import type { ToolContext, ToolDefinition } from "../../types";

// No database connection or filesystem write is needed for this boundary regression.
const databaseAccess = mock(() => {
	throw new Error("Unexpected database access");
});
mock.module("../../../../db", () => ({
	activeDatabaseBackend: "sqlite",
	db: new Proxy({}, { get: databaseAccess }),
}));
const scope = mock(() => {
	throw new Error("Unexpected physical write scope");
});
const dispatchControl = mock(() => {});
mock.module("../../../../services/file-change-runtime", () => ({
	executeLocalFileChange: scope,
	// The wrapper is registered at import time. Observe its control-flow markers,
	// not a physical runtime; every actual dispatch remains a fail-fast mock.
	withFileToolNoDispatch:
		(
			_name: string,
			body: (
				args: Record<string, unknown>,
				ctx: ToolContext,
				flow: {
					writing: () => void;
					declined: () => void;
					preview: () => void;
					suppressEvidence: () => void;
				},
			) => Promise<import("../../types").ToolResult>,
		) =>
		(args: Record<string, unknown>, ctx: ToolContext) =>
			body(args, ctx, {
				writing: dispatchControl,
				declined: dispatchControl,
				preview: dispatchControl,
				suppressEvidence: dispatchControl,
			}),
	registerLocalBashActivity: scope,
	FileNoDispatchEvidenceError: class extends Error {},
}));
mock.module("../../../../services/file-snapshot-service", () => ({ ensureFileSnapshot: scope }));
mock.module("../../../../services/spec-broadcast", () => ({
	broadcastSpecChanged: mock(() => {}),
}));
const consumeGrant = mock(() => true);
mock.module("../task-reflection", () => ({ consumeTaskReflectionGrant: consumeGrant }));
const docs = new Map<string, string>();
const virtualFile = (uri: string) => ({
	uri,
	path: normalizeSpecPath(uri),
	content: docs.get(uri) ?? "old text",
	readonly: false,
	builtin: false,
});
const readSpec = mock(async (_id: string, uri: string) => virtualFile(uri));
const writeSpec = mock(async (_id: string, uri: string, content: string) => {
	docs.set(uri, content);
	return virtualFile(uri);
});
const listSpec = mock(async () => [...docs.keys()].map(virtualFile));
mock.module("../../../../services/spec-vfs-service", () => ({
	specVfsService: {
		isSpecUri,
		normalizeSpecPath,
		readSpecFile: readSpec,
		writeSpecFile: writeSpec,
		listSpecFiles: listSpec,
	},
}));
const { readTool } = await import("../read");
const { writeTool } = await import("../write");
const { editTool } = await import("../edit");
const { grepTool } = await import("../grep");
const { globTool } = await import("../glob");
const { structViewTool } = await import("../struct-view/tool");
const { structSedTool } = await import("../struct-sed/tool");
const { grantBehaviorFenceEdit, hasBehaviorFenceEditGrant, clearBehaviorFenceEditGrant } =
	await import("../behavior-fence-grant");
const { setRemoteBackendResolver } = await import("../../execution/registry");
const backendResolution = mock(() => {
	throw new Error("Unexpected backend resolution");
});
const contextAccess = mock(() => {
	throw new Error("Unexpected IO/context access");
});
const ctx = {
	narratorId: "spec-boundary-test",
	currentToolUseId: "spec-boundary-call",
	cwd: "/unused",
	defaultDeviceId: "remote-test",
	signal: new AbortController().signal,
	get executionBackend() {
		return contextAccess();
	},
	get executionTarget() {
		return contextAccess();
	},
	requestPermission: contextAccess,
} as unknown as ToolContext;

const tools: Array<[ToolDefinition, string]> = [
	[readTool, "file_path"],
	[writeTool, "file_path"],
	[editTool, "file_path"],
	[grepTool, "path"],
	[globTool, "path"],
	[structViewTool, "file_path"],
	[structSedTool, "file_path"],
];
const invalid = [
	"/spec://tasks.json",
	"spec:/tasks.json",
	"C:\\spec://tasks.json",
	" ./spec://tasks.json",
	"spec://notes/../tasks.json",
	"spec://notes\\tasks.json",
	"spec://%2e%2e/tasks.json",
];

afterEach(() => {
	setRemoteBackendResolver(null);
	clearBehaviorFenceEditGrant(ctx.narratorId);
	for (const fn of [
		scope,
		dispatchControl,
		databaseAccess,
		consumeGrant,
		readSpec,
		writeSpec,
		listSpec,
		backendResolution,
		contextAccess,
	])
		fn.mockClear();
	docs.clear();
});

describe("direct file tools reject reserved Spec spelling before any effect", () => {
	for (const [tool, field] of tools) {
		test(`${tool.name}: malformed paths never resolve, consume grants, access VFS or take a write scope`, async () => {
			setRemoteBackendResolver(backendResolution);
			for (const path of invalid) {
				const result = await tool.execute(
					{
						[field]: path,
						device: "remote-test",
						content: "new",
						old_string: "",
						new_string: "new",
						pattern: "needle",
						dry_run: false,
					},
					ctx,
				);
				expect(result.isError).toBe(true);
				expect(result.output).toContain("spec://");
			}
			for (const fn of [
				scope,
				dispatchControl,
				databaseAccess,
				consumeGrant,
				readSpec,
				writeSpec,
				listSpec,
				backendResolution,
				contextAccess,
			])
				expect(fn).not.toHaveBeenCalled();
		});
	}

	test("unsupported tools reject canonical Spec including Glob patterns", async () => {
		for (const [tool, field] of tools.filter(([tool]) =>
			["Glob", "StructView", "StructSed"].includes(tool.name),
		)) {
			const result = await tool.execute(
				{ [field]: "spec://tasks.json", pattern: "*", dry_run: false },
				ctx,
			);
			expect(result.isError).toBe(true);
			expect(result.output).toContain("not support");
		}
		expect((await globTool.execute({ pattern: "spec://*" }, ctx)).isError).toBe(true);
		expect(contextAccess).not.toHaveBeenCalled();
		expect(scope).not.toHaveBeenCalled();
	});

	test("malformed fence writes leave both grants untouched", async () => {
		grantBehaviorFenceEdit(ctx.narratorId);
		for (const tool of [writeTool, editTool]) {
			const result = await tool.execute(
				{ file_path: " spec://behavior_fence", content: "new", old_string: "", new_string: "new" },
				ctx,
			);
			expect(result.isError).toBe(true);
		}
		expect(hasBehaviorFenceEditGrant(ctx.narratorId)).toBe(true);
		expect(consumeGrant).not.toHaveBeenCalled();
	});

	test("valid Read/Write/Edit/Grep remain virtual even with a remote session", async () => {
		setRemoteBackendResolver(backendResolution);
		const input = { file_path: "spec://notes.md" };
		expect(
			(await writeTool.execute({ ...input, content: "needle old text" }, ctx)).isError,
		).toBeFalsy();
		expect((await readTool.execute(input, ctx)).output).toContain("needle old text");
		expect(
			(await editTool.execute({ ...input, old_string: "old", new_string: "new" }, ctx)).isError,
		).toBeFalsy();
		const result = await grepTool.execute(
			{ path: "spec://", pattern: "needle", output_mode: "content" },
			ctx,
		);
		expect(result.output).toContain("needle new text");
		expect(result.output).toContain("spec://notes.md");
		expect(backendResolution).not.toHaveBeenCalled();
		expect(scope).not.toHaveBeenCalled();
		expect(databaseAccess).not.toHaveBeenCalled();
	});
});

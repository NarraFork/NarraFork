import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { WorkspaceContext } from "@shared/workspace-context";
import type { ExecutionBackend } from "../../lib/agent/execution/backend";
import { posixPathSemantics } from "../../lib/agent/execution/path-semantics";
import type { TextFileRef, WorkspaceAttachmentAccess } from "../../lib/uploads";

const workspace: WorkspaceContext = {
	deviceId: "remote-selected",
	cwd: "/selected/repo",
	pathFlavor: "posix",
	revision: 5,
	contextKey: "selected-5",
	capabilities: { switchDirectory: true },
};
const identity = mock(async (path: string) => ({
	lexicalPath: path,
	canonicalPath: path,
	exists: true,
	runtimeGeneration: 3,
}));
const backend = {
	kind: "remote",
	deviceId: "remote-selected",
	paths: posixPathSemantics,
	pathFlavor: "posix",
	runtimeGeneration: 3,
	defaultCwd: "/decoy",
	resolvePathIdentity: identity,
	statFile: async () => ({ isFile: true, isDirectory: false, size: 6 }),
} as unknown as ExecutionBackend;
const writes = mock(async () => true);
const reads = mock(async () => true);
const accessFactory = mock(
	(
		_id: string,
		binding: WorkspaceContext,
		options: { userId?: string | null; signal?: AbortSignal },
	) =>
		({
			backend,
			workspaceContext: binding,
			signal: options.signal,
			authorizeWrite: writes,
		}) satisfies WorkspaceAttachmentAccess,
);
const sourceFactory = mock(
	(
		_id: string,
		binding: WorkspaceContext,
		_path: string,
		options: { userId?: string | null; signal?: AbortSignal },
	) => ({ backend, workspaceContext: binding, signal: options.signal, authorizeRead: reads }),
);
const committedContext = mock(async () => workspace);
mock.module("../workspace-context-service", () => ({
	workspaceContextService: { get: committedContext },
}));
mock.module("../workspace-artifact-access", () => ({
	createNarratorWorkspaceAttachmentAccess: accessFactory,
	createNarratorWorkspaceAttachmentSourceAccess: sourceFactory,
}));
const save = mock(
	async (cwd: string, file: File, access: WorkspaceAttachmentAccess): Promise<TextFileRef> => ({
		filename: file.name,
		filePath: `${cwd}/.narrafork/attached/123456789012345678901/${file.name}`,
		size: file.size,
		deviceId: access.backend.deviceId,
		contextKey: access.workspaceContext.contextKey,
		attachmentId: "123456789012345678901",
	}),
);
const copy = mock(
	async (
		cwd: string,
		source: TextFileRef,
		access: WorkspaceAttachmentAccess,
	): Promise<TextFileRef> => ({
		...source,
		filePath: `${cwd}/.narrafork/attached/123456789012345678901/${source.filename}`,
		deviceId: access.backend.deviceId,
		contextKey: access.workspaceContext.contextKey,
		attachmentId: "123456789012345678901",
	}),
);
const cleanup = mock(
	async (_refs: readonly TextFileRef[], _access: WorkspaceAttachmentAccess) => {},
);
mock.module("../../lib/uploads", () => ({
	saveTextFileToWorktree: save,
	copyTextFileToWorktree: copy,
	deleteWorkspaceAttachmentFiles: cleanup,
}));
const {
	prepareNarratorTextAttachmentAccess,
	saveAcceptedNarratorTextFiles,
	textAttachmentBlock,
	textAttachmentRef,
	textAttachmentKey,
	prepareRetainedNarratorTextFile,
	copyRetainedNarratorTextFile,
	buildNarratorTextAttachmentHint,
} = await import("../narrator-text-attachments");
afterEach(() => {
	for (const fn of [
		accessFactory,
		sourceFactory,
		committedContext,
		save,
		copy,
		cleanup,
		reads,
		writes,
		identity,
	])
		fn.mockClear();
});

describe("production text attachment paths", () => {
	for (const actor of ["direct-user", "buffer-created-by", "edit-user"])
		test(`${actor}: uses actual actor + frozen selected context + guarded save`, async () => {
			const access = await prepareNarratorTextAttachmentAccess("narrator", {
				userId: actor,
				workspaceContext: workspace,
			});
			const refs = await saveAcceptedNarratorTextFiles(
				"narrator",
				[new File(["hello"], "notes.txt")],
				access,
			);
			expect(accessFactory.mock.calls[0][2].userId).toBe(actor);
			expect(Object.isFrozen(accessFactory.mock.calls[0][1])).toBe(true);
			expect(save.mock.calls[0][0]).toBe("/selected/repo");
			expect(save.mock.calls[0][2]).toBe(access);
			expect(textAttachmentBlock(refs[0])).toMatchObject({
				type: "text_file",
				deviceId: "remote-selected",
				contextKey: "selected-5",
				attachmentId: "123456789012345678901",
				sourceNarratorId: "narrator",
				attachmentWorkspace: workspace,
			});
			expect(committedContext).not.toHaveBeenCalled();
		});
	test("idle feed, buffered consumption and edit declarations all consume the guarded production helper", () => {
		const session = readFileSync(new URL("../narrator-session.ts", import.meta.url), "utf8");
		const feed = session.slice(
			session.indexOf("async function feedMessageUnlocked("),
			session.indexOf("export async function getSubagentFinalText"),
		);
		const edit = session.slice(
			session.indexOf("async function editAndRegenerateUnlocked("),
			session.indexOf("function buildEditedAssistantContentJson"),
		);
		const orchestrator = readFileSync(
			new URL("../agent-runtime/orchestrator.ts", import.meta.url),
			"utf8",
		);
		const buffer = orchestrator.slice(
			orchestrator.indexOf("// The claimed human input's actor"),
			orchestrator.indexOf(
				"const userMsg = await persistClaimedUserInput",
				orchestrator.indexOf("// The claimed human input's actor"),
			),
		);
		for (const body of [feed, edit, buffer]) {
			expect(body).toContain("prepareNarratorTextAttachmentAccess");
			expect(body).toContain("saveAcceptedNarratorTextFiles");
			expect(body).not.toContain("saveTextFileToWorktree(active.cwd");
		}
		expect(feed).toContain("userId = accepted.createdBy");
		expect(buffer).toContain("userId: buffered.createdBy");
		expect(edit).toContain("userId: opts?.userId");
		expect(feed).toContain("textPersistenceStarted");
		expect(edit).toContain("textCopyOnWriteStarted");
	});
	test("missing active context gets committed workspace rather than host cwd", async () => {
		const access = await prepareNarratorTextAttachmentAccess("narrator", { userId: "user" });
		expect(access.workspaceContext.cwd).toBe("/selected/repo");
		expect(committedContext).toHaveBeenCalledTimes(1);
	});
	test("unknown remote source is retained with a reason and never touches source IO", async () => {
		const target = await prepareNarratorTextAttachmentAccess("narrator", {
			userId: "user",
			workspaceContext: workspace,
		});
		const source: TextFileRef = {
			filename: "old.txt",
			filePath: "/original/old.txt",
			size: 6,
			deviceId: "other",
		};
		const retained = await prepareRetainedNarratorTextFile(source, target, {
			narratorId: "narrator",
			sourceNarratorId: "parent",
			userId: "user",
		});
		expect(retained.copy).toBe(false);
		expect(retained.ref.attachmentUnavailableReason).toContain("unknown");
		expect(sourceFactory).not.toHaveBeenCalled();
		expect(identity).not.toHaveBeenCalled();
		expect(buildNarratorTextAttachmentHint([retained.ref])).not.toContain("Use the Read tool");
	});
	test("known origin passes the original binding and source narrator, not an inferred root", async () => {
		const original = { ...workspace, cwd: "/original/repo", contextKey: "original-2", revision: 2 };
		const source: TextFileRef = {
			filename: "notes.txt",
			filePath: "/original/repo/notes.txt",
			size: 6,
			deviceId: "remote-selected",
			contextKey: "original-2",
			attachmentWorkspace: original,
			sourceNarratorId: "original-owner",
		};
		const target = await prepareNarratorTextAttachmentAccess("narrator", {
			userId: "user",
			workspaceContext: workspace,
		});
		const retained = await prepareRetainedNarratorTextFile(source, target, {
			narratorId: "narrator",
			sourceNarratorId: "ignored-fallback",
			userId: "user",
		});
		expect(retained.copy).toBe(true);
		expect(sourceFactory.mock.calls[0][0]).toBe("original-owner");
		expect(sourceFactory.mock.calls[0][1]).toEqual(original);
		const copied = await copyRetainedNarratorTextFile("narrator", retained, target);
		expect(copy.mock.calls[0][2].sourceAccess).toBe(retained.sourceAccess);
		expect(copied.attachmentWorkspace).toEqual(workspace);
	});
	test("metadata round-trip and identity preserve identical paths on different devices", () => {
		const source: TextFileRef = {
			filename: "notes.txt",
			filePath: "/same/notes.txt",
			size: 6,
			deviceId: workspace.deviceId,
			contextKey: workspace.contextKey,
			attachmentId: "123456789012345678901",
			attachmentWorkspace: workspace,
			sourceNarratorId: "owner",
		};
		expect(textAttachmentRef(textAttachmentBlock(source))).toEqual(source);
		expect(textAttachmentKey(source)).not.toBe(textAttachmentKey({ ...source, deviceId: "other" }));
		expect(buildNarratorTextAttachmentHint([source])).toContain('device "remote-selected"');
	});
});

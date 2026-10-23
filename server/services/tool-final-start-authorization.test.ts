import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
	narratorBlacklistDirs,
	narratorDeviceWorkspaceRequests,
	narratorDeviceWorkspaces,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	remoteDevices,
	users,
} from "../db/schema";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { posixPathSemantics } from "../lib/agent/execution/path-semantics";
import { localBackend, setRemoteBackendResolver } from "../lib/agent/execution/registry";
import { executeTool, freezeToolExecution } from "../lib/agent/tool-executor";
import { toolRegistry } from "../lib/agent/tool-registry";
import { bashTool } from "../lib/agent/tools/bash";
import { readTool } from "../lib/agent/tools/read";
import { writeTool } from "../lib/agent/tools/write";
import type { AgentConfig, AgentToolUse, ToolCallBinding, ToolContext } from "../lib/agent/types";
import { generateId } from "../lib/id";
import * as ws from "../websocket/narrator-ws";
import { executionPolicyEngine } from "./execution-policy/engine";
import { narratorDeviceWorkspaceService } from "./narrator-device-workspace-service";
import { handlePermission } from "./narrator-permission";
import { narratorPersistence, reconstructToolExecutionPlan } from "./narrator-persistence";
import { handleBashCommand } from "./narrator-service";
import * as state from "./narrator-session-state";
import { permissionPolicyChanges, permissionRuleService } from "./permission-rule-service";
import {
	buildFinalToolStartAuthorization,
	persistPermissionResolvedInput,
} from "./tool-final-start-authorization";
import { createDeviceWorkspaceConfig } from "./workspace-artifact-access";

const { db } = await import("../db");
toolRegistry.register(writeTool);
toolRegistry.register(bashTool);
toolRegistry.register(readTool);
let cwd: string, owner: string, parentId: string;
let actorIds: string[] = [],
	messageIds: string[] = [],
	callIds: string[] = [];
let writeSpy: ReturnType<typeof spyOn>, execSpy: ReturnType<typeof spyOn>;
const now = () => new Date().toISOString();
beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), "nf-final-start-"));
	owner = generateId();
	parentId = generateId();
	await db
		.insert(users)
		.values({ id: owner, username: owner, passwordHash: "fixture", createdAt: now() });
	await db.insert(narrators).values({
		id: parentId,
		title: "root",
		cwd,
		ownerUserId: owner,
		permissionMode: "bypassPermissions",
		createdAt: now(),
		updatedAt: now(),
	});
	actorIds = [parentId];
	messageIds = [];
	callIds = [];
	writeSpy = spyOn(localBackend, "writeFileBytes");
	execSpy = spyOn(localBackend, "execCommand");
});
afterEach(async () => {
	writeSpy.mockRestore();
	execSpy.mockRestore();
	for (const id of actorIds) executionPolicyEngine.invalidate(id);
	if (callIds.length)
		await db.delete(narratorToolCalls).where(inArray(narratorToolCalls.id, callIds));
	if (messageIds.length) {
		await db.delete(narratorMessageRefs).where(inArray(narratorMessageRefs.messageId, messageIds));
		await db.delete(narratorMessages).where(inArray(narratorMessages.id, messageIds));
	}
	for (const id of [...actorIds].reverse()) await db.delete(narrators).where(eq(narrators.id, id));
	await db.delete(users).where(eq(users.id, owner));
	await rm(cwd, { recursive: true, force: true });
});
async function actor(kind: "primary" | "subagent") {
	if (kind === "primary") return parentId;
	const id = generateId();
	actorIds.push(id);
	await db.insert(narrators).values({
		id,
		title: "child",
		cwd,
		type: "subagent",
		variant: "subagent:general",
		parentNarratorId: parentId,
		aclRootNarratorId: parentId,
		ownerUserId: owner,
		permissionMode: "bypassPermissions",
		createdAt: now(),
		updatedAt: now(),
	});
	return id;
}
async function fixture(
	kind: "primary" | "subagent",
	toolName: "Write" | "Bash" | "Read",
	explicitGuard = true,
) {
	const id = await actor(kind),
		messageId = generateId(),
		callId = generateId(),
		toolUseId = generateId();
	const output = join(cwd, "effect.txt");
	const input: Record<string, unknown> =
		toolName === "Write"
			? { file_path: output, content: "changed" }
			: toolName === "Read"
				? { file_path: output }
				: { command: "printf spawned > effect.txt", timeout: 2000 };
	const tu: AgentToolUse = { name: toolName, toolUseId, input };
	messageIds.push(messageId);
	callIds.push(callId);
	await db.insert(narratorMessages).values({
		id: messageId,
		narratorId: id,
		role: "assistant",
		contentJson: [{ type: "tool_use", id: toolUseId, name: toolName, input }],
		createdAt: now(),
	});
	await db
		.insert(narratorMessageRefs)
		.values({ id: generateId(), narratorId: id, messageId, seq: 1 });
	await db.insert(narratorToolCalls).values({
		id: callId,
		narratorId: id,
		messageId,
		toolUseId,
		toolName,
		inputJson: input,
		status: "initializing",
		executionAttempt: 1,
		executionIdentityVersion: 1,
		createdAt: now(),
	});
	const binding: ToolCallBinding = { toolCallId: callId, attempt: 1 };
	const signal = new AbortController().signal;
	const deviceConfig = await createDeviceWorkspaceConfig(id, { userId: owner, signal });
	const workspace = await deviceConfig.resolveDeviceWorkspace?.("local");
	if (!workspace) throw new Error("Fixture requires its real persisted local binding");
	const config: AgentConfig = {
		...deviceConfig,
		workspaceContext: workspace,
		narratorId: id,
		conversationId: generateId(),
		model: "test:model",
		provider: "test",
		cwd,
		userId: owner,
		signal,
		requireToolCallBinding: true,
		permissionHandler: (name, args, useId, options) =>
			handlePermission(
				id,
				config.signal,
				name,
				args,
				useId,
				cwd,
				"en",
				kind === "subagent" ? parentId : undefined,
				options,
			),
		onExecutionTargetResolved: (useId, target, receipt) =>
			narratorPersistence.updateToolCallExecutionTarget(id, useId, target, receipt),
		onExecutionPlanResolved: (useId, plan, receipt) =>
			narratorPersistence.updateToolCallExecutionPlan(id, useId, plan, receipt),
		onToolExecutionStarting: (useId, receipt, startedAt) =>
			narratorPersistence.claimToolCallExecution(id, useId, receipt, startedAt),
	};
	if (explicitGuard)
		config.onToolExecutionFinalAuthorization = buildFinalToolStartAuthorization(config);
	return { config, tu, binding, output, id, callId };
}
async function trackManualRows(narratorId: string) {
	const messages = await db
		.select({ id: narratorMessages.id })
		.from(narratorMessages)
		.where(eq(narratorMessages.narratorId, narratorId))
		.limit(16);
	for (const row of messages) if (!messageIds.includes(row.id)) messageIds.push(row.id);
	const calls = await db
		.select({ id: narratorToolCalls.id })
		.from(narratorToolCalls)
		.where(eq(narratorToolCalls.narratorId, narratorId))
		.limit(16);
	for (const row of calls) if (!callIds.includes(row.id)) callIds.push(row.id);
}

async function missing(path: string) {
	try {
		await access(path);
		return false;
	} catch {
		return true;
	}
}

// Only the awaited preparation hook is held. The permission handler, final-start
// policy service, SQLite rows/cache invalidation and Write/Bash implementations are real.
describe("real final-start policy after snapshot/slot waits", () => {
	test("a live narrator's naked ToolContext cannot borrow host cwd or device.defaultCwd without a guard marker", async () => {
		const f = await fixture("primary", "Bash");
		const stat = mock(async () => ({ isFile: true, isDirectory: false, size: 10 }));
		const read = mock(async () => ({
			bytes: Buffer.from("secret"),
			truncated: false,
			totalSize: 6,
		}));
		const rpc = mock(async () => ({
			lexicalPath: "/global/device/notes.txt",
			canonicalPath: "/global/device/notes.txt",
			runtimeGeneration: 1,
			exists: true,
		}));
		const remote = {
			kind: "remote",
			deviceId: "unbound-device",
			defaultCwd: "/global/device",
			paths: posixPathSemantics,
			pathFlavor: "posix",
			runtimeGeneration: 1,
			statFile: stat,
			readFileBytes: read,
			resolvePathIdentity: rpc,
		} as unknown as ExecutionBackend;
		for (const backend of [localBackend, remote]) {
			const naked: ToolContext = {
				narratorId: f.id,
				userId: owner,
				cwd,
				signal: f.config.signal,
				locale: "en",
				requestPermission: async () => ({ behavior: "allow" }),
				resolveBackend: () => backend,
			};
			expect(naked.assertWorkspaceCurrent).toBeUndefined();
			await expect(
				bashTool.execute({ command: "printf spawned > effect.txt" }, naked),
			).rejects.toThrow("WORKSPACE_DIRECTORY_NOT_CONFIGURED");
			await expect(readTool.execute({ file_path: "notes.txt" }, naked)).rejects.toThrow(
				"WORKSPACE_DIRECTORY_NOT_CONFIGURED",
			);
		}
		expect(execSpy).not.toHaveBeenCalled();
		expect(stat).not.toHaveBeenCalled();
		expect(read).not.toHaveBeenCalled();
		expect(rpc).not.toHaveBeenCalled();
		expect(await missing(f.output)).toBe(true);
	});

	for (const stage of ["unchanged", "permission", "executing-event"] as const)
		test(`qualified unbound endpoint loses real device authority at ${stage} and performs zero Read dispatch`, async () => {
			const f = await fixture("primary", "Read");
			const deviceId = generateId();
			await db.insert(remoteDevices).values({
				id: deviceId,
				name: "temporary-device",
				slug: deviceId,
				tokenHash: "fixture-only-hash",
				tokenPrefix: "fixture",
				scope: "global",
				ownerScope: "shared",
				createdBy: "another-owner",
				createdAt: now(),
				updatedAt: now(),
			});
			const read = mock(async () => ({
				bytes: Buffer.from("private"),
				totalSize: 7,
				truncated: false,
			}));
			const stat = mock(async () => ({ isFile: true, isDirectory: false, size: 7 }));
			const backend = {
				deviceId,
				kind: "remote",
				pathFlavor: "posix",
				paths: posixPathSemantics,
				runtimeGeneration: 3,
				defaultCwd: "/do-not-use-global",
				resolvePathIdentity: async (path: string) => ({
					lexicalPath: path,
					canonicalPath: path,
					exists: true,
					runtimeGeneration: 3,
				}),
				readFileBytes: read,
				statFile: stat,
			} as unknown as ExecutionBackend;
			setRemoteBackendResolver((id) => (id === deviceId ? backend : null));
			const devices = await import("./device-connection-service");
			const online = spyOn(devices, "isDeviceOnline").mockReturnValue(true);
			f.tu.input = { device: deviceId, file_path: "/temporary/private.txt" };
			await db
				.update(narratorToolCalls)
				.set({ inputJson: f.tu.input, inputChars: JSON.stringify(f.tu.input).length })
				.where(eq(narratorToolCalls.id, f.callId));
			f.config.availableDevices = [
				{ id: deviceId, name: "temporary-device", slug: deviceId, scope: "global", online: true },
			];
			const revoke = () =>
				db
					.update(remoteDevices)
					.set({ ownerScope: "private" })
					.where(eq(remoteDevices.id, deviceId))
					.run();
			const permission = f.config.permissionHandler;
			if (stage === "permission")
				f.config.permissionHandler = async (...args) => {
					const result = await permission(...args);
					revoke();
					return result;
				};
			else if (stage === "executing-event")
				f.config.onEvent = (event) => {
					if (event.type === "tool_executing") revoke();
				};
			try {
				const result = await executeTool(f.tu, f.config, { toolCallBinding: f.binding });
				if (stage === "unchanged") {
					expect(result.isError, result.output).not.toBe(true);
					expect(read).toHaveBeenCalledTimes(1);
				} else {
					expect(result.isError, result.output).toBe(true);
					expect(result.output).toContain("no longer authorized");
					expect(read).not.toHaveBeenCalled();
					expect(stat).not.toHaveBeenCalled();
				}
				expect(result.metadata?.executionWorkspace).toBeUndefined();
				expect(result.metadata?.executionTarget).toMatchObject({
					deviceId,
					cwd: "/temporary",
					canonicalPath: "/temporary/private.txt",
				});
			} finally {
				online.mockRestore();
				setRemoteBackendResolver(null);
				await db.delete(remoteDevices).where(eq(remoteDevices.id, deviceId));
			}
		});

	test("queued /new unchanged authorized local source can reach session creation", async () => {
		const f = await fixture("primary", "Write");
		const { enqueueBufferedMessage, getBufferedMessages, removeBufferedMessage } = await import(
			"./narrator-buffer"
		);
		const { executeQueuedNewCommand } = await import("./narrator-session");
		const { narratorService } = await import("./narrator-service");
		const admitted = await enqueueBufferedMessage(
			f.id,
			"/new inspect",
			undefined,
			"/new inspect",
			owner,
			null,
			[new File(["queued bytes"], "queued.txt")],
		);
		const create = spyOn(narratorService, "create").mockImplementation(async () => {
			throw new Error("Authorized creation reached");
		});
		try {
			const buffered = getBufferedMessages(f.id).find((message) => message.id === admitted.id);
			if (!buffered) throw new Error("Buffered input missing");
			const active = { narratorId: f.id, cwd, locale: "en" } as Parameters<
				typeof executeQueuedNewCommand
			>[0];
			await expect(executeQueuedNewCommand(active, buffered, "inspect")).rejects.toThrow(
				"Authorized creation reached",
			);
			expect(create).toHaveBeenCalledTimes(1);
		} finally {
			create.mockRestore();
			await removeBufferedMessage(f.id, admitted.id);
		}
	});

	for (const cause of ["directory-change", "revoked-authority"] as const)
		test(`queued /new attachments reject ${cause} before creating or forwarding a session`, async () => {
			const f = await fixture("primary", "Write");
			const { enqueueBufferedMessage, getBufferedMessages, removeBufferedMessage } = await import(
				"./narrator-buffer"
			);
			const { executeQueuedNewCommand } = await import("./narrator-session");
			const { narratorService } = await import("./narrator-service");
			const admitted = await enqueueBufferedMessage(
				f.id,
				"/new inspect",
				undefined,
				"/new inspect",
				owner,
				null,
				[new File(["queued bytes"], "queued.txt")],
			);
			const create = spyOn(narratorService, "create").mockImplementation(async () => {
				throw new Error("Unexpected session creation");
			});
			try {
				const buffered = getBufferedMessages(f.id).find((message) => message.id === admitted.id);
				if (!buffered) throw new Error("Buffered input missing");
				const selectedCwd = cause === "directory-change" ? join(cwd, "changed-directory") : cwd;
				if (cause === "revoked-authority")
					await db.update(narrators).set({ ownerUserId: null }).where(eq(narrators.id, f.id));
				const active = { narratorId: f.id, cwd: selectedCwd, locale: "en" } as Parameters<
					typeof executeQueuedNewCommand
				>[0];
				await expect(executeQueuedNewCommand(active, buffered, "inspect")).rejects.toThrow(
					"附件来源已变化，请在新会话中重新附加",
				);
				expect(create).not.toHaveBeenCalled();
				expect(writeSpy).not.toHaveBeenCalled();
			} finally {
				create.mockRestore();
				await removeBufferedMessage(f.id, admitted.id);
			}
		});

	test("subagent queued attachment rejects the original superseded directory instead of materializing in current cwd", async () => {
		const f = await fixture("subagent", "Bash");
		const { enqueueBufferedMessage, removeBufferedMessage } = await import("./narrator-buffer");
		const { consumeNextBufferedSubagentMessage } = await import("./subagent-executor");
		const source = f.config.workspaceContext;
		if (!source?.binding) throw new Error("Fixture source missing");
		const accepted = await enqueueBufferedMessage(
			f.id,
			"queued attachment",
			undefined,
			null,
			owner,
			null,
			[new File(["queued bytes"], "queued.txt")],
		);
		try {
			const newCwd = join(cwd, "new-directory");
			await mkdir(newCwd, { recursive: true });
			// Model persisted reconfiguration/recovery without invoking the specialized UI switch API.
			const { deviceWorkspaceBindingContext } = await import("./narrator-device-workspace-store");
			const { prepareWorkspaceContext } = await import("./workspace-context-service");
			const prepared = await prepareWorkspaceContext(
				{ deviceId: "local", cwd: newCwd },
				source.revision + 1,
				source.contextProjectId,
				{ narratorId: f.id, userId: owner },
			);
			const next = deviceWorkspaceBindingContext(
				f.id,
				source.binding.bindingId,
				source.binding.bindingRevision + 1,
				prepared,
			);
			await db
				.update(narratorDeviceWorkspaces)
				.set({ bindingRevision: next.binding.bindingRevision, cwd: newCwd, workspaceContext: next })
				.where(eq(narratorDeviceWorkspaces.id, next.binding.bindingId));
			await db
				.update(narrators)
				.set({ cwd: newCwd, workspaceContext: next, workspaceRevision: next.revision })
				.where(eq(narrators.id, f.id));
			await expect(
				consumeNextBufferedSubagentMessage({
					narratorId: f.id,
					parentNarratorId: parentId,
					toolUseId: f.tu.toolUseId,
					model: "test",
					provider: "anthropic",
					cwd: newCwd,
				}),
			).rejects.toThrow("binding identity changed");
			expect(writeSpy).not.toHaveBeenCalled();
		} finally {
			await trackManualRows(f.id);
			await removeBufferedMessage(f.id, accepted.id);
		}
	});

	test("queued attachment with a superseded binding fails rather than writing the new directory", async () => {
		const f = await fixture("primary", "Write");
		const { enqueueBufferedMessage, getBufferedMessages, removeBufferedMessage } = await import(
			"./narrator-buffer"
		);
		const { prepareNarratorTextAttachmentAccess, saveAcceptedNarratorTextFiles } = await import(
			"./narrator-text-attachments"
		);
		const accepted = await enqueueBufferedMessage(
			f.id,
			"queued attachment",
			undefined,
			null,
			owner,
			null,
			[new File(["original input"], "queued.txt")],
		);
		try {
			const buffered = getBufferedMessages(f.id).find((message) => message.id === accepted.id);
			if (!buffered?.attachmentWorkspace?.binding || !buffered.textFiles)
				throw new Error("Buffered source missing");
			const source = buffered.attachmentWorkspace;
			const binding = buffered.attachmentWorkspace.binding;
			await mkdir(join(cwd, "new-directory"), { recursive: true });
			await db
				.update(narratorDeviceWorkspaces)
				.set({ bindingRevision: binding.bindingRevision + 1, cwd: join(cwd, "new-directory") })
				.where(eq(narratorDeviceWorkspaces.id, binding.bindingId));
			const attachmentAccess = await prepareNarratorTextAttachmentAccess(f.id, {
				userId: owner,
				workspaceContext: source,
				requireWorkspaceSource: true,
			});
			await expect(
				saveAcceptedNarratorTextFiles(f.id, buffered.textFiles, attachmentAccess),
			).rejects.toThrow("binding identity changed");
			expect(writeSpy).not.toHaveBeenCalled();
		} finally {
			await removeBufferedMessage(f.id, accepted.id);
		}
	});

	test("actual manual /bash refuses a durable pending installation with zero execution", async () => {
		const f = await fixture("primary", "Bash");
		const workspace = f.config.workspaceContext;
		if (!workspace?.binding) throw new Error("Fixture workspace missing");
		await db
			.update(narrators)
			.set({ workspaceRevision: workspace.revision + 1 })
			.where(eq(narrators.id, f.id));
		const receiptId = generateId();
		await db.insert(narratorDeviceWorkspaceRequests).values({
			id: receiptId,
			narratorId: f.id,
			requestId: generateId(),
			actorUserId: owner,
			kind: "select",
			deviceId: workspace.deviceId,
			requestDigest: "fixture",
			expectedBindingRevision: workspace.binding.bindingRevision,
			expectedSelectionRevision: workspace.revision,
			installState: "pending",
			result: {
				kind: "select",
				changed: true,
				binding: {
					id: workspace.binding.bindingId,
					narratorId: f.id,
					deviceId: workspace.deviceId,
					bindingRevision: workspace.binding.bindingRevision,
					context: workspace,
					createdAt: now(),
					updatedAt: now(),
				},
			},
			createdAt: now(),
			updatedAt: now(),
		});
		try {
			const result = await handleBashCommand(
				f.id,
				"printf manual > effect.txt",
				"/bash printf manual > effect.txt",
				owner,
			);
			await trackManualRows(f.id);
			expect(result.isError, result.output).toBe(true);
			expect(result.output).toContain("waiting for installation");
			expect(execSpy).not.toHaveBeenCalled();
			expect(await missing(f.output)).toBe(true);
		} finally {
			await db
				.delete(narratorDeviceWorkspaceRequests)
				.where(eq(narratorDeviceWorkspaceRequests.id, receiptId));
		}
	});

	test("actual manual /bash uses the narrator binding and persists its exact executor metadata", async () => {
		const f = await fixture("primary", "Bash");
		const output = join(cwd, "manual-effect.txt");
		const result = await handleBashCommand(
			f.id,
			"printf manual > manual-effect.txt",
			"/bash printf manual > manual-effect.txt",
			owner,
		);
		await trackManualRows(f.id);
		expect(result.isError, result.output).toBe(false);
		expect(await readFile(output, "utf8")).toBe("manual");
		const row = await db.query.narratorToolCalls.findFirst({
			where: and(eq(narratorToolCalls.narratorId, f.id), eq(narratorToolCalls.status, "success")),
		});
		if (!row) throw new Error("Manual Bash receipt missing");
		const target = reconstructToolExecutionPlan(row)?.endpoints[0]?.target;
		expect(target?.workspaceBinding).toEqual(f.config.workspaceContext?.binding);
		expect(target?.cwd).toBe(cwd);
		expect(row.executionDeviceId).toBe("local");
		expect(row.executionAttempt).toBe(1);
		const metadata = (row.outputJson as { _metadata?: Record<string, unknown> } | null)?._metadata;
		expect(metadata?.executionWorkspace).toEqual(f.config.workspaceContext);
		expect(execSpy).toHaveBeenCalledTimes(1);
	});

	test("actual manual /bash cannot dispatch after a same-cwd binding change during permission compilation", async () => {
		const f = await fixture("primary", "Bash");
		const original = f.config.workspaceContext?.binding;
		if (!original) throw new Error("Manual fixture binding missing");
		const compile = executionPolicyEngine.compile.bind(executionPolicyEngine);
		let changed = false;
		const policy = spyOn(executionPolicyEngine, "compile").mockImplementation(async (...args) => {
			const compiled = await compile(...args);
			if (args[0] === f.id && !changed) {
				changed = true;
				await db
					.update(narratorDeviceWorkspaces)
					.set({ bindingRevision: original.bindingRevision + 1 })
					.where(eq(narratorDeviceWorkspaces.id, original.bindingId));
			}
			return compiled;
		});
		try {
			const result = await handleBashCommand(
				f.id,
				"printf manual > effect.txt",
				"/bash printf manual > effect.txt",
				owner,
			);
			await trackManualRows(f.id);
			expect(result.isError).toBe(true);
			expect(result.output).toContain("binding identity changed");
			expect(execSpy).not.toHaveBeenCalled();
			expect(await missing(f.output)).toBe(true);
		} finally {
			policy.mockRestore();
		}
	});

	for (const failure of ["stale-binding", "malformed-plan"] as const)
		test(`real denied retry ${failure} finalizes the fresh attempt, returns idle and releases all admission claims`, async () => {
			const f = await fixture("primary", "Write");
			f.config.toolExecutionBindings = new WeakMap([[f.tu, f.binding]]);
			await freezeToolExecution(f.tu, f.config);
			await db
				.update(narratorToolCalls)
				.set({
					status: "fail",
					permissionDecidedBy: "user",
					permissionDecidedAt: now(),
					errorMessage: "Permission denied by user",
				})
				.where(eq(narratorToolCalls.id, f.callId));
			let currentWorkspace = f.config.workspaceContext;
			if (!currentWorkspace?.binding) throw new Error("Retry fixture binding missing");
			if (failure === "stale-binding") {
				const replacement = join(cwd, "replacement");
				await mkdir(replacement);
				const switched = await narratorDeviceWorkspaceService.set(
					f.id,
					{
						requestId: generateId(),
						deviceId: "local",
						cwd: replacement,
						expectedBindingRevision: currentWorkspace.binding.bindingRevision,
						expectedSelectionRevision: currentWorkspace.revision,
					},
					{ userId: owner, origin: "http" },
				);
				currentWorkspace = switched.binding.context;
			} else {
				// A malformed but valid JSON legacy record cannot be represented by the typed producer.
				await db.run(
					sql`UPDATE narrator_tool_calls SET execution_targets_json = ${JSON.stringify({ kind: "multi", primaryKey: "primary", endpoints: null })} WHERE id = ${f.callId}`,
				);
			}
			const workspace = currentWorkspace;
			const prepare = narratorPersistence.prepareToolCallAttempt.bind(narratorPersistence);
			const allocate = spyOn(narratorPersistence, "prepareToolCallAttempt").mockImplementation(
				async (...args) => {
					const prepared = await prepare(...args);
					// Install only the non-provider live shell after real admission, COW and attempt allocation.
					state.activeNarrators.set(f.id, {
						narratorId: f.id,
						conversationId: "retry-test",
						cwd: workspace.cwd,
						model: "test:model",
						provider: "test",
						systemPrompt: null,
						events: new EventEmitter(),
						alive: true,
						locale: "en",
						abortController: new AbortController(),
						_workspaceContext: workspace,
						_defaultDeviceId: null,
						_currentUserId: owner,
						_enabledOptionalTools: new Set(),
						_disabledTools: new Set(),
						_blockedSkills: { all: false, names: new Set() },
						_substatus: new Set(),
					});
					return prepared;
				},
			);
			const events: Array<Parameters<typeof ws.broadcastToNarrator>[1]> = [];
			const broadcast = spyOn(ws, "broadcastToNarrator").mockImplementation((id, event) => {
				if (id === f.id) events.push(event);
			});
			try {
				const { reExecuteDeniedToolCall } = await import("./narrator-session");
				const result = await reExecuteDeniedToolCall(f.id, f.tu.toolUseId, "en", false, owner, {
					autoContinue: false,
				});
				expect(result.ok).toBe(true);
				await trackManualRows(f.id);
				const attempts = await db.query.narratorToolCalls.findMany({
					where: and(
						eq(narratorToolCalls.narratorId, f.id),
						eq(narratorToolCalls.toolUseId, f.tu.toolUseId),
					),
					orderBy: [desc(narratorToolCalls.executionAttempt)],
					limit: 3,
				});
				expect(attempts).toHaveLength(2);
				expect(attempts[0]).toMatchObject({ status: "fail", executionAttempt: 2 });
				expect(attempts[1]).toMatchObject({
					id: f.callId,
					status: "fail",
					executionAttempt: 1,
					errorMessage: "Permission denied by user",
				});
				const row = await db.query.narrators.findFirst({
					where: eq(narrators.id, f.id),
					columns: { status: true },
				});
				expect(row?.status).toBe("idle");
				expect(events).toContainEqual(
					expect.objectContaining({
						type: "tool_completed",
						status: "fail",
						toolCallId: attempts[0].id,
					}),
				);
				expect(state.isNarratorRuntimeBusy(f.id)).toBe(false);
				expect(state.hasNarratorRuntimeClaim(f.id)).toBe(false);
				expect(state.hasNarratorAdmissionWork(f.id)).toBe(false);
				expect(state.activeNarrators.has(f.id)).toBe(false);
				expect(writeSpy).not.toHaveBeenCalled();
				expect(await missing(f.output)).toBe(true);
			} finally {
				allocate.mockRestore();
				broadcast.mockRestore();
				state.activeNarrators.delete(f.id);
			}
		});

	for (const kind of ["primary", "subagent"] as const)
		for (const stage of ["preparation", "final-ticket"] as const) {
			test(`${kind}: direct DB same-cwd binding version change at ${stage} prevents real Write dispatch`, async () => {
				const f = await fixture(kind, "Write");
				const original = f.config.workspaceContext?.binding;
				if (!original) throw new Error("Expected an actual persisted binding reference");
				const change = async () => {
					await db
						.update(narratorDeviceWorkspaces)
						.set({ bindingRevision: original.bindingRevision + 1 })
						.where(eq(narratorDeviceWorkspaces.id, original.bindingId));
				};
				if (stage === "preparation") f.config.onToolExecutionBefore = change;
				else {
					const authorize = f.config.onToolExecutionFinalAuthorization;
					if (!authorize) throw new Error("Expected real final policy authorization");
					f.config.onToolExecutionFinalAuthorization = async (context) => {
						const ticket = await authorize(context);
						await change();
						return ticket;
					};
				}
				const result = await executeTool(f.tu, f.config, { toolCallBinding: f.binding });
				expect(result.isError).toBe(true);
				expect(result.output).toContain("binding identity changed");
				expect(writeSpy).not.toHaveBeenCalled();
				expect(await missing(f.output)).toBe(true);
				expect(result.metadata?.executionWorkspace).toEqual(f.config.workspaceContext);
			});
		}

	for (const mutated of ["reference", "context", "native-proof"] as const)
		test(`a same-cwd persisted endpoint ${mutated} cannot replace the original approved binding`, async () => {
			const f = await fixture("primary", "Write");
			f.config.onToolExecutionBefore = async () => {
				const row = await db.query.narratorToolCalls.findFirst({
					where: eq(narratorToolCalls.id, f.callId),
				});
				if (!row) throw new Error("Fixture tool receipt missing");
				const plan = reconstructToolExecutionPlan(row);
				const target = plan?.endpoints[0]?.target;
				if (!target?.workspaceBinding || !target.workspaceContext?.binding)
					throw new Error("Fixture persisted endpoint binding missing");
				if (mutated === "reference") target.workspaceBinding.bindingRevision++;
				else if (mutated === "context")
					target.workspaceContext.contextKey = "same-cwd-foreign-context";
				else
					target.nativeRootDescriptor = {
						version: 2,
						platform: "windows",
						pathSlotKey: "injected-root",
						componentKeys: ["injected-root"],
						volumeId: "v2",
						ancestors: [],
						parent: {
							canonicalPath: "C:\\injected",
							object: { volumeId: "v2", fileId: "root", creationTime: "1" },
							caseSensitive: true,
						},
						missingSuffix: [],
						object: { volumeId: "v2", fileId: "new-root", creationTime: "2" },
						caseSensitive: true,
					};
				await db
					.update(narratorToolCalls)
					.set({ executionTargetsJson: plan })
					.where(eq(narratorToolCalls.id, f.callId));
			};
			const result = await executeTool(f.tu, f.config, { toolCallBinding: f.binding });
			expect(result.isError).toBe(true);
			expect(result.output).toContain("differs from the frozen target");
			expect(writeSpy).not.toHaveBeenCalled();
			expect(await missing(f.output)).toBe(true);
		});

	test("canonicalized tool input stores the new UTF-16 character cache atomically", async () => {
		const f = await fixture("primary", "Write");
		const updatedInput = { file_path: f.output, content: "中文😀" };
		await persistPermissionResolvedInput(f.id, f.tu.toolUseId, f.binding, updatedInput);
		const call = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.id, f.callId),
		});
		expect(call?.inputJson).toEqual(updatedInput);
		expect(call?.inputChars).toBe(JSON.stringify(updatedInput).length);
		await db
			.update(narratorToolCalls)
			.set({ status: "success" })
			.where(eq(narratorToolCalls.id, f.callId));
		await expect(
			persistPermissionResolvedInput(f.id, f.tu.toolUseId, f.binding, { content: "rejected" }),
		).rejects.toThrow("expired/started");
		const unchanged = await db.query.narratorToolCalls.findFirst({
			where: eq(narratorToolCalls.id, f.callId),
		});
		expect(unchanged?.inputChars).toBe(call?.inputChars);
		expect(unchanged?.inputJson).toEqual(updatedInput);
	});

	for (const kind of ["primary", "subagent"] as const)
		for (const tool of ["Write", "Bash"] as const) {
			test(`${kind} ${tool}: a newly added ancestor blacklist wins over the prior real allow`, async () => {
				const f = await fixture(kind, tool);
				let entered!: () => void, release!: () => void;
				const ready = new Promise<void>((resolve) => {
					entered = resolve;
				});
				const held = new Promise<void>((resolve) => {
					release = resolve;
				});
				f.config.onToolExecutionBefore = async () => {
					entered();
					await held;
				};
				const execution = executeTool(f.tu, f.config, { toolCallBinding: f.binding });
				await ready;
				try {
					const row = await db.query.narratorToolCalls.findFirst({
						where: eq(narratorToolCalls.id, f.callId),
						columns: { permissionDecidedBy: true },
					});
					expect(row?.permissionDecidedBy).toBe("auto");
					await permissionRuleService.createNarratorRule(
						parentId,
						tool === "Write"
							? {
									ruleType: "directoryBlacklist",
									value: {
										path: cwd,
										denyLevel: "denyWrite",
										targetKind: "host",
										pathFlavor: "posix",
									},
								}
							: { ruleType: "commandBlacklist", value: { pattern: "printf*", targetKind: "host" } },
					);
				} finally {
					release();
				}
				const result = await execution;
				expect(result.isError).toBe(true);
				expect(await missing(f.output)).toBe(true);
				expect(writeSpy).not.toHaveBeenCalled();
				expect(execSpy).not.toHaveBeenCalled();
			});
		}
	test("durable direct/recovery runners cannot bypass final policy by omitting the explicit hook", async () => {
		const f = await fixture("primary", "Write", false);
		f.config.onToolExecutionBefore = async () => {
			await permissionRuleService.createNarratorRule(parentId, {
				ruleType: "directoryBlacklist",
				value: { path: cwd, denyLevel: "denyWrite", targetKind: "host", pathFlavor: "posix" },
			});
		};
		const result = await executeTool(f.tu, f.config, { toolCallBinding: f.binding });
		expect(result.isError).toBe(true);
		expect(await missing(f.output)).toBe(true);
		expect(writeSpy).not.toHaveBeenCalled();
	});
	test("a real positive Write control still writes when the admitted policy remains valid", async () => {
		const f = await fixture("primary", "Write");
		const result = await executeTool(f.tu, f.config, { toolCallBinding: f.binding });
		expect(result.isError).not.toBe(true);
		expect(await readFile(f.output, "utf8")).toBe("changed");
		expect(await missing(f.output)).toBe(false);
	});
	test("a real positive Bash control dispatches a process only when the policy remains valid", async () => {
		const f = await fixture("primary", "Bash");
		const result = await executeTool(f.tu, f.config, { toolCallBinding: f.binding });
		expect(result.isError).not.toBe(true);
		expect(await readFile(f.output, "utf8")).toBe("spawned");
		expect(execSpy).toHaveBeenCalled();
	});
	test("real subagent positive controls can Write and dispatch Bash when the policy is unchanged", async () => {
		const write = await fixture("subagent", "Write");
		const written = await executeTool(write.tu, write.config, { toolCallBinding: write.binding });
		expect(written.isError).not.toBe(true);
		expect(await readFile(write.output, "utf8")).toBe("changed");
		const bash = await fixture("subagent", "Bash");
		const executed = await executeTool(bash.tu, bash.config, { toolCallBinding: bash.binding });
		expect(executed.isError).not.toBe(true);
		expect(await readFile(bash.output, "utf8")).toBe("spawned");
		expect(execSpy).toHaveBeenCalled();
	});
	test("revoking the actual triggering actor's ownership during preparation denies the previously allowed Write", async () => {
		const f = await fixture("primary", "Write");
		f.config.onToolExecutionBefore = async () => {
			await db.update(narrators).set({ ownerUserId: null }).where(eq(narrators.id, parentId));
		};
		const result = await executeTool(f.tu, f.config, { toolCallBinding: f.binding });
		expect(result.isError).toBe(true);
		expect(await missing(f.output)).toBe(true);
		expect(execSpy).not.toHaveBeenCalled();
	});
	test("an ACL change in the final executing event is caught synchronously before Write I/O", async () => {
		const f = await fixture("primary", "Write");
		f.config.onEvent = (event) => {
			if (event.type === "tool_executing")
				db.update(narrators).set({ ownerUserId: null }).where(eq(narrators.id, parentId)).run();
		};
		const result = await executeTool(f.tu, f.config, { toolCallBinding: f.binding });
		expect(result.isError).toBe(true);
		expect(await missing(f.output)).toBe(true);
		expect(result.output).toContain("Actor ACL changed");
	});
	test("a blacklist inserted by the executing-event callback is caught by the synchronous final fence", async () => {
		const f = await fixture("primary", "Write");
		f.config.onEvent = (event) => {
			if (event.type !== "tool_executing") return;
			const ruleId = generateId();
			db.insert(narratorBlacklistDirs)
				.values({
					id: ruleId,
					narratorId: parentId,
					path: cwd,
					pathKey: localBackend.paths.identityKey(cwd),
					pathFlavor: "posix",
					targetKind: "host",
					denyLevel: "denyWrite",
					enabled: true,
					createdAt: now(),
				})
				.run();
			permissionPolicyChanges.emit({
				type: "permission:policy_changed",
				narratorId: parentId,
				ruleType: "directoryBlacklist",
				ruleId,
				change: "created",
				changedAt: now(),
			});
		};
		const result = await executeTool(f.tu, f.config, { toolCallBinding: f.binding });
		expect(result.isError).toBe(true);
		expect(await missing(f.output)).toBe(true);
		expect(writeSpy).not.toHaveBeenCalled();
	});
});

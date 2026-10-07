import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import type {
	RemoteHistoryBinding,
	RemoteHistoryReceipt,
	RemoteHistoryRequest,
} from "@shared/remote-history-protocol";
import type { WorkspaceContext } from "@shared/workspace-context";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { targetPathSemantics } from "../lib/agent/execution/path-semantics";
import type {
	ToolCallBinding,
	ToolExecutionLifecycleContext,
	ToolExecutionTarget,
} from "../lib/agent/types";
import { settings } from "../lib/settings";
import type { FileChangeScopeRecord } from "./file-change-evidence";
import { RemoteHistoryService, remoteHistoryObjectId } from "./remote-history-service";
import {
	finishRemoteActivity,
	type RemoteTreeHookDependencies,
	registerRemoteActivity,
	registerRemoteTerminalActivity,
} from "./remote-tree-snapshot-hooks";
import type { RemoteTreeBoundary, RemoteTreeReceiptStore } from "./remote-tree-snapshot-receipts";
import type { RemoteWorkspaceHistoryRuntime } from "./remote-workspace-history-runtime";
import { buildTreeSnapshotExecutionHooks } from "./tree-snapshot-loop-hooks";
import type { WorkspaceWriteCoordinator } from "./workspace-write-coordinator";
import { worktreeTreeSnapshot } from "./worktree-tree-snapshot";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
let sequence = 0;
function fixture() {
	const id = ++sequence;
	const paths = targetPathSemantics("posix");
	const root = `/remote-selected/${id}`;
	let source = `native-source-${id}`;
	let fence = 1;
	let partial = false;
	let sparse = false;
	let denied = false;
	let busy = false;
	const requests: RemoteHistoryRequest[] = [];
	const metadata: Array<{
		boundary: RemoteTreeBoundary;
		receipt?: RemoteHistoryReceipt;
		state: string;
	}> = [];
	const actors: string[] = [];
	const roots: string[] = [];
	const activities: Array<{ outcome?: string }> = [];
	const binding: ToolCallBinding = {
		toolCallId: `real-tool-${id}`,
		attempt: 1,
		executionSegmentId: `segment-${id}`,
	};
	const target: ToolExecutionTarget = {
		deviceId: `device-${id}`,
		backendKind: "remote",
		baseCwd: root,
		cwd: root,
		canonicalPath: `${root}/file.txt`,
		lexicalPath: `${root}/file.txt`,
		pathFlavor: "posix",
		runtimeGeneration: 7,
		selectionSource: "session_default",
	};
	const workspace: WorkspaceContext = {
		deviceId: target.deviceId,
		cwd: root,
		pathFlavor: "posix",
		contextKey: `chosen-${id}`,
		revision: 3,
		capabilities: { switchDirectory: true },
	};
	const backend = {
		kind: "remote",
		deviceId: target.deviceId,
		paths,
		pathFlavor: "posix",
		runtimeGeneration: 7,
		defaultCwd: "/executor-wrong-default",
		supportsRemoteHistory: true,
		supportsRemoteTreeCapture: true,
	} as unknown as ExecutionBackend;
	function endpoint(captureRoot = root) {
		const native: RemoteHistoryBinding = {
			sourceInstanceId: source,
			workspaceInstanceId: `workspace-${id}`,
			scopeId: `scope-${id}`,
			root: captureRoot,
			rootIdentity: `disk:inode-${id}`,
			fence,
		};
		const rpc = {
			supportsRemoteHistory: true,
			supportsRemoteTreeCapture: true,
			remoteHistory: async (_kind: string, request: RemoteHistoryRequest) => {
				requests.push(structuredClone(request));
				if (denied) throw new Error("capture read denied");
				const coverage =
					partial && request.capturePhase === "hot" ? ("partial" as const) : ("complete" as const);
				const digest = hash(`${request.operationId}:${request.capturePhase}`);
				const tree = {
					algorithm: "sha256" as const,
					digest,
					sizeBytes: 10,
					objectId: remoteHistoryObjectId(native.scopeId, "tree", digest, ""),
					kind: "tree" as const,
					path: "",
					sourceInstanceId: native.sourceInstanceId,
					workspaceInstanceId: native.workspaceInstanceId,
					scopeId: native.scopeId,
				};
				return {
					operationId: request.operationId,
					requestDigest: request.requestDigest,
					payloadDigest: hash(request.requestDigest),
					binding: native,
					kind: "capture",
					state: "settled",
					effects: [],
					captureKind: sparse ? undefined : "whole_directory",
					capturePhase: request.capturePhase,
					tree,
					coverage,
					temporalConsistency: "concurrent_observation",
					consistency: "stable_double_scan",
					policyDigest: request.treePolicy?.policyDigest,
					reason: coverage === "partial" ? "capture_deadline" : "",
					captureAttempts:
						request.capturePhase === "warm"
							? [{ phase: "hot", coverage: "partial", reason: "capture_deadline" }]
							: undefined,
					startedAt: new Date().toISOString(),
					finishedAt: new Date().toISOString(),
				};
			},
		};
		const history = new RemoteHistoryService(rpc as never, native, {
			putIntent: async () => {},
			putReceipt: async () => {},
			markUnknown: async () => {},
			putObject: async () => {},
		});
		const scope = {
			id: native.scopeId,
			sourceInstanceId: native.sourceInstanceId,
			workspaceInstanceId: native.workspaceInstanceId,
			deviceId: target.deviceId,
			canonicalRoot: captureRoot,
			pathFlavor: "posix",
			revision: 0,
			fencingToken: fence,
			status: "active",
			rootIdentityJson: { object: native.rootIdentity },
		} as unknown as FileChangeScopeRecord;
		const coordinator = {
			registerActivity: () => {
				const entry: { outcome?: string } = {};
				activities.push(entry);
				return { id: Symbol("activity"), entry };
			},
			endActivity: (token: { entry: { outcome?: string } }, outcome: string) => {
				token.entry.outcome = outcome;
			},
		} as unknown as WorkspaceWriteCoordinator;
		return {
			history,
			scope,
			runtimeBinding: { runtimeEpoch: `remote:${target.deviceId}:7`, runtimeGeneration: 7 },
			coordinator,
		};
	}
	const store: RemoteTreeReceiptStore = {
		validate: async (value) => {
			expect(value.binding).toEqual(binding);
		},
		begin: async (boundary) => {
			metadata.push({ boundary: structuredClone(boundary), state: "pending" });
			return {} as never;
		},
		finish: async (boundary, receipt) => {
			const row = metadata.find((entry) => entry.boundary.operationId === boundary.operationId);
			if (!row) throw new Error("missing metadata");
			row.receipt = structuredClone(receipt);
			row.state = receipt.coverage ?? "unknown";
		},
		unavailable: async (boundary, state) => {
			const row = metadata.find((entry) => entry.boundary.operationId === boundary.operationId);
			if (row && row.state === "pending") row.state = state;
		},
	};
	const dependencies: RemoteTreeHookDependencies = {
		backend: () => backend,
		store: async () => store,
		runtime: async () =>
			({
				resolveWorkspace: async (actor, endpointTarget) => {
					if (busy) throw new Error("Remote scope requires reconciliation; no TTL release");
					actors.push(actor.userId);
					roots.push(endpointTarget.cwd);
					return endpoint(endpointTarget.cwd);
				},
			}) as Pick<RemoteWorkspaceHistoryRuntime, "resolveWorkspace">,
		policy: async () => {
			if (denied) throw new Error("capture read denied");
			return { deniedDirectories: [`${root}/secret`], policyDigest: hash(`policy-${id}`) };
		},
		actorKind: async () => "subagent",
		hotBudgetMs: 100,
		warmBudgetMs: 100,
	};
	const session = {
		cwd: "/host-decoy",
		_defaultDeviceId: target.deviceId,
		_workspaceContext: workspace,
		_currentUserId: "actual-trigger",
		_treeHashBefore: new Map<string, string>(),
	};
	const context: ToolExecutionLifecycleContext = {
		toolUse: { name: "Write", toolUseId: `provider-${id}`, input: { file_path: "wrong.txt" } },
		effectiveInput: { file_path: `${root}/file.txt` },
		executionTarget: target,
		binding,
	};
	const hooks = buildTreeSnapshotExecutionHooks({
		session,
		narratorId: `narrator-${id}`,
		isInGitRepo: false,
		remoteDependencies: dependencies,
	});
	return {
		narratorId: `narrator-${id}`,
		root,
		target,
		binding,
		session,
		context,
		hooks,
		dependencies,
		endpoint,
		requests,
		metadata,
		actors,
		roots,
		activities,
		partial: () => {
			partial = true;
		},
		sparse: () => {
			sparse = true;
		},
		deny: () => {
			denied = true;
		},
		busy: () => {
			busy = true;
		},
		newFence: () => {
			fence++;
		},
		replaceSource: () => {
			source = `replacement-${id}`;
		},
	};
}

afterEach(() => {
	settings.chapters.treeSnapshotsEnabled = true;
});
async function flushWarm() {
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
}

describe("actual standalone terminal activity wrapper", () => {
	function terminalFixture() {
		const f = fixture();
		const target = { ...f.target, canonicalPath: f.root, lexicalPath: f.root };
		const factoryCalls: unknown[] = [];
		const input = {
			principal: { userId: "terminal-creator", isAdmin: false },
			terminalId: `real-terminal-${sequence}`,
			workspaceContext: f.session._workspaceContext,
			runtimeGeneration: 7,
			target,
			activityId: `pty:real-terminal-${sequence}`,
			scopeFactory: async (value: unknown) => {
				factoryCalls.push(value);
				const endpoint = f.endpoint();
				return {
					scope: endpoint.scope,
					runtime: endpoint.runtimeBinding,
					coordinator: endpoint.coordinator,
					assertCurrent: async () => {},
				};
			},
		};
		return { f, target, input, factoryCalls };
	}
	test("actual terminal actor is passed to independent source factory; duplicate adoption is idempotent", async () => {
		const t = terminalFixture();
		await registerRemoteTerminalActivity(t.input);
		await registerRemoteTerminalActivity(t.input);
		expect(t.factoryCalls[0]).toMatchObject({
			principal: t.input.principal,
			terminalId: t.input.terminalId,
			workspaceContext: t.input.workspaceContext,
			runtimeGeneration: 7,
		});
		expect(t.factoryCalls[0]).not.toHaveProperty("narratorId");
		expect(t.f.activities).toHaveLength(1);
		await expect(
			registerRemoteTerminalActivity({
				...t.input,
				principal: { userId: "another-user", isAdmin: false },
			}),
		).rejects.toThrow("actual actor changed");
		await finishRemoteActivity({
			target: t.target,
			activityId: t.input.activityId,
			outcome: "finished",
		});
		expect(t.f.activities[0]?.outcome).toBe("finished");
	});
	test("source replacement cannot adopt a live terminal and unknown is not promoted by a later finished call", async () => {
		const t = terminalFixture();
		await registerRemoteTerminalActivity(t.input);
		t.f.replaceSource();
		await expect(registerRemoteTerminalActivity(t.input)).rejects.toThrow(
			"source or actual actor changed",
		);
		await finishRemoteActivity({
			target: t.target,
			activityId: t.input.activityId,
			outcome: "unknown",
		});
		await finishRemoteActivity({
			target: t.target,
			activityId: t.input.activityId,
			outcome: "finished",
		});
		expect(t.f.activities[0]?.outcome).toBe("unknown");
	});
	test("changed generation/canonical workspace refuses before source lookup or registration", async () => {
		const t = terminalFixture();
		await expect(
			registerRemoteTerminalActivity({ ...t.input, runtimeGeneration: 8 }),
		).rejects.toThrow("frozen origin");
		expect(t.factoryCalls).toEqual([]);
		expect(t.f.activities).toEqual([]);
	});
});

describe("shared remote whole-directory snapshot hooks", () => {
	test("nonGit primary/subagent hooks capture real endpoint boundaries and never call host shadow Git", async () => {
		const local = spyOn(worktreeTreeSnapshot, "tryCaptureHot").mockRejectedValue(
			new Error("must not call host capture"),
		);
		try {
			const f = fixture();
			await f.hooks.onToolExecutionBefore?.(f.context);
			f.session.cwd = "/later-host-cwd";
			f.session._currentUserId = "later-user";
			f.session._workspaceContext = {
				...f.session._workspaceContext,
				cwd: "/later-remote-cwd",
				contextKey: "later",
				revision: 4,
			};
			f.newFence();
			await f.hooks.onToolExecutionAfter?.({ ...f.context, result: { output: "written" } });
			expect(f.requests).toHaveLength(2);
			expect(f.requests.map((request) => request.binding.fence)).toEqual([1, 2]);
			expect(
				f.requests.every(
					(request) =>
						request.binding.root === f.root &&
						request.treePolicy?.deniedDirectories[0] === `${f.root}/secret`,
				),
			).toBe(true);
			expect(f.actors.every((actor) => actor === "actual-trigger")).toBe(true);
			expect(f.metadata.map((entry) => entry.boundary.edge)).toEqual(["before", "after"]);
			expect(
				f.metadata.every(
					(entry) =>
						entry.boundary.actorSubjectKey === "user:actual-trigger" &&
						entry.boundary.binding.attempt === 1 &&
						entry.receipt?.effects.length === 0,
				),
			).toBe(true);
			expect(f.session._treeHashBefore.size).toBe(0);
			expect(local).not.toHaveBeenCalled();
		} finally {
			local.mockRestore();
		}
	});

	test("explicit outside workdir has an independent admitted scope without mutating or reapplying baseCwd", async () => {
		const f = fixture();
		const outside = `${f.root}-approved-other`;
		const target = { ...f.target, cwd: outside, canonicalPath: outside, lexicalPath: outside };
		const context = {
			...f.context,
			toolUse: { ...f.context.toolUse, name: "Bash" },
			effectiveInput: { command: "true", workdir: "../approved-other" },
			executionTarget: target,
		};
		await f.hooks.onToolExecutionBefore?.(context);
		await registerRemoteActivity({
			narratorId: f.narratorId,
			userId: "actual-trigger",
			actorKind: "subagent",
			target,
			binding: f.binding,
			kind: "bash",
			dependencies: f.dependencies,
		});
		await finishRemoteActivity({ target, binding: f.binding, outcome: "finished" });
		await f.hooks.onToolExecutionAfter?.({ ...context, result: { output: "done" } });
		expect(f.requests.map((request) => request.binding.root)).toEqual([outside, outside]);
		expect(f.roots.every((root) => root === outside)).toBe(true);
		expect(target.baseCwd).toBe(f.root);
		expect(
			f.metadata.every(
				(entry) => entry.boundary.contextKey !== f.session._workspaceContext.contextKey,
			),
		).toBe(true);
	});

	test("warm captures retain original operationId/requestDigest/attempt and remain concurrent observations", async () => {
		const f = fixture();
		f.partial();
		await f.hooks.onToolExecutionBefore?.(f.context);
		await f.hooks.onToolExecutionAfter?.({ ...f.context, result: { output: "written" } });
		await flushWarm();
		for (const hot of f.requests.filter((request) => request.capturePhase === "hot")) {
			const warm = f.requests.find(
				(request) => request.capturePhase === "warm" && request.operationId === hot.operationId,
			);
			expect(warm?.requestDigest).toBe(hot.requestDigest);
		}
		expect(
			f.metadata.every(
				(entry) =>
					entry.boundary.binding.attempt === 1 &&
					entry.receipt?.temporalConsistency === "concurrent_observation" &&
					entry.receipt?.captureAttempts?.[0]?.phase === "hot",
			),
		).toBe(true);
	});

	test("sparse fake receipts never become complete directory boundaries", async () => {
		const f = fixture();
		f.sparse();
		await f.hooks.onToolExecutionBefore?.(f.context);
		await f.hooks.onToolExecutionAfter?.({ ...f.context, result: { output: "written" } });
		await flushWarm();
		expect(f.metadata.every((entry) => entry.state === "failed" && !entry.receipt)).toBe(true);
	});

	test("Bash background after snapshot waits for the actual adopted lifetime", async () => {
		const f = fixture();
		f.context.toolUse.name = "Bash";
		await f.hooks.onToolExecutionBefore?.(f.context);
		await registerRemoteActivity({
			narratorId: f.narratorId,
			userId: "actual-trigger",
			actorKind: "subagent",
			target: f.target,
			binding: f.binding,
			kind: "bash",
			dependencies: f.dependencies,
		});
		await f.hooks.onToolExecutionAfter?.({
			...f.context,
			result: { output: "started", metadata: { background_task_id: "background" } },
		});
		expect(f.requests).toHaveLength(1);
		expect(f.activities[0].outcome).toBeUndefined();
		await finishRemoteActivity({ target: f.target, binding: f.binding, outcome: "finished" });
		await flushWarm();
		expect(f.activities[0].outcome).toBe("finished");
		expect(f.requests).toHaveLength(2);
	});

	test("an unadopted background writer is unknown, not a task-status finished claim", async () => {
		const f = fixture();
		f.context.toolUse.name = "Bash";
		await f.hooks.onToolExecutionBefore?.(f.context);
		await f.hooks.onToolExecutionAfter?.({
			...f.context,
			result: { output: "started", metadata: { background_task_id: "background" } },
		});
		expect(f.activities[0].outcome).toBe("unknown");
		expect(f.requests).toHaveLength(1);
	});

	test("an unknown native scope barrier rejects before tool IO and is not swallowed", async () => {
		const f = fixture();
		f.busy();
		await expect(f.hooks.onToolExecutionBefore?.(f.context)).rejects.toThrow("reconciliation");
		expect(f.requests).toEqual([]);
	});

	test("changed source incarnations cannot attach an after descriptor to an old boundary", async () => {
		const f = fixture();
		await f.hooks.onToolExecutionBefore?.(f.context);
		f.replaceSource();
		await f.hooks.onToolExecutionAfter?.({ ...f.context, result: { output: "written" } });
		expect(f.requests).toHaveLength(1);
		expect(f.metadata.find((entry) => entry.boundary.edge === "after")?.state).toBe("failed");
	});
});

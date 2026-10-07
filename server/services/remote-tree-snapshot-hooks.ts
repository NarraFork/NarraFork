import { createHash } from "node:crypto";
import type { RemoteHistoryReceipt, RemoteHistoryRequest } from "@shared/remote-history-protocol";
import type { WorkspaceContext } from "@shared/workspace-context";
import type { ExecutionBackend } from "../lib/agent/execution/backend";
import { resolveBackend } from "../lib/agent/execution/registry";
import type {
	ToolCallBinding,
	ToolExecutionLifecycleContext,
	ToolExecutionTarget,
	ToolResult,
} from "../lib/agent/types";
import { logger } from "../lib/logger";
import { settings } from "../lib/settings";
import { executionPolicyEngine } from "./execution-policy/engine";
import { integrationResourceBindingService } from "./integration-resource-binding-service";
import { resolveOAuthNarratorRuntimePolicy } from "./oauth-narrator-runtime-policy";
import {
	getRemoteTreeReceiptStore,
	type RemoteTreeBoundary,
	type RemoteTreeReceiptStore,
	validateRemoteTreeReceipt,
} from "./remote-tree-snapshot-receipts";
import type {
	RemoteHistoryActor,
	RemoteHistoryTarget,
	RemoteWorkspaceHistoryRuntime,
} from "./remote-workspace-history-runtime";
import { getRemoteWorkspaceHistoryRuntime } from "./remote-workspace-history-runtime";
import type { WorkspaceActivityToken } from "./workspace-write-coordinator";

export const REMOTE_TREE_HOT_BUDGET_MS = 4_000;
export const REMOTE_TREE_WARM_BUDGET_MS = 120_000;
const MAX_TRACKED_ACTIVITIES = 256;
const MAX_WARM_JOBS = 16;
type Endpoint = Awaited<ReturnType<RemoteWorkspaceHistoryRuntime["resolveWorkspace"]>>;
type Registry = Pick<RemoteWorkspaceHistoryRuntime, "resolveWorkspace">;
export interface RemoteTreeHookDependencies {
	runtime(): Promise<Registry>;
	store(): Promise<RemoteTreeReceiptStore>;
	backend(deviceId: string): ExecutionBackend;
	policy(
		actor: RemoteHistoryActor,
		target: RemoteHistoryTarget,
		backend: ExecutionBackend,
		signal: AbortSignal,
	): Promise<NonNullable<RemoteHistoryRequest["treePolicy"]>>;
	actorKind?(narratorId: string): Promise<RemoteHistoryActor["kind"]>;
	hotBudgetMs?: number;
	warmBudgetMs?: number;
}
export interface RemoteTreeSnapshotHookOptions {
	narratorId: string;
	userId: string | null | undefined;
	projectId?: string | null;
	workspaceContext?: WorkspaceContext;
	dependencies?: RemoteTreeHookDependencies;
}
export interface RemoteTreeAttempt {
	readonly context: ToolExecutionLifecycleContext;
	readonly actor: RemoteHistoryActor;
	readonly target: RemoteHistoryTarget;
	readonly endpoint: Endpoint;
	readonly backend: ExecutionBackend;
	readonly options: RemoteTreeSnapshotHookOptions;
	readonly store: RemoteTreeReceiptStore;
	readonly dependencies: RemoteTreeHookDependencies;
	readonly contextKey: string;
	readonly workspaceRevision: number;
	readonly activityKey?: string;
}
interface Activity {
	requestKey: string;
	sourceKey: string;
	endpoint: Endpoint;
	target: RemoteHistoryTarget;
	actorSubjectKey: string;
	narratorId: string;
	token: WorkspaceActivityToken;
	adopted: boolean;
	outcome?: "finished" | "unknown";
	resolve(outcome: "finished" | "unknown"): void;
	settled: Promise<"finished" | "unknown">;
}
const activities = new Map<string, Activity>();
const activityRequests = new Map<string, string>();
type TerminalActivityEndpoint = Awaited<
	ReturnType<
		typeof import("./terminal-workspace-activity-scope")["resolveTerminalWorkspaceActivityScope"]
	>
>;
const terminalActivities = new Map<
	string,
	{
		endpoint: TerminalActivityEndpoint;
		token: WorkspaceActivityToken;
		sourceKey: string;
		actorSubjectKey: string;
		terminalId: string;
		outcome?: "finished" | "unknown";
	}
>();
const warmJobs = new Map<string, Promise<void>>();

function hash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function sourceKey(endpoint: Endpoint, deviceId: string): string {
	return JSON.stringify([
		deviceId,
		endpoint.history.binding.sourceInstanceId,
		endpoint.history.binding.workspaceInstanceId,
		endpoint.history.binding.scopeId,
		endpoint.history.binding.root,
		endpoint.history.binding.rootIdentity,
		endpoint.history.binding.fence,
	]);
}
function requestKey(input: {
	target: ToolExecutionTarget;
	binding?: ToolCallBinding;
	activityId?: string;
}): string {
	if (!input.binding && !input.activityId)
		throw new Error("Remote activity needs a real invocation or terminal identity");
	return JSON.stringify([
		input.target.deviceId,
		input.target.baseCwd ?? input.target.cwd,
		input.target.cwd,
		input.target.canonicalPath ?? null,
		input.target.runtimeGeneration,
		input.binding?.toolCallId ?? input.activityId,
		input.binding?.attempt ?? 0,
	]);
}
class RemoteTreeCoverageUnavailable extends Error {}
function remoteTarget(target: ToolExecutionTarget, backend: ExecutionBackend): RemoteHistoryTarget {
	const base = target.baseCwd ?? target.cwd;
	// A permitted one-call workdir outside the resident base has its own admitted scope.
	// Preserve the original target; never reapply its relative workdir or borrow later cwd.
	const root = backend.paths.contains(base, target.cwd) ? base : target.cwd;
	if (target.canonicalPath && !backend.paths.contains(root, target.canonicalPath))
		throw new RemoteTreeCoverageUnavailable(
			"File-primary endpoint requires a separately authorized directory capture scope",
		);
	if (
		target.backendKind !== "remote" ||
		target.deviceId !== backend.deviceId ||
		target.pathFlavor !== backend.pathFlavor ||
		target.runtimeGeneration !== backend.runtimeGeneration ||
		!backend.paths.isAbsolute(root) ||
		!backend.paths.contains(root, target.cwd) ||
		(target.canonicalPath && !backend.paths.contains(root, target.canonicalPath))
	)
		throw new Error("Remote tree endpoint is stale, unverified or outside its admitted root");
	return {
		deviceId: target.deviceId,
		cwd: root,
		lexicalPath: root,
		canonicalPath: root,
		runtimeGeneration: backend.runtimeGeneration,
	};
}
function sameSource(before: Endpoint, after: Endpoint): boolean {
	const first = before.history.binding;
	const last = after.history.binding;
	return ["sourceInstanceId", "workspaceInstanceId", "scopeId", "root", "rootIdentity"].every(
		(key) => first[key as keyof typeof first] === last[key as keyof typeof last],
	);
}
function isBarrier(error: unknown): boolean {
	return (
		error instanceof Error &&
		/reconcil|barrier|recovery|retired|scope\/fence|durable lease|rollback_active|needs_verification/i.test(
			error.message,
		)
	);
}
function boundedSignal(ms: number): AbortSignal {
	return AbortSignal.timeout(ms);
}
async function waitBounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const abort = () => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		operation.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				if (signal.aborted) reject(signal.reason);
				else resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
		if (signal.aborted) abort();
	});
}

/** Derive only denyRead/denyAll; write deny is irrelevant to a read-only observation. */
export async function remoteTreeCapturePolicy(
	actor: RemoteHistoryActor,
	target: RemoteHistoryTarget,
	backend: ExecutionBackend,
	signal: AbortSignal,
): Promise<NonNullable<RemoteHistoryRequest["treePolicy"]>> {
	const oauth = await resolveOAuthNarratorRuntimePolicy(actor.narratorId, actor.userId);
	let deviceClass: "global" | "selfRegistered" | null = null;
	if (oauth) {
		const provenance = await integrationResourceBindingService.get("device", target.deviceId);
		deviceClass =
			provenance?.sourceType === "oauth_client" &&
			provenance.sourceId === oauth.clientId &&
			provenance.authorityType === "oauth_grant" &&
			provenance.authorityId === oauth.grantId &&
			provenance.state === "active"
				? "selfRegistered"
				: "global";
	}
	const policy = await executionPolicyEngine.compile(
		actor.narratorId,
		{
			backend,
			paths: backend.paths,
			deviceClass,
			target: {
				deviceId: target.deviceId,
				backendKind: "remote",
				cwd: target.cwd,
				lexicalPath: target.cwd,
				canonicalPath: target.cwd,
				pathFlavor: backend.pathFlavor,
				runtimeGeneration: target.runtimeGeneration,
				selectionSource: "explicit",
			},
		},
		oauth?.useRobotDiagnosticPreset ? ["robotDiagnostic"] : [],
		signal,
	);
	if (policy.evaluatePath({ path: target.cwd, operation: "read" }).decision === "deny")
		throw new Error("Remote tree root read denied");
	const deniedDirectories: string[] = [];
	for (const rule of policy.directoryBlacklist) {
		if (!rule.enabled || rule.denyLevel !== "denyAll") continue;
		if (backend.paths.contains(rule.path, target.cwd))
			throw new Error("Remote tree root read denied");
		if (backend.paths.contains(target.cwd, rule.path)) deniedDirectories.push(rule.path);
	}
	const denied = Array.from(new Set(deniedDirectories)).sort();
	if (denied.length > 256 || Buffer.byteLength(JSON.stringify(denied)) > 64_000)
		throw new Error("Remote tree read policy exceeds its metadata budget");
	return {
		deniedDirectories: denied,
		policyDigest: hash([
			policy.revision,
			backend.deviceId,
			backend.paths.identityKey(target.cwd),
			denied.map((path) => backend.paths.identityKey(path)),
		]),
	};
}
const productionDependencies: RemoteTreeHookDependencies = {
	runtime: getRemoteWorkspaceHistoryRuntime,
	store: getRemoteTreeReceiptStore,
	backend: (deviceId) => resolveBackend({ requested: deviceId }),
	policy: remoteTreeCapturePolicy,
	actorKind: async (narratorId) => {
		const [{ db }, { narrators }, { eq }] = await Promise.all([
			import("../db"),
			import("../db/schema"),
			import("drizzle-orm"),
		]);
		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, narratorId),
			columns: { variant: true },
		});
		if (!row) throw new Error("Snapshot narrator no longer exists");
		return row.variant.startsWith("subagent:") ? "subagent" : "primary";
	},
};

function createActivity(
	endpoint: Endpoint,
	target: RemoteHistoryTarget,
	key: string,
	adopted: boolean,
	actorSubjectKey: string,
	narratorId: string,
): string {
	const source = sourceKey(endpoint, target.deviceId);
	const id = `${source}:${key}`;
	const existing = activities.get(id);
	if (existing) {
		if (existing.actorSubjectKey !== actorSubjectKey || existing.narratorId !== narratorId)
			throw new Error("Remote activity actor or invocation owner changed");
		existing.adopted ||= adopted;
		return id;
	}
	if (activities.size >= MAX_TRACKED_ACTIVITIES)
		throw new Error(
			"Remote activity registry capacity exceeded; no silent eviction of live writers",
		);
	const token = endpoint.coordinator.registerActivity({
		scope: endpoint.scope,
		runtime: endpoint.runtimeBinding,
	});
	let resolve!: (outcome: "finished" | "unknown") => void;
	const settled = new Promise<"finished" | "unknown">((done) => {
		resolve = done;
	});
	activities.set(id, {
		requestKey: key,
		sourceKey: source,
		endpoint,
		target,
		actorSubjectKey,
		narratorId,
		token,
		adopted,
		settled,
		resolve,
	});
	activityRequests.set(key, id);
	return id;
}
async function settleActivity(id: string, outcome: "finished" | "unknown"): Promise<void> {
	const entry = activities.get(id);
	if (!entry || entry.outcome) return;
	try {
		entry.endpoint.coordinator.endActivity(entry.token, outcome);
		entry.outcome = outcome;
		entry.resolve(outcome);
		activities.delete(id);
		if (activityRequests.get(entry.requestKey) === id) activityRequests.delete(entry.requestKey);
	} catch (error) {
		// Never retry unknown as finished or discard an unpersisted recovery barrier.
		entry.outcome = "unknown";
		entry.resolve("unknown");
		throw error;
	}
}

/** Actual Bash/PTY lifetime adoption. Caller must invoke before spawn and never borrow owner identity. */
export async function registerRemoteActivity(input: {
	narratorId: string;
	userId: string;
	projectId?: string | null;
	actorKind: RemoteHistoryActor["kind"];
	target: ToolExecutionTarget;
	binding?: ToolCallBinding;
	activityId?: string;
	kind: "bash" | "pty";
	signal?: AbortSignal;
	dependencies?: RemoteTreeHookDependencies;
}): Promise<void> {
	const deps = input.dependencies ?? productionDependencies;
	const key = requestKey(input);
	const existingId = activityRequests.get(key);
	const existing = existingId ? activities.get(existingId) : undefined;
	const signal = input.signal ?? boundedSignal(10_000);
	const backend = deps.backend(input.target.deviceId);
	const target = remoteTarget(input.target, backend);
	const actor: RemoteHistoryActor = {
		userId: input.userId,
		narratorId: input.narratorId,
		projectId: input.projectId ?? null,
		kind: input.actorKind,
	};
	const registry = await deps.runtime();
	const endpoint = await registry.resolveWorkspace(actor, target, signal);
	if (existing) {
		if (
			existing.actorSubjectKey !== `user:${input.userId}` ||
			existing.narratorId !== input.narratorId ||
			!sameSource(existing.endpoint, endpoint)
		)
			throw new Error("Remote activity source or actor changed before spawn");
		existing.adopted = true;
		return;
	}
	createActivity(endpoint, target, key, true, `user:${input.userId}`, input.narratorId);
}
/** Standalone PTY origin is its actual prepared terminal row, never a synthetic narrator. */
export async function registerRemoteTerminalActivity(input: {
	principal: import("./narrator-acl").NarratorPrincipal;
	terminalId: string;
	workspaceContext: WorkspaceContext;
	runtimeGeneration: number;
	target: ToolExecutionTarget;
	activityId: string;
	signal?: AbortSignal;
	scopeFactory?: typeof import("./terminal-workspace-activity-scope")["resolveTerminalWorkspaceActivityScope"];
}): Promise<void> {
	const frozen = Object.freeze({ ...input.workspaceContext });
	if (
		!input.principal.userId ||
		!input.terminalId ||
		input.activityId !== `pty:${input.terminalId}` ||
		input.target.deviceId !== frozen.deviceId ||
		input.target.cwd !== frozen.cwd ||
		input.target.canonicalPath !== frozen.cwd ||
		input.target.pathFlavor !== frozen.pathFlavor ||
		input.target.runtimeGeneration !== input.runtimeGeneration
	)
		throw new Error("Terminal activity does not match its actual frozen origin");
	const factory =
		input.scopeFactory ??
		(await import("./terminal-workspace-activity-scope")).resolveTerminalWorkspaceActivityScope;
	const endpoint = await factory({
		principal: { ...input.principal },
		terminalId: input.terminalId,
		workspaceContext: frozen,
		runtimeGeneration: input.runtimeGeneration,
		signal: input.signal ?? boundedSignal(10_000),
	});
	await endpoint.assertCurrent();
	const key = requestKey(input);
	if (activityRequests.has(key))
		throw new Error("Terminal identity is already bound to narrator activity");
	const source = hash([
		endpoint.scope.id,
		endpoint.scope.sourceInstanceId,
		endpoint.scope.workspaceInstanceId,
		endpoint.scope.deviceId,
		endpoint.scope.canonicalRoot,
		endpoint.scope.rootIdentityJson,
		endpoint.runtime,
	]);
	const existing = terminalActivities.get(key);
	if (existing) {
		if (
			existing.sourceKey !== source ||
			existing.actorSubjectKey !== `user:${input.principal.userId}` ||
			existing.terminalId !== input.terminalId
		)
			throw new Error("Terminal activity source or actual actor changed");
		return;
	}
	if (terminalActivities.size + activities.size >= MAX_TRACKED_ACTIVITIES)
		throw new Error("Workspace activity registry capacity exceeded; no live writer eviction");
	const token = endpoint.coordinator.registerActivity({
		scope: endpoint.scope,
		runtime: endpoint.runtime,
	});
	try {
		await endpoint.assertCurrent();
	} catch (error) {
		endpoint.coordinator.endActivity(token, "unknown");
		throw error;
	}
	terminalActivities.set(key, {
		endpoint,
		token,
		sourceKey: source,
		actorSubjectKey: `user:${input.principal.userId}`,
		terminalId: input.terminalId,
	});
}

export async function finishRemoteActivity(input: {
	target: ToolExecutionTarget;
	binding?: ToolCallBinding;
	activityId?: string;
	outcome: "finished" | "unknown";
}): Promise<void> {
	const key = requestKey(input);
	const terminal = terminalActivities.get(key);
	if (terminal) {
		if (terminal.outcome) return;
		try {
			terminal.endpoint.coordinator.endActivity(terminal.token, input.outcome);
			terminal.outcome = input.outcome;
			terminalActivities.delete(key);
		} catch (error) {
			terminal.outcome = "unknown";
			throw error;
		}
		return;
	}
	const id = activityRequests.get(key);
	if (id) await settleActivity(id, input.outcome);
}

function boundaryFor(
	attempt: RemoteTreeAttempt,
	edge: "before" | "after",
	policyDigest: string,
): RemoteTreeBoundary {
	const binding = attempt.context.binding;
	if (!binding) throw new Error("Remote capture lost its persisted attempt binding");
	const operationId = `tree_${hash([attempt.endpoint.history.binding.sourceInstanceId, attempt.endpoint.history.binding.scopeId, binding.toolCallId, binding.attempt, edge]).slice(0, 48)}`;
	return {
		narratorId: attempt.actor.narratorId,
		toolUseId: attempt.context.toolUse.toolUseId,
		toolName: attempt.context.toolUse.name,
		binding,
		edge,
		deviceId: attempt.backend.deviceId,
		contextKey: attempt.contextKey,
		workspaceRevision: attempt.workspaceRevision,
		originProjectId: attempt.actor.projectId ?? null,
		originContextVersion: 1,
		actorSubjectKey: `user:${attempt.actor.userId}`,
		historyBinding: { ...attempt.endpoint.history.binding },
		operationId,
		requestDigest: hash([
			operationId,
			attempt.endpoint.history.binding,
			attempt.actor.userId,
			attempt.contextKey,
			attempt.workspaceRevision,
			policyDigest,
			"whole_directory",
		]),
	};
}
async function capture(
	attempt: RemoteTreeAttempt,
	edge: "before" | "after",
	phase: "hot" | "warm",
	original?: { boundary: RemoteTreeBoundary; request: RemoteHistoryRequest },
): Promise<{
	boundary: RemoteTreeBoundary;
	request: RemoteHistoryRequest;
	receipt?: RemoteHistoryReceipt;
}> {
	const deps = attempt.dependencies;
	const signal = boundedSignal(
		phase === "hot"
			? (deps.hotBudgetMs ?? REMOTE_TREE_HOT_BUDGET_MS)
			: (deps.warmBudgetMs ?? REMOTE_TREE_WARM_BUDGET_MS),
	);
	const policy = await deps.policy(attempt.actor, attempt.target, attempt.backend, signal);
	if (original && original.request.treePolicy?.policyDigest !== policy.policyDigest)
		throw new Error("Remote tree read policy changed before warm retry");
	const boundary = original?.boundary ?? boundaryFor(attempt, edge, policy.policyDigest);
	const request: RemoteHistoryRequest = {
		...(original?.request ?? {
			binding: { ...attempt.endpoint.history.binding },
			operationId: boundary.operationId,
			requestDigest: boundary.requestDigest,
			treePolicy: policy,
		}),
		capturePhase: phase,
	};
	if (!original) await attempt.store.begin(boundary);
	try {
		const receipt = await waitBounded(
			attempt.endpoint.history.captureTree(request, signal),
			signal,
		);
		validateRemoteTreeReceipt(boundary, receipt);
		if (receipt.policyDigest !== policy.policyDigest || receipt.capturePhase !== phase)
			throw new Error("Remote tree capture policy/phase mismatch");
		const currentPolicy = await deps.policy(attempt.actor, attempt.target, attempt.backend, signal);
		if (currentPolicy.policyDigest !== policy.policyDigest)
			throw new Error("Remote tree read policy changed during capture");
		await attempt.store.finish(boundary, receipt, phase);
		return { boundary, request, receipt };
	} catch (error) {
		await attempt.store.unavailable(boundary, signal.aborted ? "unknown" : "failed");
		logger.warn("Remote whole-directory snapshot unavailable", {
			narratorId: attempt.actor.narratorId,
			toolCallId: boundary.binding.toolCallId,
			attempt: boundary.binding.attempt,
			edge,
			deviceId: attempt.backend.deviceId,
			operationId: boundary.operationId,
			error: String(error),
		});
		return { boundary, request };
	}
}
function scheduleWarm(
	attempt: RemoteTreeAttempt,
	edge: "before" | "after",
	hot: {
		boundary: RemoteTreeBoundary;
		request: RemoteHistoryRequest;
		receipt?: RemoteHistoryReceipt;
	},
): void {
	if (hot.receipt?.coverage === "complete" || warmJobs.has(hot.boundary.operationId)) return;
	if (warmJobs.size >= MAX_WARM_JOBS) {
		logger.warn("Remote snapshot warm queue is full; hot coverage remains unavailable/partial", {
			operationId: hot.boundary.operationId,
		});
		return;
	}
	const task = capture(attempt, edge, "warm", hot)
		.then(() => {})
		.catch((error) => {
			logger.warn("Remote snapshot warm observation failed", {
				operationId: hot.boundary.operationId,
				error: String(error),
			});
		})
		.finally(() => warmJobs.delete(hot.boundary.operationId));
	warmJobs.set(hot.boundary.operationId, task);
}
const beforeCaptures = new WeakMap<RemoteTreeAttempt, Awaited<ReturnType<typeof capture>>>();
export async function beforeRemoteTreeSnapshot(
	options: RemoteTreeSnapshotHookOptions,
	context: ToolExecutionLifecycleContext,
): Promise<RemoteTreeAttempt | undefined> {
	if (!settings.chapters.treeSnapshotsEnabled) return undefined;
	const deps = options.dependencies ?? productionDependencies;
	if (
		!context.executionTarget ||
		context.executionTarget.backendKind !== "remote" ||
		!context.binding ||
		!options.userId
	) {
		logger.warn("Remote tree capture unavailable: immutable endpoint/attempt/actor missing", {
			narratorId: options.narratorId,
			toolUseId: context.toolUse.toolUseId,
		});
		return undefined;
	}
	const store = await deps.store();
	await store.validate({
		narratorId: options.narratorId,
		toolUseId: context.toolUse.toolUseId,
		toolName: context.toolUse.name,
		binding: context.binding,
	});
	const backend = deps.backend(context.executionTarget.deviceId);
	let target: RemoteHistoryTarget;
	try {
		target = remoteTarget(context.executionTarget, backend);
	} catch (error) {
		if (!(error instanceof RemoteTreeCoverageUnavailable)) throw error;
		logger.warn(
			"Remote tree scope cannot cover this independently admitted file; capture unavailable",
			{ deviceId: backend.deviceId, toolCallId: context.binding.toolCallId, error: String(error) },
		);
		return undefined;
	}
	const actor: RemoteHistoryActor = {
		narratorId: options.narratorId,
		userId: options.userId,
		projectId: options.projectId ?? null,
		kind: (await deps.actorKind?.(options.narratorId)) ?? "primary",
	};
	let endpoint: Endpoint;
	try {
		endpoint = await (await deps.runtime()).resolveWorkspace(actor, target, boundedSignal(10_000));
	} catch (error) {
		if (isBarrier(error)) throw error;
		logger.warn("Remote snapshot identity unavailable; no host fallback", {
			narratorId: options.narratorId,
			deviceId: target.deviceId,
			error: String(error),
		});
		return undefined;
	}
	const source = sourceKey(endpoint, backend.deviceId);
	const contextKey =
		options.workspaceContext?.deviceId === target.deviceId &&
		backend.paths.equals(options.workspaceContext.cwd, target.cwd)
			? options.workspaceContext.contextKey
			: hash([source, backend.paths.identityKey(target.cwd)]);
	const activityKey =
		context.toolUse.name === "Bash"
			? createActivity(
					endpoint,
					target,
					requestKey({ target: context.executionTarget, binding: context.binding }),
					false,
					`user:${actor.userId}`,
					actor.narratorId,
				)
			: undefined;
	const attempt: RemoteTreeAttempt = {
		context: {
			...context,
			binding: { ...context.binding },
			executionTarget: { ...context.executionTarget },
		},
		actor,
		target,
		endpoint,
		backend,
		options,
		store,
		dependencies: deps,
		contextKey,
		workspaceRevision: options.workspaceContext?.revision ?? 0,
		activityKey,
	};
	if (!endpoint.history.backend.supportsRemoteTreeCapture) {
		logger.warn("Remote whole-directory capture requires executor upgrade", {
			deviceId: target.deviceId,
		});
		return attempt;
	}
	try {
		const before = await capture(attempt, "before", "hot");
		beforeCaptures.set(attempt, before);
	} catch (error) {
		if (activityKey) await settleActivity(activityKey, "finished");
		if (isBarrier(error)) throw error;
		logger.warn("Remote snapshot before boundary unavailable", {
			deviceId: target.deviceId,
			error: String(error),
		});
	}
	return attempt;
}
export async function afterRemoteTreeSnapshot(
	attempt: RemoteTreeAttempt,
	context: ToolExecutionLifecycleContext & { result?: ToolResult; error?: unknown },
): Promise<void> {
	const activityKey = attempt.activityKey;
	const activity = activityKey ? activities.get(activityKey) : undefined;
	const run = async () => {
		if (activity && activityKey && !activity.outcome) {
			if (activity.adopted) {
				if ((await activity.settled) === "unknown") return;
			} else if (context.result?.metadata?.background_task_id) {
				await settleActivity(activityKey, "unknown");
				return;
			} else await settleActivity(activityKey, context.error ? "unknown" : "finished");
		}
		if (!attempt.endpoint.history.backend.supportsRemoteTreeCapture) return;
		const registry = await attempt.dependencies.runtime();
		const endpoint = await registry.resolveWorkspace(
			attempt.actor,
			attempt.target,
			boundedSignal(10_000),
		);
		if (!sameSource(attempt.endpoint, endpoint))
			throw new Error("Remote snapshot source/root changed between tool boundaries");
		const afterAttempt = { ...attempt, endpoint };
		const after = await capture(afterAttempt, "after", "hot");
		const before = beforeCaptures.get(attempt);
		beforeCaptures.delete(attempt);
		// Warm completion is a later concurrent observation, never promoted into tool ownership.
		if (before) scheduleWarm(attempt, "before", before);
		scheduleWarm(afterAttempt, "after", after);
	};
	const guardedRun = async () => {
		try {
			await run();
		} catch (error) {
			const before = beforeCaptures.get(attempt);
			beforeCaptures.delete(attempt);
			if (before?.request.treePolicy) {
				const unavailable = boundaryFor(attempt, "after", before.request.treePolicy.policyDigest);
				try {
					await attempt.store.begin(unavailable);
					await attempt.store.unavailable(unavailable, isBarrier(error) ? "unknown" : "failed");
				} catch (metadataError) {
					logger.warn("Remote snapshot unavailable metadata persistence failed", {
						toolCallId: unavailable.binding.toolCallId,
						error: String(metadataError),
					});
				}
			}
			logger.warn("Remote activity after-capture unavailable; unknown barriers are not cleared", {
				deviceId: attempt.target.deviceId,
				error: String(error),
			});
		}
	};
	if (activity?.adopted && !activity.outcome) {
		void guardedRun();
		return;
	}
	await guardedRun();
}

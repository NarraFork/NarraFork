import { afterAll, afterEach, expect, mock, test } from "bun:test";
import type {
	GitStagingObservationState,
	GitStatusPagesWatchState,
	GitWorkspaceCategory,
	GitWorkspaceSnapshot,
} from "@shared/git-workspace-events";
import { posixPathSemantics } from "../lib/agent/execution/path-semantics";
import { AppError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("Missing expected snapshot fixture value");
	return value;
}
async function waitForState(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
	const deadline = performance.now() + timeoutMs;
	while (!predicate()) {
		if (performance.now() >= deadline)
			throw new Error("Timed out waiting for observable Git watch state");
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
}

import type { GitWorkspaceTarget } from "../services/git-workspace";
import type { GitStagingWatchAuthorization } from "../services/git-workspace-watch";

const authModule = await import("../lib/auth");
let sessionLive = true;
let sessionChecks = 0;
mock.module("../lib/auth", () => ({
	...authModule,
	resolveLiveSession: async () => {
		sessionChecks++;
		return sessionLive ? { sub: "owner", role: "user" } : null;
	},
}));
const accessModule = await import("../services/git-workspace-access");
const watchModule = await import("../services/git-workspace-watch");
const managementModule = await import("../services/git-management-service");
const completedSamples: Array<{ generation: number; worktree?: string }> = [];
const snapshotFacts = (revision = 1) => ({
	revision,
	updating: false,
	status: {
		hasChanges: true,
		staged: 0,
		unstaged: 1,
		untracked: 0,
		totalFiles: 1,
		totalFilesExact: true,
		headSha: "sha",
		branch: "main",
		files: [{ status: " M", path: "private-file" }],
	},
	lineStats: {
		linesAdded: 12,
		linesRemoved: 2,
		complete: false,
		files: [{ path: "private-file", complete: false }],
	},
	detailsTruncated: true,
});
let subscriptions = 0;
let invalidations = 0;
const refreshed: GitWorkspaceTarget[] = [];
const snapshotCallbacks: Array<(snapshot: GitWorkspaceSnapshot) => void> = [];
const stagingAuthorizations: GitStagingWatchAuthorization[] = [];
const deniedUsers = new Set<string>();
const realPool = new watchModule.GitWorkspaceWatchPool(
	async (target, signal) => {
		const sample = await watchModule.probeGitWatch(target, signal);
		completedSamples.push({
			generation: target.backend?.runtimeGeneration ?? 0,
			worktree: sample.fingerprints.worktree,
		});
		return sample;
	},
	5,
	{
		status: async () => snapshotFacts().status,
		lineStats: async () => snapshotFacts().lineStats,
		invalidate: () => {},
		validate: () => {},
	},
);
let integrationTarget: GitWorkspaceTarget | undefined;
const narratorTargets = new Map<string, GitWorkspaceTarget>();
const integrationCallbacks = new Set<(categories: GitWorkspaceCategory[]) => Promise<void>>();
let denied = false;
let failure: unknown;
let authorizations = 0;
const metadataAuthorizations: Array<boolean | GitWorkspaceTarget | undefined> = [];
let hold: Promise<void> | undefined;
let stagingHold: Promise<void> | undefined;
let notify:
	| ((categories: GitWorkspaceCategory[], pages?: GitStatusPagesWatchState) => Promise<void>)
	| undefined;
let stops = 0;
let principal = "";
mock.module("../services/git-workspace-access", () => ({
	...accessModule,
	authorizeGitTargetForPrincipal: async (
		user: { userId: string },
		origin: { narratorId: string },
		_need: "read" | "write",
		_signal: AbortSignal,
		_cached?: boolean,
		_recover?: boolean,
		metadataDiscovery?: boolean | GitWorkspaceTarget,
	) => {
		metadataAuthorizations.push(metadataDiscovery);
		authorizations++;
		principal = user.userId;
		await hold;
		if (denied || deniedUsers.has(user.userId)) throw new Error("denied");
		if (failure) throw failure;
		const narratorTarget = narratorTargets.get(origin.narratorId);
		if (narratorTarget) return narratorTarget;
		if (integrationTarget) return integrationTarget;
		return {
			workspace: {
				deviceId: "local",
				workspaceKey: "key",
				repositoryKey: "repo",
				state: "ready",
				capabilities: { read: true },
			},
			backend: { runtimeGeneration: 1 },
		};
	},
	requireReadyGitTarget: () => {},
}));
mock.module("../services/git-workspace-watch", () => ({
	...watchModule,
	settleGitStagingWatch: async () => {
		await stagingHold;
	},
	GitWorkspaceWatchPool: class {
		refresh(target: GitWorkspaceTarget) {
			refreshed.push(target);
			if (integrationTarget) realPool.refresh(target);
		}
		subscribe(
			target: GitWorkspaceTarget,
			changed: NonNullable<typeof notify>,
			snapshot?: (value: GitWorkspaceSnapshot) => void,
			staging?: GitStagingWatchAuthorization,
		) {
			subscriptions++;
			if (staging) stagingAuthorizations.push(staging);
			if (snapshot) snapshotCallbacks.push(snapshot);
			if (integrationTarget) {
				integrationCallbacks.add(changed);
				const stop = realPool.subscribe(target, changed, snapshot, staging);
				return () => {
					integrationCallbacks.delete(changed);
					stop();
				};
			}
			notify = changed;
			return () => {
				stops++;
			};
		}
	},
}));
mock.module("../services/git-management-service", () => ({
	...managementModule,
	validateGitFileTargets: async () => {},
	invalidateGitWorkspace: () => {
		invalidations++;
	},
}));
const { handleGitWorkspaceMessage, releaseGitWorkspaceSubscriptions } = await import(
	"./git-workspace-ws"
);
const frames: {
	type: string;
	workspaceKey?: string;
	snapshot?: GitWorkspaceSnapshot;
	view?: string;
	version?: number;
	statusPagesChanged?: boolean;
	statusPagesReliable?: boolean;
	deviceId?: string;
	listId?: string;
	metadataChanged?: boolean;
	metadataListId?: string;
	affectedListIds?: string[];
	generation?: number;
	observationId?: string | null;
	observation?: GitStagingObservationState;
}[] = [];
const ws = {
	data: { userId: "owner", userRole: "user", sessionId: "live-session" },
	send(raw: string) {
		frames.push(JSON.parse(raw));
	},
};
const message = {
	type: "git_workspace_subscribe" as const,
	subscriptionId: "panel",
	narratorId: "narrator",
};
afterEach(() => {
	releaseGitWorkspaceSubscriptions(ws);
	denied = false;
	failure = undefined;
	authorizations = 0;
	metadataAuthorizations.length = 0;
	hold = undefined;
	stagingHold = undefined;
	integrationTarget = undefined;
	narratorTargets.clear();
	integrationCallbacks.clear();
	completedSamples.length = 0;
	frames.length = 0;
	stops = 0;
	subscriptions = 0;
	invalidations = 0;
	refreshed.length = 0;
	snapshotCallbacks.length = 0;
	stagingAuthorizations.length = 0;
	sessionLive = true;
	sessionChecks = 0;
	deniedUsers.clear();
	notify = undefined;
});
afterAll(() => {
	mock.module("../lib/auth", () => authModule);
	mock.module("../services/git-workspace-access", () => accessModule);
	mock.module("../services/git-workspace-watch", () => watchModule);
	mock.module("../services/git-management-service", () => managementModule);
});
const pendingObservation: GitStagingObservationState = {
	instanceId: "observation-instance",
	stateSequence: 1,
	epoch: 2,
	completedEpoch: 0,
	round: 0,
	status: "pending",
	generation: 2,
	observationId: "published",
};

test("observation states reauthorize and carry a sequence independent of published generation", async () => {
	await handleGitWorkspaceMessage(ws, message);
	const staging = required(stagingAuthorizations[0]);
	expect(staging.writable).toBe(false);
	staging.observation(pendingObservation);
	await waitForState(() =>
		frames.some((frame) => frame.type === "git_workspace_staging_observation"),
	);
	expect(frames.at(-1)).toMatchObject({
		type: "git_workspace_staging_observation",
		workspaceKey: "key",
		observation: pendingObservation,
	});
	staging.observation({
		...pendingObservation,
		stateSequence: 2,
		status: "failed",
		errorCode: "GIT_STAGING_LIMIT",
	});
	await waitForState(() => frames.at(-1)?.observation?.stateSequence === 2);
	staging.observation({
		...pendingObservation,
		stateSequence: 3,
		status: "settled",
		completedEpoch: 2,
	});
	await waitForState(() => frames.at(-1)?.observation?.stateSequence === 3);
	expect(frames.at(-1)?.observation).toMatchObject({ generation: 2, status: "settled" });
	expect(authorizations).toBe(4);
});

test("observation disclosure still rejects revoked read access and late callbacks after unsubscribe", async () => {
	await handleGitWorkspaceMessage(ws, message);
	const staging = required(stagingAuthorizations[0]);
	denied = true;
	staging.observation(pendingObservation);
	await waitForState(() => frames.at(-1)?.type === "git_workspace_error");
	expect(frames.some((frame) => frame.type === "git_workspace_staging_observation")).toBe(false);
	const count = frames.length;
	staging.observation({
		...pendingObservation,
		stateSequence: 2,
		status: "settled",
		completedEpoch: 2,
	});
	await new Promise((resolve) => setTimeout(resolve, 5));
	expect(frames).toHaveLength(count);
});

test("background observation refreshes its live session, writable narrator grant and complete paths", async () => {
	const authorizeFilePaths = mock(async (_paths: readonly string[], _need: "read" | "write") => {});
	narratorTargets.set("narrator", {
		workspace: {
			deviceId: "local",
			workspaceKey: "key",
			repositoryKey: "repo",
			rootPath: "/authorized",
			cwd: "/authorized",
			state: "ready",
			capabilities: { read: true, write: true },
		},
		backend: { kind: "local", runtimeGeneration: 1 } as NonNullable<GitWorkspaceTarget["backend"]>,
		authorizeFilePaths,
	} as GitWorkspaceTarget);
	await handleGitWorkspaceMessage(ws, message);
	const staging = required(stagingAuthorizations[0]);
	expect(staging.writable).toBe(true);
	await staging.beforeWrite();
	await staging.authorizePaths(["visible", "hidden/old"]);
	expect(authorizeFilePaths).toHaveBeenCalledWith(["visible", "hidden/old"], "write");
	await staging.beforeWrite();
	expect(sessionChecks).toBe(2);
	sessionLive = false;
	await expect(staging.beforeWrite()).rejects.toMatchObject({
		code: "GIT_WORKSPACE_ACCESS_DENIED",
	});
	expect(authorizeFilePaths).toHaveBeenCalledTimes(1);
});

test("background observation cannot retain authority after workspace rebinding or narrator revocation", async () => {
	const target = {
		workspace: {
			deviceId: "local",
			workspaceKey: "key",
			repositoryKey: "repo",
			rootPath: "/authorized",
			cwd: "/authorized",
			state: "ready",
			capabilities: { read: true, write: true },
		},
		backend: { kind: "local", runtimeGeneration: 1 } as NonNullable<GitWorkspaceTarget["backend"]>,
		authorizeFilePaths: async () => {},
	} as GitWorkspaceTarget;
	narratorTargets.set("narrator", target);
	await handleGitWorkspaceMessage(ws, message);
	const staging = required(stagingAuthorizations[0]);
	narratorTargets.set("narrator", {
		...target,
		workspace: { ...target.workspace, rootPath: "/changed-root" },
	});
	await expect(staging.beforeWrite()).rejects.toMatchObject({ code: "GIT_WORKSPACE_CHANGED" });
	denied = true;
	await expect(staging.beforeWrite()).rejects.toThrow("denied");
});

test("ack contains server-resolved identity; notification rechecks principal", async () => {
	await handleGitWorkspaceMessage(ws, message);
	expect(principal).toBe("owner");
	expect(frames[0]).toMatchObject({ type: "git_workspace_subscribed", workspaceKey: "key" });
	await notify?.(["worktree"]);
	expect(frames.at(-1)?.type).toBe("git_workspace_changed");
});
test("independent page validation state is authorized and forwarded even without statistic changes", async () => {
	await handleGitWorkspaceMessage(ws, message);
	await notify?.([], { statusPagesChanged: false, statusPagesReliable: false });
	expect(frames.at(-1)).toMatchObject({
		type: "git_workspace_changed",
		statusPagesChanged: false,
		statusPagesReliable: false,
	});
	expect(authorizations).toBe(2);
	await notify?.(["worktree"], { statusPagesChanged: false, statusPagesReliable: true });
	expect(frames.at(-1)).toMatchObject({
		type: "git_workspace_changed",
		statusPagesChanged: false,
		statusPagesReliable: true,
	});
});

test("denied subscription never acks; a target without a narrator fails closed", async () => {
	denied = true;
	await handleGitWorkspaceMessage(ws, message);
	expect(frames.map((frame) => frame.type)).toEqual(["git_workspace_error"]);
	frames.length = 0;
	denied = false;
	await handleGitWorkspaceMessage(ws, { ...message, narratorId: undefined });
	expect(frames.map((frame) => frame.type)).toEqual(["git_workspace_error"]);
});
test("revocation stops subscription without disclosing changes", async () => {
	await handleGitWorkspaceMessage(ws, message);
	denied = true;
	await notify?.(["refs"]);
	expect(frames.at(-1)?.type).toBe("git_workspace_error");
	expect(stops).toBe(1);
});
test("unsubscribe during authorization prevents late ack and watcher", async () => {
	let finish = () => {};
	hold = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const subscribing = handleGitWorkspaceMessage(ws, message);
	await handleGitWorkspaceMessage(ws, {
		type: "git_workspace_unsubscribe",
		subscriptionId: "panel",
	});
	finish();
	await subscribing;
	expect(frames).toHaveLength(0);
});
test("disconnect disposes watcher and suppresses stale callbacks", async () => {
	await handleGitWorkspaceMessage(ws, message);
	releaseGitWorkspaceSubscriptions(ws);
	await notify?.(["index"]);
	expect(stops).toBe(1);
	expect(frames).toHaveLength(1);
});

test("idle heartbeats do not repeat the expensive authorization scan", async () => {
	await handleGitWorkspaceMessage(ws, message);
	await notify?.([]);
	await notify?.([]);
	expect(authorizations).toBe(1);
	expect(frames).toHaveLength(1);
	await notify?.(["worktree"]);
	expect(authorizations).toBe(2);
});

test("temporary device outage retries the subscription without browser polling", async () => {
	await handleGitWorkspaceMessage(ws, message);
	failure = new AppError("offline", 503, "GIT_WATCH_RETRYABLE");
	await notify?.(["worktree"]);
	expect(frames.map((frame) => frame.type)).toEqual(["git_workspace_subscribed"]);
	expect(stops).toBe(1);
	failure = undefined;
	await waitForState(
		() =>
			frames.filter((frame) => frame.type === "git_workspace_subscribed").length === 2 &&
			frames.at(-1)?.type === "git_workspace_changed",
		4000,
	);
	expect(frames.filter((frame) => frame.type === "git_workspace_subscribed")).toHaveLength(2);
	expect(frames.at(-1)?.type).toBe("git_workspace_changed");
}, 10_000);

test("two sockets rebind a real shared watch pool after a generation change without offline", async () => {
	const otherFrames: typeof frames = [];
	const other = {
		...ws,
		send(raw: string) {
			otherFrames.push(JSON.parse(raw));
		},
	};
	let generation = 1;
	let content = "initial";
	const rpcGenerations: number[] = [];
	const makeTarget = (): GitWorkspaceTarget => {
		const boundGeneration = generation;
		return {
			workspace: {
				deviceId: "remote",
				rootPath: "/repo",
				workspaceKey: "key",
				repositoryKey: "repo",
				state: "ready",
				capabilities: { read: true },
			},
			backend: {
				kind: "remote",
				deviceId: "remote",
				pathFlavor: "posix",
				paths: posixPathSemantics,
				runtimeGeneration: boundGeneration,
				supportsGitWorkspaceWatch: true,
				gitWorkspace: async () => {
					rpcGenerations.push(boundGeneration);
					if (boundGeneration !== generation) throw new Error("Stale device generation");
					return { outputs: { worktree: content, index: "index", head: "head", stash: "stash" } };
				},
			},
		} as unknown as GitWorkspaceTarget;
	};
	integrationTarget = makeTarget();
	let disposedCallbacks: Array<(categories: GitWorkspaceCategory[]) => Promise<void>> = [];
	try {
		await handleGitWorkspaceMessage(ws, message);
		await handleGitWorkspaceMessage(other, message);
		await waitForState(
			() =>
				integrationCallbacks.size === 2 &&
				completedSamples.filter((sample) => sample.generation === 1).length >= 2,
		);
		expect(integrationCallbacks.size).toBe(2);
		generation = 2;
		integrationTarget = makeTarget();
		// Both authorized notifications rebind independently: stop A / subscribe
		// fresh A / stop B / subscribe fresh B, while the pool remains shared.
		await Promise.all([...integrationCallbacks].map((callback) => callback(["worktree"])));
		const before = rpcGenerations.length;
		await waitForState(
			() =>
				completedSamples.filter((sample) => sample.generation === 2).length >= 2 &&
				rpcGenerations.length > before &&
				[frames, otherFrames].every(
					(messages) =>
						messages.filter((frame) => frame.type === "git_workspace_subscribed").length === 2,
				),
		);
		expect(rpcGenerations.length).toBeGreaterThan(before);
		expect(rpcGenerations.slice(before).every((value) => value === 2)).toBe(true);
		for (const messages of [frames, otherFrames]) {
			expect(messages.filter((frame) => frame.type === "git_workspace_subscribed")).toHaveLength(2);
			expect(messages.some((frame) => frame.type === "git_workspace_error")).toBe(false);
			messages.length = 0;
		}
		content = "edited after reconnect";
		await waitForState(
			() =>
				frames.some((frame) => frame.type === "git_workspace_changed") &&
				otherFrames.some((frame) => frame.type === "git_workspace_changed"),
		);
		expect(frames.some((frame) => frame.type === "git_workspace_changed")).toBe(true);
		expect(otherFrames.some((frame) => frame.type === "git_workspace_changed")).toBe(true);
		disposedCallbacks = [...integrationCallbacks];
	} finally {
		releaseGitWorkspaceSubscriptions(ws);
		releaseGitWorkspaceSubscriptions(other);
	}
	await waitForState(() => integrationCallbacks.size === 0);
	const before = rpcGenerations.length;
	const beforeAuthorization = authorizations;
	const beforeFrames = JSON.stringify([frames, otherFrames]);
	await Promise.all(disposedCallbacks.map((callback) => callback(["worktree"])));
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(rpcGenerations).toHaveLength(before);
	expect(authorizations).toBe(beforeAuthorization);
	expect(JSON.stringify([frames, otherFrames])).toBe(beforeFrames);
});

test("backpressure closes the socket instead of silently losing its only change", async () => {
	let closed = false;
	const congested = {
		...ws,
		getBufferedAmount: () => 300 * 1024,
		close: () => {
			closed = true;
		},
	};
	await handleGitWorkspaceMessage(congested, message);
	expect(closed).toBe(true);
	expect(stops).toBe(0);
	expect(subscriptions).toBe(0);
	expect(snapshotCallbacks).toHaveLength(0);
	expect(frames).toHaveLength(0);
});

test("subscription attaches after ACK without invalidating shared facts", async () => {
	await handleGitWorkspaceMessage(ws, message);
	expect(frames.map((frame) => frame.type)).toEqual(["git_workspace_subscribed"]);
	expect(subscriptions).toBe(1);
	expect(snapshotCallbacks).toHaveLength(1);
	expect(invalidations).toBe(0);
	expect(refreshed).toHaveLength(0);
});

test("summary and details independently authorize their shared snapshot projections", async () => {
	await handleGitWorkspaceMessage(ws, { ...message, view: "summary" });
	await handleGitWorkspaceMessage(ws, { ...message, subscriptionId: "details", view: "details" });
	const before = authorizations;
	for (const callback of snapshotCallbacks) callback(snapshotFacts());
	await waitForState(
		() => frames.filter((frame) => frame.type === "git_workspace_snapshot").length === 2,
	);
	expect(authorizations).toBe(before + 2);
	const summary = required(frames.find((frame) => frame.view === "summary")?.snapshot);
	const details = required(frames.find((frame) => frame.view === "details")?.snapshot);
	expect(summary.status?.files).toBeUndefined();
	expect(summary.lineStats?.files).toBeUndefined();
	expect(summary.detailsTruncated).toBeUndefined();
	expect(summary.lineStats).toEqual({ linesAdded: 12, linesRemoved: 2, complete: false });
	expect(details).toEqual(snapshotFacts());
	expect(invalidations).toBe(0);
});

test("one subscription switches summary to details and back by replaying its authorized snapshot", async () => {
	await handleGitWorkspaceMessage(ws, { ...message, view: "summary" });
	const publish = required(snapshotCallbacks[0]);
	publish(snapshotFacts(42));
	await waitForState(() => frames.length === 2);
	const initial = required(frames.at(-1)?.snapshot);
	expect(initial.status?.files).toBeUndefined();
	expect(initial.lineStats?.files).toBeUndefined();
	expect(authorizations).toBe(2);

	await handleGitWorkspaceMessage(ws, { ...message, view: "details" });
	expect(authorizations).toBe(3);
	expect(frames.at(-1)).toMatchObject({
		type: "git_workspace_snapshot",
		view: "details",
		snapshot: snapshotFacts(42),
	});
	expect(subscriptions).toBe(1);
	expect(stops).toBe(0);
	expect(invalidations).toBe(0);
	expect(refreshed).toHaveLength(0);

	await handleGitWorkspaceMessage(ws, { ...message, view: "summary" });
	expect(authorizations).toBe(4);
	expect(frames.at(-1)).toMatchObject({
		type: "git_workspace_snapshot",
		view: "summary",
		snapshot: initial,
	});
	expect(frames.at(-1)?.snapshot?.detailsTruncated).toBeUndefined();
	expect(frames.at(-1)?.snapshot?.status?.files).toBeUndefined();
	expect(frames.at(-1)?.snapshot?.lineStats?.files).toBeUndefined();
	expect(frames.map((frame) => frame.type)).toEqual([
		"git_workspace_subscribed",
		"git_workspace_snapshot",
		"git_workspace_snapshot",
		"git_workspace_snapshot",
	]);
	expect(frames.map((frame) => frame.version)).toEqual([1, 2, 3, 4]);
	expect(subscriptions).toBe(1);
	expect(snapshotCallbacks).toEqual([publish]);
	expect(stops).toBe(0);
	expect(invalidations).toBe(0);
	expect(refreshed).toHaveLength(0);

	// The original pool callback remains live and uses the newly selected projection.
	publish(snapshotFacts(43));
	await waitForState(() => frames.length === 5);
	expect(frames.at(-1)).toMatchObject({ view: "summary", version: 5, snapshot: { revision: 43 } });
	expect(frames.at(-1)?.snapshot?.status?.files).toBeUndefined();
	expect(frames.at(-1)?.snapshot?.lineStats?.files).toBeUndefined();
	expect(subscriptions).toBe(1);
});

test("revoked access rejects a same-id details upgrade without disclosing its retained snapshot", async () => {
	await handleGitWorkspaceMessage(ws, { ...message, view: "summary" });
	const publish = required(snapshotCallbacks[0]);
	publish(snapshotFacts());
	await waitForState(() => frames.length === 2);
	expect(JSON.stringify(frames)).not.toContain("private-file");
	denied = true;
	await handleGitWorkspaceMessage(ws, { ...message, view: "details" });
	expect(authorizations).toBe(3);
	expect(frames.map((frame) => frame.type)).toEqual([
		"git_workspace_subscribed",
		"git_workspace_snapshot",
		"git_workspace_error",
	]);
	expect(JSON.stringify(frames)).not.toContain("private-file");
	expect(frames.some((frame) => frame.view === "details")).toBe(false);
	expect(subscriptions).toBe(1);
	expect(stops).toBe(1);
	expect(invalidations).toBe(0);
	expect(refreshed).toHaveLength(0);
	publish(snapshotFacts(2));
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(frames).toHaveLength(3);
	expect(authorizations).toBe(3);
});

test("a shared snapshot never bypasses another principal's revoked access", async () => {
	const otherFrames: typeof frames = [];
	const other = {
		data: { userId: "viewer", userRole: "user" },
		send: (raw: string) => {
			otherFrames.push(JSON.parse(raw));
		},
	};
	try {
		await handleGitWorkspaceMessage(ws, message);
		await handleGitWorkspaceMessage(other, message);
		deniedUsers.add("viewer");
		for (const callback of snapshotCallbacks) callback(snapshotFacts());
		await waitForState(() => frames.length === 2 && otherFrames.length === 2);
		expect(frames.at(-1)?.type).toBe("git_workspace_snapshot");
		expect(otherFrames.map((frame) => frame.type)).toEqual([
			"git_workspace_subscribed",
			"git_workspace_error",
		]);
		expect(JSON.stringify(otherFrames)).not.toContain("private-file");
		expect(stops).toBe(1);
	} finally {
		releaseGitWorkspaceSubscriptions(other);
	}
});

test("manual refresh reauthorizes; a revoked or unknown subscription cannot refresh", async () => {
	await handleGitWorkspaceMessage(ws, message);
	await handleGitWorkspaceMessage(ws, { type: "git_workspace_refresh", subscriptionId: "missing" });
	expect(refreshed).toHaveLength(0);
	expect(authorizations).toBe(1);
	await handleGitWorkspaceMessage(ws, { type: "git_workspace_refresh", subscriptionId: "panel" });
	expect(refreshed).toHaveLength(1);
	expect(authorizations).toBe(2);
	denied = true;
	await handleGitWorkspaceMessage(ws, { type: "git_workspace_refresh", subscriptionId: "panel" });
	expect(authorizations).toBe(3);
	expect(refreshed).toHaveLength(1);
	expect(stops).toBe(1);
	expect(frames.at(-1)?.type).toBe("git_workspace_error");
});

test("pending snapshots coalesce to newest revision and its latest phase during authorization", async () => {
	await handleGitWorkspaceMessage(ws, message);
	let finish = () => {};
	hold = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const publish = required(snapshotCallbacks[0]);
	try {
		publish({ ...snapshotFacts(10), updating: true });
		publish({ ...snapshotFacts(12), updating: true });
		publish(snapshotFacts(11));
		publish(snapshotFacts(12));
		expect(frames).toHaveLength(1);
		finish();
		await waitForState(() => frames.length === 2);
		expect(frames[1]?.snapshot).toEqual(snapshotFacts(12));
		expect(authorizations).toBe(2);
		expect(frames[1]?.version).toBeGreaterThan(frames[0]?.version ?? 0);
	} finally {
		finish();
	}
});

test("snapshot backpressure disposes an attached watcher and suppresses late snapshots", async () => {
	let buffered = 0;
	let closed = false;
	const congested = {
		...ws,
		getBufferedAmount: () => buffered,
		close: () => {
			closed = true;
		},
	};
	try {
		await handleGitWorkspaceMessage(congested, message);
		expect(subscriptions).toBe(1);
		buffered = 300 * 1024;
		const publish = required(snapshotCallbacks[0]);
		publish(snapshotFacts());
		await waitForState(() => closed);
		expect(stops).toBe(1);
		expect(frames).toHaveLength(1);
		const checked = authorizations;
		publish(snapshotFacts(2));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(authorizations).toBe(checked);
		expect(frames).toHaveLength(1);
	} finally {
		releaseGitWorkspaceSubscriptions(congested);
	}
});

const stagingChange = {
	type: "git:staging_lists_changed" as const,
	workspaceKey: "key",
	listId: "A",
};
const listFrames = () =>
	frames.filter((frame) => frame.type === "git_workspace_staging_lists_changed");

test("target group events reauthorize filesystem identity and carry no native Git invalidation", async () => {
	await handleGitWorkspaceMessage(ws, message);
	eventBus.emit(stagingChange);
	await waitForState(() => listFrames().length === 1);
	expect(listFrames()[0]).toMatchObject({ workspaceKey: "key", listId: "A" });
	expect(authorizations).toBe(2);
	expect(metadataAuthorizations[1]).toMatchObject({ workspace: { workspaceKey: "key" } });
	expect(invalidations).toBe(0);
	for (const field of [
		"revision",
		"operationId",
		"source",
		"change",
		"metadataIdentity",
		"deviceId",
	])
		expect(listFrames()[0]).not.toHaveProperty(field);
});

test("generation bursts retain the newest observation and the union of affected groups", async () => {
	await handleGitWorkspaceMessage(ws, message);
	eventBus.emit({
		type: "git:staging_lists_changed",
		workspaceKey: "key",
		generation: 5,
		observationId: "newest",
		affectedListIds: ["A", "B"],
		metadataChanged: true,
	});
	eventBus.emit({
		type: "git:staging_lists_changed",
		workspaceKey: "key",
		generation: 4,
		observationId: "older",
		affectedListIds: ["C"],
	});
	await waitForState(() => listFrames().length === 1);
	expect(listFrames()[0]).toMatchObject({
		generation: 5,
		observationId: "newest",
		affectedListIds: ["A", "B", "C"],
		metadataChanged: true,
	});
	expect(invalidations).toBe(0);
});

test("bursts retain each target and merge its metadata change while authorization is pending", async () => {
	await handleGitWorkspaceMessage(ws, message);
	let release = () => {};
	hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	eventBus.emit(stagingChange);
	await waitForState(() => authorizations === 2);
	eventBus.emit({ ...stagingChange, metadataChanged: true, metadataListId: "A" });
	eventBus.emit({ ...stagingChange, listId: "B" });
	release();
	hold = undefined;
	await waitForState(() => listFrames().length === 2);
	expect(
		listFrames().map((frame) => ({ listId: frame.listId, metadataChanged: frame.metadataChanged })),
	).toEqual([
		{ listId: "A", metadataChanged: true },
		{ listId: "B", metadataChanged: undefined },
	]);
	expect(listFrames()[0]).toHaveProperty("metadataListId", "A");
	expect(invalidations).toBe(0);
});

test("WebSocket delivery waits for the same filesystem baseline before the UI reads", async () => {
	await handleGitWorkspaceMessage(ws, message);
	let release = () => {};
	stagingHold = new Promise<void>((resolve) => {
		release = resolve;
	});
	eventBus.emit(stagingChange);
	try {
		await waitForState(() => authorizations === 2);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(listFrames()).toHaveLength(0);
	} finally {
		release();
		stagingHold = undefined;
	}
	await waitForState(() => listFrames().length === 1);
});

test("metadata-only notifications refresh names without selecting every group", async () => {
	await handleGitWorkspaceMessage(ws, message);
	eventBus.emit({
		type: "git:staging_lists_changed",
		workspaceKey: "key",
		metadataChanged: true,
		metadataListId: "A",
	});
	await waitForState(() => listFrames().length === 1);
	expect(listFrames()[0]).toMatchObject({ metadataChanged: true, metadataListId: "A" });
	expect(listFrames()[0]).not.toHaveProperty("listId");
	expect(frames.filter((frame) => frame.type === "git_workspace_changed")).toHaveLength(0);
});

test("coalescing preserves the identity of each independent metadata target", async () => {
	await handleGitWorkspaceMessage(ws, message);
	let release = () => {};
	hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	eventBus.emit({
		type: "git:staging_lists_changed",
		workspaceKey: "key",
		metadataChanged: true,
		metadataListId: "A",
	});
	await waitForState(() => authorizations === 2);
	eventBus.emit({
		type: "git:staging_lists_changed",
		workspaceKey: "key",
		metadataChanged: true,
		metadataListId: "B",
	});
	release();
	hold = undefined;
	await waitForState(() => listFrames().length === 2);
	expect(
		listFrames()
			.map((frame) => frame.metadataListId)
			.sort(),
	).toEqual(["A", "B"]);
	for (const frame of listFrames()) expect(frame).not.toHaveProperty("listId");
	expect(invalidations).toBe(0);
});

test("different workspaces and remote targets do not receive local group notifications", async () => {
	await handleGitWorkspaceMessage(ws, message);
	eventBus.emit({ ...stagingChange, workspaceKey: "other" });
	await new Promise((resolve) => setTimeout(resolve, 70));
	expect(authorizations).toBe(1);
	expect(listFrames()).toHaveLength(0);
	releaseGitWorkspaceSubscriptions(ws);
	narratorTargets.set("narrator", {
		workspace: { workspaceKey: "key", repositoryKey: "repo", deviceId: "remote" },
		backend: { runtimeGeneration: 1 },
	} as GitWorkspaceTarget);
	await handleGitWorkspaceMessage(ws, message);
	eventBus.emit(stagingChange);
	await new Promise((resolve) => setTimeout(resolve, 70));
	expect(listFrames()).toHaveLength(0);
});

test("group events arriving during initial authorization wait for the authorized acknowledgement", async () => {
	let release = () => {};
	hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	const subscribing = handleGitWorkspaceMessage(ws, { ...message, workspaceKey: "key" });
	eventBus.emit(stagingChange);
	await new Promise((resolve) => setTimeout(resolve, 60));
	expect(frames).toHaveLength(0);
	release();
	hold = undefined;
	await subscribing;
	await waitForState(() => listFrames().length === 1);
	expect(frames[0]?.type).toBe("git_workspace_subscribed");
});

test("permission revocation drops group events before disclosure", async () => {
	await handleGitWorkspaceMessage(ws, message);
	denied = true;
	eventBus.emit(stagingChange);
	await waitForState(() => frames.some((frame) => frame.type === "git_workspace_error"));
	expect(listFrames()).toHaveLength(0);
	expect(stops).toBe(1);
});

test("unsubscribing during group authorization suppresses late notifications", async () => {
	await handleGitWorkspaceMessage(ws, message);
	let release = () => {};
	hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	eventBus.emit(stagingChange);
	await waitForState(() => authorizations === 2);
	await handleGitWorkspaceMessage(ws, {
		type: "git_workspace_unsubscribe",
		subscriptionId: "panel",
	});
	release();
	hold = undefined;
	await new Promise((resolve) => setTimeout(resolve, 70));
	expect(listFrames()).toHaveLength(0);
});

test("group event backpressure closes the socket and releases its watcher", async () => {
	let buffered = 0;
	let closed = false;
	const congested = {
		...ws,
		getBufferedAmount: () => buffered,
		close: () => {
			closed = true;
		},
	};
	try {
		await handleGitWorkspaceMessage(congested, message);
		buffered = 300 * 1024;
		eventBus.emit(stagingChange);
		await waitForState(() => closed);
		expect(stops).toBe(1);
		expect(listFrames()).toHaveLength(0);
	} finally {
		releaseGitWorkspaceSubscriptions(congested);
	}
});

import { describe, expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { GitStagingSummary } from "../../shared/git-staging-lists";
import type {
	GitStagingObservationState,
	GitWorkspaceSnapshot,
} from "../../shared/git-workspace-events";
import { GitWorkspaceSubscriptions } from "./git-workspace-subscription";
import type { MessageCallback } from "./narrator-ws-manager";

function setup(onWorkspaceChanged?: () => void) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const sent: Record<string, unknown>[] = [];
	const listeners = new Map<number, MessageCallback>();
	const listenerTypes = new Set<string>();
	const connections = new Set<(connected: boolean, reconnect: boolean) => void>();
	let id = 0;
	let credential = 1;
	let connectionCredential = credential;
	const credentialListeners = new Set<() => void>();
	const transport = {
		connected: true,
		getCredentialIdentity: () => credential,
		getConnectionCredentialIdentity: () => connectionCredential,
		onCredentialChange: (callback: () => void) => {
			credentialListeners.add(callback);
			return () => {
				credentialListeners.delete(callback);
			};
		},
		send(message: Record<string, unknown>) {
			sent.push(message);
			return true;
		},
		addListener(options: { types?: string[] }, callback: MessageCallback) {
			for (const type of options.types ?? []) listenerTypes.add(type);
			const handle = { _id: ++id };
			listeners.set(handle._id, callback);
			return handle;
		},
		removeListener(handle: { _id: number }) {
			listeners.delete(handle._id);
		},
		onConnectionChange(callback: (connected: boolean, reconnect: boolean) => void) {
			connections.add(callback);
			return () => {
				connections.delete(callback);
			};
		},
	};
	const target = { narratorId: "n", workspaceKey: "w", repositoryKey: "r", canWrite: true };
	const lifecycle = {
		window: new EventTarget(),
		document: Object.assign(new EventTarget(), {
			visibilityState: "visible" as DocumentVisibilityState,
		}),
	};
	const subscriptions = new GitWorkspaceSubscriptions(
		qc,
		transport,
		lifecycle,
		undefined,
		onWorkspaceChanged,
	);
	const connect = (connected: boolean, socketCredential = credential) => {
		if (connected) connectionCredential = socketCredential;
		transport.connected = connected;
		for (const callback of connections) callback(connected, connected);
	};
	const seed = () => {
		for (const prefix of [
			"gitStatus",
			"gitLineStats",
			"gitDiff",
			"gitModifications",
			"gitLog",
			"gitStashList",
		])
			qc.setQueryData([prefix, "w"], { value: 1 });
	};
	const versions = new Map<unknown, number>();
	const emit = (type: string, extra: Record<string, unknown> = {}) => {
		const subscriptionId =
			extra.subscriptionId ??
			sent.filter((message) => message.type === "git_workspace_subscribe").at(-1)?.subscriptionId;
		const version = extra.version ?? (versions.get(subscriptionId) ?? -1) + 1;
		if (typeof version === "number") versions.set(subscriptionId, version);
		for (const callback of listeners.values())
			callback({
				type,
				subscriptionId,
				version,
				narratorId: "n",
				workspaceKey: "w",
				repositoryKey: "r",
				...extra,
			});
	};
	const stale = (prefix: string) => qc.getQueryState([prefix, "w"])?.isInvalidated;
	return {
		qc,
		sent,
		listeners,
		listenerTypes,
		connections,
		target,
		subscriptions,
		seed,
		emit,
		stale,
		connect,
		setCredential: (value: number) => {
			credential = value;
			for (const callback of credentialListeners) callback();
		},
		lifecycle,
	};
}

const snapshot = (revision = 1, updating = false): GitWorkspaceSnapshot => ({
	revision,
	updating,
	status: {
		hasChanges: true,
		staged: 0,
		unstaged: 1,
		untracked: 0,
		totalFiles: 1,
		headSha: "sha",
		branch: "main",
		files: [{ status: " M", path: "a.ts" }],
	},
	lineStats: { linesAdded: 8, linesRemoved: 2, complete: true, files: [] },
});

function observationState(
	overrides: Partial<GitStagingObservationState> = {},
): GitStagingObservationState {
	return {
		instanceId: "observer-1",
		stateSequence: 1,
		epoch: 1,
		completedEpoch: 1,
		round: 1,
		status: "settled",
		generation: 1,
		observationId: "o1",
		...overrides,
	};
}
function stagingSummary(): GitStagingSummary {
	return {
		capability: { supported: true },
		workspaceKey: "w",
		initialized: true,
		generation: 1,
		observationId: "o1",
		activeListId: "A",
		scannedAt: 1,
		state: "ready",
		stats: {},
		lists: [],
	};
}

test("cache publication is versioned independently and HTTP publishers cannot revive old Workers or grants", () => {
	const s = setup();
	const off = s.subscriptions.subscribe(s.target);
	s.emit("git_workspace_subscribed", { version: 0 });
	const state = (workerEpoch = "a", memberVersion = 1, statsVersion = 3) => ({
		status: "ready" as const,
		workerEpoch,
		memberVersion,
		statsVersion,
		updating: false,
	});
	s.emit("git_workspace_snapshot", {
		version: 1,
		view: "details",
		snapshot: { ...snapshot(), statusPages: state() },
	});
	const lateA = s.subscriptions.statusPageReadPublisher(s.target);
	const readB = s.subscriptions.statusPageReadPublisher(s.target);
	expect(readB(state("b", 1, 1))).toBe(true);
	expect(lateA(state())).toBe(false);
	expect(s.subscriptions.getStatusPageState(s.target)?.workerEpoch).toBe("b");
	s.emit("git_workspace_snapshot", {
		version: 2,
		view: "details",
		snapshot: { ...snapshot(2), statusPages: state() },
	});
	expect(s.subscriptions.getStatusPageState(s.target)?.workerEpoch).toBe("b");
	const beforeNewMember = s.subscriptions.statusPageReadPublisher(s.target);
	s.emit("git_workspace_snapshot", {
		version: 3,
		view: "details",
		snapshot: { ...snapshot(3), statusPages: state("b", 2, 0) },
	});
	expect(beforeNewMember(state("b", 1, 4))).toBe(false);
	expect(s.subscriptions.getStatusPageState(s.target)?.memberVersion).toBe(2);
	expect(s.subscriptions.getStatusPageState(s.target)?.statsVersion).toBe(0);
	const oldGrant = s.subscriptions.statusPageReadPublisher(s.target);
	s.connect(false);
	s.connect(true);
	s.emit("git_workspace_subscribed", { version: 0 });
	expect(oldGrant(state("c"))).toBe(false);
	const same = s.subscriptions.statusPageReadPublisher(s.target);
	expect(same(state("c"))).toBe(true);
	s.emit("git_workspace_changed", { version: 1, categories: ["worktree"] });
	expect(same(state("c"))).toBe(true);
	expect(s.subscriptions.getStatusPageState(s.target)?.updating).toBe(true);
	s.emit("git_workspace_snapshot", {
		version: 2,
		view: "details",
		snapshot: { ...snapshot(2), statusPages: state("c") },
	});
	expect(s.subscriptions.getStatusPageState(s.target)?.updating).toBe(false);
	off();
	s.qc.clear();
});

test("renewed authorization publishes status pages after its replayed snapshot", () => {
	const s = setup();
	const off = s.subscriptions.subscribe(s.target);
	const state = {
		status: "ready" as const,
		workerEpoch: "worker",
		memberVersion: 1,
		statsVersion: 1,
		updating: false,
	};
	s.emit("git_workspace_subscribed");
	s.emit("git_workspace_snapshot", {
		view: "details",
		snapshot: { ...snapshot(), statusPages: state },
	});
	const oldPublish = s.subscriptions.statusPageReadPublisher(s.target);
	s.subscriptions.unavailable(s.target);
	s.subscriptions.refresh(s.target);
	s.emit("git_workspace_subscribed");
	expect(
		s.qc.getQueryData<GitWorkspaceSnapshot>(["gitWorkspaceSnapshot", "w", "details"]),
	).toMatchObject({ revision: -1, updating: true });
	expect(oldPublish(state)).toBe(false);
	s.emit("git_workspace_snapshot", {
		view: "details",
		snapshot: { ...snapshot(2), statusPages: state },
	});
	expect(s.subscriptions.getStatusPageState(s.target)).toEqual(state);
	expect(s.subscriptions.isStatusPageUpdating(s.target)).toBe(false);
	expect(
		s.qc.getQueryData<GitWorkspaceSnapshot>(["gitWorkspaceSnapshot", "w", "details"]),
	).toMatchObject({ revision: 2, updating: false });
	expect(s.subscriptions.statusPageReadPublisher(s.target)({ ...state, statsVersion: 2 })).toBe(
		true,
	);
	expect(s.subscriptions.getStatusPageState(s.target)?.statsVersion).toBe(2);
	off();
	s.qc.clear();
});

describe("Git authorization continuity", () => {
	test.each([
		true,
		false,
	])("a paused subscription retains its id and only a newer ack resumes it (retrying=%s)", (retrying) => {
		const s = setup();
		const off = s.subscriptions.subscribe(s.target);
		expect(s.subscriptions.canRead(s.target)).toBe(false);
		s.emit("git_workspace_subscribed", { version: 0 });
		s.seed();
		const oldGuard = s.subscriptions.getWriteResultGuard(s.target);
		const oldPublish = s.subscriptions.statusPageReadPublisher(s.target);
		const id = s.sent[0]?.subscriptionId;
		s.emit("git_workspace_error", {
			kind: "retryable",
			code: "DB_READ_WORKER_UNAVAILABLE",
			version: 3,
			retrying,
		});
		expect(s.subscriptions.isDenied(s.target)).toBe(false);
		expect(s.subscriptions.isPush(s.target)).toBe(true);
		expect(s.subscriptions.canRead(s.target)).toBe(false);
		expect(s.subscriptions.getState(s.target)).toBe(retrying ? "paused" : "refresh_required");
		expect(s.qc.getQueryData(["gitStatus", "w"])).toEqual({ value: 1 });
		s.emit("git_workspace_staging_observation", { version: 4, observation: observationState() });
		s.emit("git_workspace_snapshot", { version: 5, view: "details", snapshot: snapshot(99) });
		s.emit("git_workspace_subscribed", { version: 2 });
		expect(s.subscriptions.canRead(s.target)).toBe(false);
		s.subscriptions.refresh(s.target);
		expect(s.sent.at(-1)).toEqual({ type: "git_workspace_refresh", subscriptionId: id });
		s.emit("git_workspace_subscribed", { version: 6 });
		expect(s.subscriptions.canRead(s.target)).toBe(true);
		expect(oldGuard()).toBe(false);
		expect(
			oldPublish({
				status: "ready",
				workerEpoch: "late",
				memberVersion: 9,
				statsVersion: 9,
				updating: false,
			}),
		).toBe(false);
		s.emit("git_workspace_error", {
			kind: "denied",
			code: "GIT_WORKSPACE_ACCESS_DENIED",
			version: 3,
		});
		expect(s.subscriptions.isDenied(s.target)).toBe(false);
		s.emit("git_workspace_staging_observation", { version: 5, observation: observationState() });
		expect(s.subscriptions.isStagingWritable(s.target, stagingSummary())).toBe(false);
		s.emit("git_workspace_staging_observation", { version: 7, observation: observationState() });
		expect(s.subscriptions.isStagingWritable(s.target, stagingSummary())).toBe(true);
		expect(s.sent.filter((message) => message.type === "git_workspace_subscribe")).toHaveLength(1);
		off();
		s.qc.clear();
	});
	test.each([
		"GIT_WORKSPACE_UNAVAILABLE",
		"DB_READ_WORKER_UNAVAILABLE",
		"UNKNOWN",
	])("legacy %s safely pauses without reporting denial", (code) => {
		const s = setup();
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		s.emit("git_workspace_error", { code, version: undefined });
		expect(s.subscriptions.isDenied(s.target)).toBe(false);
		expect(s.subscriptions.canRead(s.target)).toBe(false);
		off();
		s.qc.clear();
	});
	test("capacity retry registers a new id after space is available", () => {
		const s = setup();
		const off = s.subscriptions.subscribe(s.target);
		const oldId = s.sent[0]?.subscriptionId;
		s.emit("git_workspace_error", {
			kind: "unavailable",
			code: "GIT_WORKSPACE_SUBSCRIPTION_LIMIT",
			version: 1,
			retrying: false,
		});
		s.subscriptions.refresh(s.target);
		expect(s.sent.at(-1)?.type).toBe("git_workspace_subscribe");
		expect(s.sent.at(-1)?.subscriptionId).not.toBe(oldId);
		s.emit("git_workspace_subscribed", { version: 0 });
		expect(s.subscriptions.canRead(s.target)).toBe(true);
		off();
		s.qc.clear();
	});
	test("a renewed ack retires old guards and staging observations without a preceding error", () => {
		const s = setup();
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		s.emit("git_workspace_staging_observation", { version: 1, observation: observationState() });
		const oldGuard = s.subscriptions.getWriteResultGuard(s.target);
		s.emit("git_workspace_subscribed", { version: 2 });
		expect(oldGuard()).toBe(false);
		expect(s.subscriptions.getStagingObservation(s.target)).toBeUndefined();
		expect(s.subscriptions.canRead(s.target)).toBe(true);
		s.subscriptions.confirmWorkspace({ ...s.target, canWrite: false });
		expect(s.subscriptions.canWrite(s.target)).toBe(false);
		expect(oldGuard()).toBe(false);
		off();
		s.qc.clear();
	});
	test("identity probes are bounded per failure cycle and replace the repository before resubscribing", () => {
		let probes = 0;
		const s = setup(() => probes++);
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		const oldId = s.sent[0]?.subscriptionId;
		for (const version of [1, 2])
			s.emit("git_workspace_error", {
				kind: "workspace_changed",
				code: "WORKSPACE_KEY_MISMATCH",
				version,
			});
		expect(probes).toBe(1);
		const target = { ...s.target, repositoryKey: "new-repository" };
		s.subscriptions.confirmWorkspace(target);
		s.emit("git_workspace_subscribed", { subscriptionId: oldId, version: 10 });
		expect(s.subscriptions.canRead(target)).toBe(false);
		s.emit("git_workspace_subscribed", { repositoryKey: target.repositoryKey, version: 0 });
		expect(s.subscriptions.canRead(target)).toBe(true);
		s.emit("git_workspace_error", {
			kind: "workspace_changed",
			code: "GIT_WORKSPACE_CHANGED",
			version: 1,
		});
		expect(probes).toBe(2);
		off();
		s.qc.clear();
	});
});

test.each([
	false,
	true,
])("HTTP revocation retires the old server id and rejects late acknowledgements (denied=%s)", (denied) => {
	const s = setup();
	const off = s.subscriptions.subscribe(s.target);
	s.emit("git_workspace_subscribed", { version: 0 });
	s.seed();
	const oldId = s.sent[0]?.subscriptionId;
	const oldGuard = s.subscriptions.getWriteResultGuard(s.target);
	if (denied) s.subscriptions.reject(s.target);
	else s.subscriptions.unavailable(s.target, true);
	expect(s.sent.at(-1)).toEqual({ type: "git_workspace_unsubscribe", subscriptionId: oldId });
	s.emit("git_workspace_subscribed", { subscriptionId: oldId, version: 100 });
	expect(s.subscriptions.canRead(s.target)).toBe(false);
	expect(s.subscriptions.isDenied(s.target)).toBe(denied);
	expect(s.qc.getQueryData(["gitStatus", "w"])).toBeUndefined();
	s.subscriptions.refresh(s.target);
	expect(s.sent.at(-1)?.subscriptionId).not.toBe(oldId);
	s.emit("git_workspace_subscribed", { version: 0 });
	expect(s.subscriptions.canRead(s.target)).toBe(true);
	expect(oldGuard()).toBe(false);
	off();
	s.qc.clear();
});

test.each([
	"ack",
	"http",
])("successful %s authorization clears a retained read refusal", (grant) => {
	const s = setup();
	if (grant === "http") s.connect(false);
	const off = s.subscriptions.subscribe(s.target);
	if (grant === "ack") s.emit("git_workspace_subscribed", { version: 0 });
	else s.subscriptions.confirmWorkspace(s.target);
	const refusal = new Error("Git read refused");
	s.subscriptions.unavailable(s.target, false, refusal);
	expect(s.subscriptions.getReadError(s.target)).toBe(refusal);
	if (grant === "ack") {
		s.emit("git_workspace_subscribed", { version: 0 });
		expect(s.subscriptions.getReadError(s.target)).toBe(refusal);
		s.emit("git_workspace_subscribed", { version: 1 });
	} else s.subscriptions.confirmWorkspace(s.target);
	expect(s.subscriptions.canRead(s.target)).toBe(true);
	expect(s.subscriptions.getReadError(s.target)).toBeUndefined();
	off();
	s.qc.clear();
});

test.each([
	"probe-first",
	"connection-first",
])("principal replacement requires both a matching credential connection and a fresh workspace probe (%s)", (order) => {
	const s = setup();
	s.qc.setQueryData(["auth", "me"], { id: "A" });
	const off = s.subscriptions.subscribe(s.target);
	s.emit("git_workspace_subscribed", { version: 0 });
	const oldId = s.sent[0]?.subscriptionId;
	const oldGuard = s.subscriptions.getWriteResultGuard(s.target);
	s.seed();
	s.qc.setQueryData(["gitWorkspace", "n"], { state: "ready", branch: "private-A" });
	s.setCredential(2);
	s.qc.setQueryData(["auth", "me"], { id: "B" });
	expect(s.subscriptions.canRead(s.target)).toBe(false);
	expect(s.qc.getQueryData(["gitWorkspace", "n"])).toBeUndefined();
	expect(s.qc.getQueryData(["gitStatus", "w"])).toBeUndefined();
	s.emit("git_workspace_subscribed", { subscriptionId: oldId, version: 100 });
	s.subscriptions.refresh(s.target);
	expect(s.sent.filter((message) => message.type === "git_workspace_subscribe")).toHaveLength(1);
	const target = { ...s.target, repositoryKey: "repository-B" };
	if (order === "probe-first") {
		s.subscriptions.confirmWorkspace(target);
		expect(s.sent.filter((message) => message.type === "git_workspace_subscribe")).toHaveLength(1);
		s.connect(false);
		s.connect(true, 1);
		expect(s.subscriptions.canRead(target)).toBe(false);
		expect(s.sent.filter((message) => message.type === "git_workspace_subscribe")).toHaveLength(1);
		s.connect(false);
		s.connect(true, 2);
	} else {
		s.connect(false);
		s.connect(true, 2);
		expect(s.subscriptions.canRead(target)).toBe(false);
		expect(s.sent.filter((message) => message.type === "git_workspace_subscribe")).toHaveLength(1);
		s.subscriptions.confirmWorkspace(target);
	}
	s.emit("git_workspace_subscribed", { repositoryKey: target.repositoryKey, version: 0 });
	expect(s.subscriptions.canRead(target)).toBe(true);
	expect(oldGuard()).toBe(false);
	s.emit("git_workspace_snapshot", {
		subscriptionId: oldId,
		version: 101,
		view: "details",
		snapshot: snapshot(),
	});
	expect(s.qc.getQueryData(["gitStatus", "w"])).toBeUndefined();
	off();
	s.qc.clear();
});

test("an undefined principal gap cannot bless the preceding account's unchanged credential", () => {
	const s = setup();
	s.qc.setQueryData(["auth", "me"], { id: "A" });
	const off = s.subscriptions.subscribe(s.target);
	s.emit("git_workspace_subscribed", { version: 0 });
	s.qc.removeQueries({ queryKey: ["auth", "me"] });
	s.qc.setQueryData(["auth", "me"], { id: "B" });
	s.connect(false);
	s.connect(true, 1);
	expect(() => s.subscriptions.confirmWorkspace(s.target)).toThrow(
		"principal confirmation pending",
	);
	s.emit("git_workspace_subscribed", { version: 99 });
	expect(s.subscriptions.canRead(s.target)).toBe(false);
	expect(s.sent.filter((message) => message.type === "git_workspace_subscribe")).toHaveLength(1);
	s.setCredential(2);
	s.subscriptions.confirmWorkspace(s.target);
	s.connect(false);
	s.connect(true, 2);
	s.emit("git_workspace_subscribed", { version: 0 });
	expect(s.subscriptions.canRead(s.target)).toBe(true);
	off();
	s.qc.clear();
});

test("a token rollback to the trusted account cannot authorize the pending principal", () => {
	const s = setup();
	s.qc.setQueryData(["auth", "me"], { id: "A" });
	const off = s.subscriptions.subscribe(s.target);
	s.emit("git_workspace_subscribed", { version: 0 });
	s.setCredential(2);
	s.qc.setQueryData(["auth", "me"], { id: "B" });
	s.setCredential(1);
	s.connect(false);
	s.connect(true, 1);
	expect(s.subscriptions.canRead(s.target)).toBe(false);
	expect(() => s.subscriptions.confirmWorkspace(s.target)).toThrow(
		"principal confirmation pending",
	);
	s.emit("git_workspace_subscribed", { version: 100 });
	expect(s.subscriptions.canRead(s.target)).toBe(false);
	s.setCredential(2);
	s.connect(false);
	s.connect(true, 2);
	s.subscriptions.confirmWorkspace(s.target);
	s.emit("git_workspace_subscribed", { version: 0 });
	expect(s.subscriptions.canRead(s.target)).toBe(true);
	off();
	s.qc.clear();
});

test("credential changes synchronously retire old frames before the principal cache changes", () => {
	const s = setup();
	s.qc.setQueryData(["auth", "me"], { id: "A" });
	const off = s.subscriptions.subscribe(s.target);
	s.emit("git_workspace_subscribed", { version: 0 });
	const oldId = s.sent[0]?.subscriptionId;
	const oldGuard = s.subscriptions.getWriteResultGuard(s.target);
	s.setCredential(2);
	expect(oldGuard()).toBe(false);
	s.emit("git_workspace_snapshot", {
		subscriptionId: oldId,
		version: 10,
		view: "details",
		snapshot: snapshot(),
	});
	s.emit("git_workspace_subscribed", { subscriptionId: oldId, version: 11 });
	expect(s.qc.getQueryData(["gitStatus", "w"])).toBeUndefined();
	s.connect(false);
	s.connect(true, 2);
	expect(() => s.subscriptions.confirmWorkspace(s.target)).toThrow(
		"principal confirmation pending",
	);
	s.qc.setQueryData(["auth", "me"], { id: "B" });
	s.subscriptions.confirmWorkspace(s.target);
	s.emit("git_workspace_subscribed", { version: 0 });
	expect(s.subscriptions.canRead(s.target)).toBe(true);
	off();
	s.qc.clear();
});

test("a connection opened before a replacement consumer mounts is verified during listener setup", () => {
	const s = setup();
	s.qc.setQueryData(["auth", "me"], { id: "A" });
	const off = s.subscriptions.subscribe(s.target);
	s.emit("git_workspace_subscribed", { version: 0 });
	off();
	s.setCredential(2);
	s.qc.setQueryData(["auth", "me"], { id: "B" });
	s.subscriptions.confirmWorkspace(s.target);
	s.connect(false);
	s.connect(true, 2);
	const release = s.subscriptions.subscribe(s.target);
	s.emit("git_workspace_subscribed", { version: 0 });
	expect(s.subscriptions.canRead(s.target)).toBe(true);
	release();
	s.qc.clear();
});

describe("Git shared staging observation", () => {
	test("a new subscription requires an acknowledged matching settled epoch, not the old ready summary", () => {
		const s = setup();
		const summary = stagingSummary();
		s.qc.setQueryData(["gitStagingLists", "w", "n", undefined], summary);
		const off = s.subscriptions.subscribe(s.target);
		expect(s.subscriptions.isStagingWritable(s.target, summary)).toBe(false);
		s.emit("git_workspace_staging_observation", { observation: observationState() });
		expect(s.subscriptions.isStagingWritable(s.target, summary)).toBe(false);
		s.emit("git_workspace_subscribed", { version: 100 });
		s.emit("git_workspace_staging_observation", { version: 0, observation: observationState() });
		expect(s.subscriptions.isStagingWritable(s.target, summary)).toBe(false);
		s.emit("git_workspace_staging_observation", { version: 101, observation: observationState() });
		expect(s.subscriptions.isStagingWritable(s.target, summary)).toBe(true);
		expect(s.subscriptions.isStagingWritable(s.target, { ...summary, observationId: "old" })).toBe(
			false,
		);
		off();
		s.qc.clear();
	});
	test("pending, observing and failed keep content while retiring selections; same-generation recovery needs no fetch", async () => {
		const s = setup();
		const summary = stagingSummary();
		const key = ["gitStagingLists", "w", "n", undefined];
		s.qc.setQueryData(key, summary);
		s.qc.setQueryData(["gitStagingDiff", "w", "A", "n", undefined, "v1"], { diff: "retained" });
		let reads = 0;
		const observer = new QueryObserver(s.qc, {
			queryKey: key,
			staleTime: Infinity,
			queryFn: async () => {
				reads++;
				return summary;
			},
		});
		const stop = observer.subscribe(() => {});
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		s.emit("git_workspace_staging_observation", { observation: observationState() });
		let oldKey = s.subscriptions.getStagingSelectionKey(s.target);
		for (const [index, status] of (["pending", "observing", "failed"] as const).entries()) {
			s.emit("git_workspace_staging_observation", {
				observation: observationState({
					stateSequence: index + 2,
					epoch: 2,
					completedEpoch: 1,
					status,
				}),
			});
			expect(s.subscriptions.isStagingWritable(s.target, summary)).toBe(false);
			expect(s.subscriptions.getStagingSelectionKey(s.target)).not.toBe(oldKey);
			oldKey = s.subscriptions.getStagingSelectionKey(s.target);
		}
		s.emit("git_workspace_staging_observation", {
			observation: observationState({ stateSequence: 5, epoch: 2, completedEpoch: 2 }),
		});
		await Promise.resolve();
		expect(s.subscriptions.isStagingWritable(s.target, summary)).toBe(true);
		expect(reads).toBe(0);
		expect(s.qc.getQueryData(["gitStagingDiff", "w", "A", "n", undefined, "v1"])).toEqual({
			diff: "retained",
		});
		stop();
		off();
		s.qc.clear();
	});
	test("state ordering ignores stale sequences, old instances, wrong identities and lower epochs", () => {
		const s = setup();
		const summary = stagingSummary();
		s.qc.setQueryData(["gitStagingLists", "w", "n", undefined], summary);
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		s.emit("git_workspace_staging_observation", {
			observation: observationState({
				stateSequence: 10,
				epoch: 3,
				completedEpoch: 2,
				status: "observing",
			}),
		});
		for (const extra of [
			{ observation: observationState({ stateSequence: 9 }) },
			{ observation: observationState({ stateSequence: 11, epoch: 2, completedEpoch: 2 }) },
			{
				narratorId: "other",
				observation: observationState({ stateSequence: 12, epoch: 3, completedEpoch: 3 }),
			},
			{
				repositoryKey: "wrong",
				observation: observationState({ stateSequence: 12, epoch: 3, completedEpoch: 3 }),
			},
		])
			s.emit("git_workspace_staging_observation", extra);
		expect(s.subscriptions.isStagingWritable(s.target, summary)).toBe(false);
		s.emit("git_workspace_staging_observation", {
			observation: observationState({ instanceId: "observer-2" }),
		});
		expect(s.subscriptions.isStagingWritable(s.target, summary)).toBe(true);
		s.emit("git_workspace_staging_observation", {
			observation: observationState({
				stateSequence: 999,
				epoch: 3,
				completedEpoch: 2,
				status: "failed",
			}),
		});
		expect(s.subscriptions.getStagingObservation(s.target)?.instanceId).toBe("observer-2");
		off();
		s.qc.clear();
	});
	test("disconnect and re-subscription retire the verified baseline without dropping readable caches", () => {
		const s = setup();
		const summary = stagingSummary();
		s.qc.setQueryData(["gitStagingLists", "w", "n", undefined], summary);
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		s.emit("git_workspace_staging_observation", {
			observation: observationState({ stateSequence: 50 }),
		});
		const oldId = s.sent[0]?.subscriptionId;
		const oldKey = s.subscriptions.getStagingSelectionKey(s.target);
		s.connect(false);
		expect(s.subscriptions.isStagingWritable(s.target, summary)).toBe(false);
		s.connect(true);
		s.emit("git_workspace_subscribed", { version: 0 });
		s.emit("git_workspace_staging_observation", {
			subscriptionId: oldId,
			observation: observationState({ stateSequence: 99 }),
		});
		expect(s.subscriptions.isStagingWritable(s.target, summary)).toBe(false);
		s.emit("git_workspace_staging_observation", {
			observation: observationState({ instanceId: "restarted" }),
		});
		expect(s.subscriptions.isStagingWritable(s.target, summary)).toBe(true);
		expect(s.subscriptions.getStagingSelectionKey(s.target)).not.toBe(oldKey);
		expect(s.qc.getQueryData(["gitStagingLists", "w", "n", undefined])).toBe(summary);
		off();
		s.qc.clear();
	});
	test("reconnect retains old-instance tombstones after a new instance announces pending", () => {
		const s = setup();
		const summary = stagingSummary();
		s.qc.setQueryData(["gitStagingLists", "w", "n", undefined], summary);
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		s.emit("git_workspace_staging_observation", {
			observation: observationState({ stateSequence: 20 }),
		});
		s.connect(false);
		s.connect(true);
		s.emit("git_workspace_subscribed", { version: 0 });
		s.emit("git_workspace_staging_observation", {
			observation: observationState({
				instanceId: "observer-2",
				status: "pending",
				completedEpoch: 0,
			}),
		});
		s.emit("git_workspace_staging_observation", {
			observation: observationState({ stateSequence: 999, epoch: 0, completedEpoch: 0 }),
		});
		expect(s.subscriptions.getStagingObservation(s.target)?.instanceId).toBe("observer-2");
		expect(s.subscriptions.getStagingObservation(s.target)?.status).toBe("pending");
		expect(s.subscriptions.isStagingWritable(s.target, summary)).toBe(false);
		s.emit("git_workspace_staging_observation", {
			observation: observationState({ instanceId: "observer-2", stateSequence: 2 }),
		});
		expect(s.subscriptions.isStagingWritable(s.target, summary)).toBe(true);
		off();
		s.qc.clear();
	});
	test("fresh grant can accept the same instance's current sequence while local refresh cannot reuse it", () => {
		const s = setup();
		const summary = stagingSummary();
		s.qc.setQueryData(["gitStagingLists", "w", "n", undefined], summary);
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		s.emit("git_workspace_staging_observation", { observation: observationState() });
		s.connect(false);
		s.connect(true);
		s.emit("git_workspace_subscribed", { version: 0 });
		s.emit("git_workspace_staging_observation", { observation: observationState() });
		expect(s.subscriptions.isStagingWritable(s.target, summary)).toBe(true);
		s.subscriptions.beginStagingObservation(s.target);
		s.emit("git_workspace_staging_observation", { observation: observationState() });
		expect(s.subscriptions.isStagingWritable(s.target, summary)).toBe(false);
		off();
		s.qc.clear();
	});
	test.each([
		false,
		true,
	])("a delayed summary response gets one bounded follow-up only when covered=%s is false", async (covered) => {
		const s = setup();
		const old = stagingSummary();
		const next = { ...old, generation: 2, observationId: "o2" };
		const key = ["gitStagingLists", "w", "n", undefined];
		s.qc.setQueryData(key, old);
		let reads = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const observer = new QueryObserver(s.qc, {
			queryKey: key,
			staleTime: Infinity,
			queryFn: async () => {
				reads++;
				if (reads === 1) {
					await gate;
					return covered ? next : old;
				}
				return next;
			},
		});
		const stop = observer.subscribe(() => {});
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		s.emit("git_workspace_staging_lists_changed", {
			version: 1,
			generation: 2,
			observationId: "o2",
			affectedListIds: ["A"],
		});
		const pending = s.subscriptions.invalidateStagingObservation(s.target, 2, ["A"]);
		s.emit("git_workspace_staging_observation", {
			observation: observationState({ generation: 2, observationId: "o2" }),
		});
		expect(s.subscriptions.isStagingWritable(s.target, old)).toBe(false);
		release();
		await pending;
		expect(reads).toBe(covered ? 1 : 2);
		expect(s.subscriptions.isStagingWritable(s.target, s.qc.getQueryData(key))).toBe(true);
		stop();
		off();
		s.qc.clear();
	});
	test("an unavailable target summary is never polled beyond one verification follow-up", async () => {
		const s = setup();
		const summary = stagingSummary();
		const key = ["gitStagingLists", "w", "n", undefined];
		s.qc.setQueryData(key, summary);
		let reads = 0;
		const observer = new QueryObserver(s.qc, {
			queryKey: key,
			staleTime: Infinity,
			queryFn: async () => {
				reads++;
				return summary;
			},
		});
		const stop = observer.subscribe(() => {});
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		s.subscriptions.publishStagingObservation(
			s.target,
			observationState({ generation: 2, observationId: "o2" }),
		);
		await s.subscriptions.invalidateStagingObservation(s.target, 2, [], true);
		expect(reads).toBe(2);
		expect(s.subscriptions.isStagingWritable(s.target, summary)).toBe(false);
		stop();
		off();
		s.qc.clear();
	});
	test("a late lower-generation ownership notice cannot retire a newer HTTP-verified observation", () => {
		const s = setup();
		const summary = { ...stagingSummary(), generation: 2, observationId: "o2" };
		s.qc.setQueryData(["gitStagingLists", "w", "n", undefined], summary);
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		s.subscriptions.publishStagingObservation(
			s.target,
			observationState({ generation: 2, observationId: "o2" }),
		);
		const selected = s.subscriptions.getStagingSelectionKey(s.target);
		s.emit("git_workspace_staging_lists_changed", {
			version: 1,
			generation: 1,
			observationId: "o1",
			affectedListIds: ["A"],
		});
		expect(s.subscriptions.getStagingSelectionKey(s.target)).toBe(selected);
		expect(s.subscriptions.isStagingWritable(s.target, summary)).toBe(true);
		s.emit("git_workspace_staging_lists_changed", {
			version: 2,
			generation: 3,
			observationId: "o3",
			affectedListIds: ["A"],
		});
		expect(s.subscriptions.isStagingWritable(s.target, summary)).toBe(false);
		off();
		s.qc.clear();
	});
	test("an access hint renews only its grant and recovers from fresh authorization without file changes", () => {
		const s = setup();
		const summary = stagingSummary();
		const other = { ...s.target, narratorId: "other" };
		s.qc.setQueryData(["gitStagingLists", "w", "n", undefined], summary);
		s.qc.setQueryData(["gitStagingLists", "w", "other", undefined], summary);
		const off = s.subscriptions.subscribe(s.target);
		const id = s.sent[0]?.subscriptionId;
		s.emit("git_workspace_subscribed", { version: 0, subscriptionId: id });
		s.emit("git_workspace_staging_observation", {
			subscriptionId: id,
			observation: observationState(),
		});
		const otherOff = s.subscriptions.subscribe(other);
		const otherId = s.sent.at(-1)?.subscriptionId;
		s.emit("git_workspace_subscribed", {
			version: 0,
			subscriptionId: otherId,
			narratorId: "other",
		});
		s.emit("git_workspace_staging_observation", {
			subscriptionId: otherId,
			narratorId: "other",
			observation: observationState(),
		});
		const oldGuard = s.subscriptions.getWriteResultGuard(s.target);
		const otherGuard = s.subscriptions.getWriteResultGuard(other);
		const otherSelection = s.subscriptions.getStagingSelectionKey(other);
		s.emit("narrator_access_changed", { narratorId: "n" });
		expect(s.subscriptions.isStagingWritable(s.target, summary)).toBe(false);
		expect(s.subscriptions.isStagingWritable(other, summary)).toBe(true);
		expect(otherGuard()).toBe(true);
		expect(s.subscriptions.getStagingSelectionKey(other)).toBe(otherSelection);
		expect(oldGuard()).toBe(false);
		s.emit("git_workspace_subscribed", { version: 0 });
		s.emit("git_workspace_staging_observation", { observation: observationState() });
		expect(s.subscriptions.isStagingWritable(s.target, summary)).toBe(true);
		expect(oldGuard()).toBe(false);
		otherOff();
		off();
		s.qc.clear();
	});
	test("an explicit refresh holds every consumer until its target response and rejects old success", () => {
		const s = setup();
		const summary = stagingSummary();
		s.qc.setQueryData(["gitStagingLists", "w", "n", undefined], summary);
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		s.emit("git_workspace_staging_observation", { observation: observationState() });
		const release = s.subscriptions.holdStagingObservation(s.target);
		s.emit("git_workspace_staging_observation", {
			observation: observationState({ stateSequence: 2 }),
		});
		expect(s.subscriptions.isStagingWritable(s.target, summary)).toBe(false);
		release();
		expect(s.subscriptions.isStagingWritable(s.target, summary)).toBe(true);
		s.subscriptions.beginStagingObservation(s.target);
		s.subscriptions.publishStagingObservation(s.target, observationState());
		expect(s.subscriptions.isStagingWritable(s.target, summary)).toBe(false);
		off();
		s.qc.clear();
	});
});

describe("Git workspace WS subscriptions", () => {
	test("summary consumers share a grant and upgrade/downgrade without poisoning details", () => {
		const s = setup();
		const a = s.subscriptions.subscribe(s.target, "summary");
		const b = s.subscriptions.subscribe({ ...s.target }, "summary");
		expect(s.sent).toHaveLength(1);
		s.emit("git_workspace_subscribed", { version: 0 });
		s.emit("git_workspace_snapshot", { version: 1, view: "summary", snapshot: snapshot() });
		expect(s.qc.getQueryData(["gitStatus", "w"])).toBeUndefined();
		expect(s.qc.getQueryData(["gitStatus", "w", "summary"])).not.toHaveProperty("files");
		const panel = s.subscriptions.subscribe(s.target, "details");
		expect(s.sent.at(-1)?.view).toBe("details");
		expect(s.sent).toHaveLength(2);
		expect(s.sent.at(-1)?.subscriptionId).toBe(s.sent[0]?.subscriptionId);
		// Same-id view changes receive a snapshot, not another ACK or version reset.
		s.emit("git_workspace_snapshot", { version: 1, view: "details", snapshot: snapshot(2) });
		s.emit("git_workspace_snapshot", { version: 2, view: "summary", snapshot: snapshot(2) });
		expect(s.qc.getQueryData(["gitStatus", "w"])).toBeUndefined();
		s.emit("git_workspace_snapshot", { version: 2, view: "details", snapshot: snapshot(2) });
		expect(s.qc.getQueryData(["gitStatus", "w"])).toHaveProperty("files", [
			{ status: " M", path: "a.ts" },
		]);
		expect(s.qc.getQueryData(["gitLineStats", "w", "summary"])).not.toHaveProperty("files");
		panel();
		expect(s.sent.at(-1)?.view).toBe("summary");
		expect(s.sent).toHaveLength(3);
		expect(s.sent.at(-1)?.subscriptionId).toBe(s.sent[0]?.subscriptionId);
		expect(s.sent.some((message) => message.type === "git_workspace_unsubscribe")).toBe(false);
		s.emit("git_workspace_snapshot", { version: 3, view: "summary", snapshot: snapshot(3) });
		expect(s.qc.getQueryData(["gitWorkspaceSnapshot", "w", "summary"])).toHaveProperty(
			"revision",
			3,
		);
		a();
		b();
		expect(s.listeners.size).toBe(0);
		s.qc.clear();
	});

	test("different narrator grants are not merged, even for shared facts", () => {
		const s = setup();
		const a = s.subscriptions.subscribe(s.target, "summary");
		const b = s.subscriptions.subscribe({ ...s.target, narratorId: "other" }, "summary");
		expect(s.sent.filter((message) => message.type === "git_workspace_subscribe")).toHaveLength(2);
		expect(s.listeners.size).toBe(1);
		expect(s.connections.size).toBe(1);
		a();
		b();
		s.qc.clear();
	});

	test("staged same-revision snapshots advance once; stale versions and terminal regressions are ignored", () => {
		const s = setup();
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_snapshot", { version: 1, view: "details", snapshot: snapshot() });
		expect(s.qc.getQueryData(["gitStatus", "w"])).toBeUndefined();
		s.emit("git_workspace_subscribed", { version: 0 });
		s.emit("git_workspace_snapshot", { version: 1, view: "details", snapshot: snapshot(3, true) });
		s.emit("git_workspace_snapshot", { version: 2, view: "details", snapshot: snapshot(3, false) });
		s.emit("git_workspace_snapshot", { version: 1, view: "details", snapshot: snapshot(4, true) });
		s.emit("git_workspace_snapshot", { version: 3, view: "details", snapshot: snapshot(3, true) });
		expect(s.qc.getQueryData(["gitWorkspaceSnapshot", "w", "details"])).toMatchObject({
			revision: 3,
			updating: false,
		});
		off();
		s.qc.clear();
	});

	test("hides once, suppresses refresh, restores once, and accepts a restarted server revision", () => {
		const s = setup();
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		s.emit("git_workspace_snapshot", { version: 1, view: "details", snapshot: snapshot(900) });
		s.lifecycle.document.visibilityState = "hidden";
		s.lifecycle.document.dispatchEvent(new Event("visibilitychange"));
		s.lifecycle.document.dispatchEvent(new Event("freeze"));
		expect(s.sent).toHaveLength(2);
		expect(s.subscriptions.refresh(s.target)).toBe(true);
		expect(s.sent).toHaveLength(2);
		s.lifecycle.document.visibilityState = "visible";
		s.lifecycle.document.dispatchEvent(new Event("visibilitychange"));
		s.lifecycle.window.dispatchEvent(new Event("focus"));
		expect(s.sent).toHaveLength(3);
		s.emit("git_workspace_subscribed", { version: 0 });
		s.emit("git_workspace_snapshot", { version: 1, view: "details", snapshot: snapshot(1) });
		expect(s.qc.getQueryData(["gitWorkspaceSnapshot", "w", "details"])).toMatchObject({
			revision: 1,
			updating: false,
		});
		off();
		s.qc.clear();
	});

	test("measurement failure preserves values and workspace; permission failure cancels all projections", () => {
		const s = setup();
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		s.qc.setQueryData(["gitWorkspace", "n"], { state: "ready", workspaceKey: "w" });
		s.emit("git_workspace_snapshot", {
			version: 1,
			view: "details",
			snapshot: { ...snapshot(), lineStatsError: "GIT_LINE_STATS_UNSUPPORTED" },
		});
		expect(s.qc.getQueryData(["gitStatus", "w"])).toHaveProperty("totalFiles", 1);
		expect(s.qc.getQueryData(["gitWorkspace", "n"])).toHaveProperty("state", "ready");
		expect(s.qc.getQueryData(["gitWorkspaceSnapshot", "w", "details"])).toHaveProperty(
			"lineStatsError",
			"GIT_LINE_STATS_UNSUPPORTED",
		);
		expect(s.subscriptions.refresh(s.target)).toBe(true);
		expect(s.sent.at(-1)?.type).toBe("git_workspace_refresh");
		s.emit("git_workspace_error", { code: "access_denied" });
		for (const prefix of ["gitStatus", "gitLineStats", "gitWorkspaceSnapshot"])
			expect(s.qc.getQueriesData({ queryKey: [prefix, "w"] })).toHaveLength(0);
		expect(s.subscriptions.isDenied(s.target)).toBe(true);
		off();
		s.qc.clear();
	});

	test("shares subscriptions, acknowledges with one snapshot, cleans up last consumer", () => {
		const s = setup();
		const off1 = s.subscriptions.subscribe(s.target);
		const off2 = s.subscriptions.subscribe({ ...s.target });
		expect(s.sent).toHaveLength(1);
		s.seed();
		s.emit("git_workspace_subscribed", { version: 1 });
		expect(s.stale("gitLog")).toBe(false);
		expect(s.stale("gitStatus")).toBe(false);
		off1();
		expect(s.sent).toHaveLength(1);
		off2();
		expect(s.sent[1]?.type).toBe("git_workspace_unsubscribe");
		expect(s.listeners.size).toBe(0);
		expect(s.connections.size).toBe(0);
		s.qc.clear();
	});

	test("content changes mark updating while retaining independently versioned statistics", () => {
		const s = setup();
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		const stats = { snapshotId: "snapshot", rows: [{ path: "src", added: 561 }] };
		for (const [index, category] of ["worktree", "index", "head", "refs"].entries()) {
			s.qc.setQueryData(["gitStatusPageStats", "w"], stats);
			s.emit("git_workspace_changed", {
				version: index + 1,
				statusPagesChanged: false,
				categories: [category],
			});
			expect(s.stale("gitStatusPageStats")).toBe(false);
			expect(s.subscriptions.isStatusPageUpdating(s.target)).toBe(true);
		}
		s.qc.setQueryData(["gitStatusPageStats", "w"], stats);
		s.emit("git_workspace_snapshot", { version: 5, view: "details", snapshot: snapshot() });
		expect(s.qc.getQueryData(["gitStatusPageStats", "w"])).toBe(stats);
		expect(s.stale("gitStatusPageStats")).toBe(false);
		s.emit("git_workspace_error", { code: "access_denied" });
		expect(s.qc.getQueryData(["gitStatusPageStats", "w"])).toBeUndefined();
		off();
		s.qc.clear();
	});

	test("file updates never refetch log; refs and stash invalidate their own views", () => {
		const s = setup();
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		s.seed();
		s.emit("git_workspace_changed", { version: 1, categories: ["worktree"] });
		expect(s.stale("gitStatus")).toBe(false);
		expect(s.stale("gitLineStats")).toBe(false);
		expect(s.stale("gitDiff")).toBe(true);
		expect(s.stale("gitLog")).toBe(false);
		expect(s.stale("gitStashList")).toBe(false);
		s.seed();
		s.emit("git_workspace_changed", { version: 2, categories: ["refs"] });
		expect(s.stale("gitLog")).toBe(true);
		s.seed();
		s.emit("git_workspace_changed", { version: 3, categories: ["stash"] });
		expect(s.stale("gitLog")).toBe(false);
		expect(s.stale("gitStashList")).toBe(true);
		off();
		s.qc.clear();
	});

	test("ignores stale versions, mismatched identities and pre-ack frames", () => {
		const s = setup();
		const off = s.subscriptions.subscribe(s.target);
		s.seed();
		s.emit("git_workspace_changed", { version: 1, categories: ["refs"] });
		expect(s.stale("gitLog")).toBe(false);
		s.emit("git_workspace_subscribed", { version: 2 });
		s.seed();
		s.emit("git_workspace_changed", { version: 2, categories: ["refs"] });
		s.emit("git_workspace_changed", { version: 3, workspaceKey: "other", categories: ["refs"] });
		s.emit("git_workspace_changed", { version: 3, subscriptionId: "old", categories: ["refs"] });
		expect(s.stale("gitLog")).toBe(false);
		off();
		s.qc.clear();
	});

	test("reconnect resubscribes then acknowledgement refreshes the snapshot", () => {
		const s = setup();
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 9 });
		s.seed();
		s.connect(false);
		s.connect(true);
		expect(s.sent).toHaveLength(2);
		expect(s.sent[1]?.view).toBe(s.sent[0]?.view);
		expect(s.sent[1]?.subscriptionId).not.toBe(s.sent[0]?.subscriptionId);
		expect(s.stale("gitLog")).toBe(false);
		s.emit("git_workspace_subscribed", { version: 0 });
		expect(s.stale("gitLog")).toBe(true);
		expect(s.stale("gitStatus")).toBe(false);
		off();
		s.qc.clear();
	});

	test("removes revoked facts and retries once", () => {
		const s = setup();
		const off = s.subscriptions.subscribe(s.target);
		expect(s.sent[0]?.narratorId).toBe("n");
		s.qc.setQueryData(["gitLog", "w"], []);
		s.qc.setQueryData(["gitLineStats", "w"], { linesAdded: 10 });
		s.emit("git_workspace_error", { code: "access_denied" });
		expect(s.qc.getQueryData(["gitLog", "w"])).toBeUndefined();
		expect(s.qc.getQueryData(["gitLineStats", "w"])).toBeUndefined();
		s.subscriptions.retry(s.target);
		expect(s.sent.at(-1)?.type).toBe("git_workspace_subscribe");
		s.subscriptions.retry(s.target);
		expect(s.sent.filter((message) => message.type === "git_workspace_subscribe")).toHaveLength(2);
		off();
		s.qc.clear();
	});

	test("HTTP read rejection revokes staging caches once and keeps other workspaces isolated", () => {
		const s = setup();
		const off = s.subscriptions.subscribe(s.target);
		for (const prefix of ["gitStagingLists", "gitStagingFiles", "gitStagingDiff"]) {
			s.qc.setQueryData([prefix, "w", "n"], { private: true });
			s.qc.setQueryData([prefix, "other", "other-narrator"], { private: true });
		}
		const guard = s.subscriptions.getWriteResultGuard(s.target);
		const revision = s.subscriptions.getRevision();
		s.subscriptions.reject(s.target);
		expect(s.subscriptions.isDenied(s.target)).toBe(true);
		expect(guard()).toBe(false);
		expect(s.subscriptions.getRevision()).toBe(revision + 1);
		for (const prefix of ["gitStagingLists", "gitStagingFiles", "gitStagingDiff"]) {
			expect(s.qc.getQueryData([prefix, "w", "n"])).toBeUndefined();
			expect(s.qc.getQueryData([prefix, "other", "other-narrator"])).toEqual({ private: true });
		}
		s.subscriptions.reject(s.target);
		expect(s.subscriptions.getRevision()).toBe(revision + 1);
		off();
		s.qc.clear();
	});

	test("write-result guards survive ordinary Git notifications and same-grant projection changes", () => {
		const s = setup();
		const off = s.subscriptions.subscribe(s.target, "summary");
		s.emit("git_workspace_subscribed", { version: 0 });
		const guard = s.subscriptions.getWriteResultGuard(s.target);
		expect(guard()).toBe(true);
		s.emit("git_workspace_staging_lists_changed", {
			version: 1,
			listId: "A",
		});
		s.emit("git_workspace_changed", { version: 2, categories: ["index"] });
		s.emit("git_workspace_snapshot", { version: 3, view: "summary", snapshot: snapshot(3) });
		const detailsOff = s.subscriptions.subscribe(s.target, "details");
		expect(guard()).toBe(true);
		detailsOff();
		expect(guard()).toBe(true);
		off();
		expect(guard()).toBe(false);
		s.qc.clear();
	});

	test("a denied then renewed grant cannot restore a late POST summary from its old write guard", async () => {
		const s = setup();
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		const key = ["gitStagingLists", "w", "n"];
		const oldGuard = s.subscriptions.getWriteResultGuard(s.target);
		const oldResult = {
			listId: "A",
			outcome: "applied",
			summary: { lists: [{ name: "old-private-list" }] },
		};
		let finish = (_result: typeof oldResult) => {};
		const oldPost = new Promise<typeof oldResult>((resolve) => {
			finish = resolve;
		}).then((result) => {
			if (oldGuard()) s.qc.setQueryData(key, result.summary);
			return { listId: result.listId, outcome: result.outcome };
		});
		s.qc.setQueryData(key, oldResult.summary);
		s.emit("git_workspace_error", { code: "access_denied" });
		expect(s.qc.getQueryData(key)).toBeUndefined();
		expect(oldGuard()).toBe(false);
		s.subscriptions.retry(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		expect(s.subscriptions.isDenied(s.target)).toBe(false);
		expect(oldGuard()).toBe(false);
		const renewedGuard = s.subscriptions.getWriteResultGuard(s.target);
		expect(renewedGuard()).toBe(true);
		const renewedSummary = { lists: [{ name: "newly-authorized-list" }] };
		s.qc.setQueryData(key, renewedSummary);
		finish(oldResult);
		expect(await oldPost).toEqual({ listId: "A", outcome: "applied" });
		expect(s.qc.getQueryData(key)).toEqual(renewedSummary);
		expect(JSON.stringify(s.qc.getQueryData(key))).not.toContain("old-private-list");
		off();
		s.qc.clear();
	});

	test("access hints and principal changes invalidate result guards without waiting for React", () => {
		const s = setup();
		s.qc.setQueryData(["auth", "me"], { id: "owner" });
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		expect(s.listenerTypes.has("narrator_access_changed")).toBe(true);
		const beforeAccess = s.subscriptions.getWriteResultGuard(s.target);
		s.emit("narrator_access_changed", { subscriptionId: undefined });
		expect(beforeAccess()).toBe(false);
		s.emit("git_workspace_subscribed", { version: 0 });
		const beforePrincipal = s.subscriptions.getWriteResultGuard(s.target);
		expect(beforePrincipal()).toBe(true);
		s.setCredential(2);
		s.qc.setQueryData(["auth", "me"], { id: "other-user" });
		expect(beforePrincipal()).toBe(false);
		s.setCredential(3);
		s.qc.setQueryData(["auth", "me"], { id: "owner" });
		s.subscriptions.confirmWorkspace(s.target);
		s.connect(false);
		s.connect(true);
		s.emit("git_workspace_subscribed", { version: 0 });
		expect(beforePrincipal()).toBe(false);
		expect(s.subscriptions.getWriteResultGuard(s.target)()).toBe(true);
		off();
		s.qc.clear();
	});

	test("reconnect, foreground and target replacement keep old result guards invalid", () => {
		const s = setup();
		expect(s.subscriptions.getWriteResultGuard(s.target)()).toBe(false);
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		const beforeReconnect = s.subscriptions.getWriteResultGuard(s.target);
		s.connect(false);
		s.connect(true);
		s.emit("git_workspace_subscribed", { version: 0 });
		expect(beforeReconnect()).toBe(false);
		const beforeHidden = s.subscriptions.getWriteResultGuard(s.target);
		s.lifecycle.document.visibilityState = "hidden";
		s.lifecycle.document.dispatchEvent(new Event("visibilitychange"));
		expect(beforeHidden()).toBe(false);
		s.lifecycle.document.visibilityState = "visible";
		s.lifecycle.document.dispatchEvent(new Event("visibilitychange"));
		s.emit("git_workspace_subscribed", { version: 0 });
		expect(beforeHidden()).toBe(false);
		const beforeSwitch = s.subscriptions.getWriteResultGuard(s.target);
		off();
		const nextOff = s.subscriptions.subscribe({ ...s.target, narratorId: "next" });
		s.emit("git_workspace_subscribed", { version: 0, narratorId: "next" });
		expect(beforeSwitch()).toBe(false);
		nextOff();
		s.qc.clear();
	});

	test("a target index event invalidates only that groups files and diff", async () => {
		const s = setup();
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		for (const prefix of ["gitStagingFiles", "gitStagingDiff"])
			for (const id of ["A", "B"]) s.qc.setQueryData([prefix, "w", id, "n"], { value: 1 });
		s.qc.setQueryData(["gitStagingLists", "w", "n"], { lists: [] });
		s.seed();
		s.emit("git_workspace_staging_lists_changed", { version: 1, listId: "A" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		for (const prefix of ["gitStagingFiles", "gitStagingDiff"]) {
			expect(s.qc.getQueryState([prefix, "w", "A", "n"])?.isInvalidated).toBe(true);
			expect(s.qc.getQueryState([prefix, "w", "B", "n"])?.isInvalidated).toBe(false);
		}
		expect(s.qc.getQueryState(["gitStagingLists", "w", "n"])?.isInvalidated).toBe(true);
		expect(s.stale("gitStatus")).toBe(false);
		off();
		s.qc.clear();
	});
	test("commit metadata and index changes invalidate names and only the committed group", async () => {
		const s = setup();
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		s.qc.setQueryData(["gitStagingLists", "w", "n"], { lists: [] });
		for (const id of ["A", "B"])
			s.qc.setQueryData(["gitStagingFiles", "w", id, "n"], { pages: [], pageParams: [] });
		s.emit("git_workspace_staging_lists_changed", {
			version: 1,
			listId: "A",
			metadataChanged: true,
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(s.qc.getQueryState(["gitStagingLists", "w", "n"])?.isInvalidated).toBe(true);
		expect(s.qc.getQueryState(["gitStagingFiles", "w", "A", "n"])?.isInvalidated).toBe(true);
		expect(s.qc.getQueryState(["gitStagingFiles", "w", "B", "n"])?.isInvalidated).toBe(false);
		off();
		s.qc.clear();
	});
	test("one observation invalidates every superseded affected snapshot and preserves current pages", async () => {
		const s = setup();
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		s.qc.setQueryData(["gitStagingLists", "w", "n"], {
			initialized: true,
			lists: [
				{ id: "A", snapshotVersion: "a2" },
				{ id: "B", snapshotVersion: "b1" },
			],
		});
		for (const prefix of ["gitStagingFiles", "gitStagingDiff"])
			for (const [id, snapshot] of [
				["A", "a1"],
				["A", "a2"],
				["B", "b1"],
			])
				s.qc.setQueryData([prefix, "w", id, "n", "alice", snapshot], {
					pages: [{ complete: false }, { complete: true }],
					pageParams: [null, "next"],
				});
		s.emit("git_workspace_staging_lists_changed", {
			version: 1,
			generation: 2,
			observationId: "o2",
			affectedListIds: ["A", "B"],
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		for (const prefix of ["gitStagingFiles", "gitStagingDiff"]) {
			expect(s.qc.getQueryState([prefix, "w", "A", "n", "alice", "a1"])?.isInvalidated).toBe(true);
			expect(s.qc.getQueryState([prefix, "w", "A", "n", "alice", "a2"])?.isInvalidated).toBe(false);
			expect(s.qc.getQueryState([prefix, "w", "B", "n", "alice", "b1"])?.isInvalidated).toBe(false);
			expect(
				s.qc.getQueryData<{ pages: unknown[] }>([prefix, "w", "B", "n", "alice", "b1"])?.pages,
			).toHaveLength(2);
		}
		off();
		s.qc.clear();
	});
	test("HTTP plus repeated WS observations merge into one read and one trailing refresh", async () => {
		const s = setup();
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		const key = ["gitStagingLists", "w", "n"];
		const summary = { initialized: true, lists: [{ id: "A", snapshotVersion: "a1" }] };
		s.qc.setQueryData(key, summary);
		let reads = 0;
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const observer = new QueryObserver(s.qc, {
			queryKey: key,
			staleTime: Infinity,
			queryFn: async () => {
				reads++;
				if (reads === 1) await gate;
				return summary;
			},
		});
		const stop = observer.subscribe(() => {});
		const first = s.subscriptions.invalidateStagingObservation(s.target, 1, ["A"]);
		for (let index = 0; index < 100; index++)
			void s.subscriptions.invalidateStagingObservation(s.target, 1, ["A"]);
		expect(reads).toBe(1);
		for (let index = 2; index <= 100; index++)
			void s.subscriptions.invalidateStagingObservation(s.target, index, ["A"]);
		expect(reads).toBe(1);
		release?.();
		await first;
		expect(reads).toBe(2);
		await s.subscriptions.invalidateStagingObservation(s.target, 100, ["A"]);
		expect(reads).toBe(2);
		stop();
		off();
		s.qc.clear();
	});
	test("metadata events refresh names and preserve loaded index files", () => {
		const s = setup();
		const off = s.subscriptions.subscribe(s.target);
		s.emit("git_workspace_subscribed", { version: 0 });
		s.qc.setQueryData(["gitStagingLists", "w", "n"], { lists: [] });
		s.qc.setQueryData(["gitStagingFiles", "w", "A", "n"], { files: [] });
		s.emit("git_workspace_staging_lists_changed", {
			version: 1,
			metadataChanged: true,
		});
		expect(s.qc.getQueryState(["gitStagingLists", "w", "n"])?.isInvalidated).toBe(true);
		expect(s.qc.getQueryState(["gitStagingFiles", "w", "A", "n"])?.isInvalidated).toBe(false);
		off();
		s.qc.clear();
	});
});

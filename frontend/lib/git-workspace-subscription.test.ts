import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { GitWorkspaceSnapshot } from "../../shared/git-workspace-events";
import { GitWorkspaceSubscriptions } from "./git-workspace-subscription";
import type { MessageCallback } from "./narrator-ws-manager";

function setup() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const sent: Record<string, unknown>[] = [];
	const listeners = new Map<number, MessageCallback>();
	const connections = new Set<(connected: boolean, reconnect: boolean) => void>();
	let id = 0;
	const transport = {
		connected: true,
		send(message: Record<string, unknown>) {
			sent.push(message);
			return true;
		},
		addListener(_options: unknown, callback: MessageCallback) {
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
	const subscriptions = new GitWorkspaceSubscriptions(qc, transport, lifecycle);
	const connect = (connected: boolean) => {
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
	const emit = (type: string, extra: Record<string, unknown> = {}) => {
		for (const callback of listeners.values())
			callback({
				type,
				subscriptionId: sent.filter((message) => message.type === "git_workspace_subscribe").at(-1)
					?.subscriptionId,
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
		connections,
		target,
		subscriptions,
		seed,
		emit,
		stale,
		connect,
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
		expect(s.sent[1]?.type).toBe("git_workspace_subscribe");
		s.subscriptions.retry(s.target);
		expect(s.sent).toHaveLength(2);
		off();
		s.qc.clear();
	});
});

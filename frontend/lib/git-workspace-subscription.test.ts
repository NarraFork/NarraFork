import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
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
	const subscriptions = new GitWorkspaceSubscriptions(qc, transport);
	const seed = () => {
		for (const prefix of ["gitStatus", "gitDiff", "gitModifications", "gitLog", "gitStashList"])
			qc.setQueryData([prefix, "w"], { value: 1 });
	};
	const emit = (type: string, extra: Record<string, unknown> = {}) => {
		for (const callback of listeners.values())
			callback({
				type,
				subscriptionId: sent[0]?.subscriptionId,
				workspaceKey: "w",
				repositoryKey: "r",
				...extra,
			});
	};
	const stale = (prefix: string) => qc.getQueryState([prefix, "w"])?.isInvalidated;
	return { qc, sent, listeners, connections, target, subscriptions, seed, emit, stale };
}

describe("Git workspace WS subscriptions", () => {
	test("shares subscriptions, acknowledges with one snapshot, cleans up last consumer", () => {
		const s = setup();
		const off1 = s.subscriptions.subscribe(s.target);
		const off2 = s.subscriptions.subscribe({ ...s.target });
		expect(s.sent).toHaveLength(1);
		s.seed();
		s.emit("git_workspace_subscribed", { version: 1 });
		expect(s.stale("gitLog")).toBe(true);
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
		expect(s.stale("gitStatus")).toBe(true);
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
		for (const cb of s.connections) cb(false, false);
		for (const cb of s.connections) cb(true, true);
		expect(s.sent).toHaveLength(2);
		expect(s.sent[1]).toEqual(s.sent[0]);
		expect(s.stale("gitLog")).toBe(false);
		s.emit("git_workspace_subscribed", { version: 0 });
		expect(s.stale("gitLog")).toBe(true);
		off();
		s.qc.clear();
	});

	test("supports chapter targets and removes revoked facts", () => {
		const s = setup();
		const off = s.subscriptions.subscribe("chapter");
		expect(s.sent[0]?.chapterId).toBe("chapter");
		s.qc.setQueryData(["gitLog", "chapter"], []);
		s.emit("git_workspace_error", { code: "access_denied" });
		expect(s.qc.getQueryData(["gitLog", "chapter"])).toBeUndefined();
		s.subscriptions.retry("chapter");
		expect(s.sent[1]?.type).toBe("git_workspace_subscribe");
		s.subscriptions.retry("chapter");
		expect(s.sent).toHaveLength(2);
		off();
		s.qc.clear();
	});
});

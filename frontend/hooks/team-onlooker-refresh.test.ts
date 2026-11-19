/**
 * The recent tabs re-read their runtime patches (and so `teamOnlooker`) on the access changes
 * that make or unmake team members (M1): a narrator sharing change of a tab's narrator (or one
 * that may be a subagent's root), and any project membership change while a team tab is open.
 * Frames are delivered through the WebSocket manager's real listener filter.
 */
import { describe, expect, test } from "bun:test";
import {
	type ListenerHandle,
	type ListenerOptions,
	type MessageCallback,
	matchesListenerFilter,
} from "../lib/narrator-ws-manager";
import type { RecentTab } from "./recent-tabs-utils";
import { installTeamOnlookerRefresh } from "./team-onlooker-refresh";

function fakeSource() {
	const listeners = new Map<number, { opts: ListenerOptions; cb: MessageCallback }>();
	let next = 0;
	return {
		listeners,
		addListener(opts: ListenerOptions, cb: MessageCallback): ListenerHandle {
			const id = next++;
			listeners.set(id, { opts, cb });
			return { _id: id };
		},
		removeListener(handle: ListenerHandle) {
			listeners.delete(handle._id);
		},
		/** Dispatch one frame the way the manager does. */
		emit(data: Record<string, unknown>) {
			for (const { opts, cb } of listeners.values())
				if (
					matchesListenerFilter(
						opts,
						data.type as string,
						typeof data.narratorId === "string" ? data.narratorId : undefined,
					)
				)
					cb(data);
		},
	};
}

const tab = (patch: Partial<RecentTab>): RecentTab =>
	({ type: "narrator", id: "n", title: "t", ...patch }) as RecentTab;

describe("installTeamOnlookerRefresh", () => {
	test("narrator and project access changes re-read the runtime patches when they may matter", () => {
		const source = fakeSource();
		let tabs: RecentTab[] = [tab({ id: "lead", teamSession: true })];
		let refreshes = 0;
		const remove = installTeamOnlookerRefresh(
			source,
			() => tabs,
			() => {
				refreshes++;
			},
		);
		// A sharing change of the open coordinator (an audience change reaches its tab holders).
		source.emit({
			type: "narrator_access_changed",
			narratorId: "lead",
			reason: "visibility_changed",
		});
		expect(refreshes).toBe(1);
		// Someone else's narrator: nothing to re-read.
		source.emit({ type: "narrator_access_changed", narratorId: "other", reason: "shared" });
		expect(refreshes).toBe(1);
		// A project membership change: project grants decide project-wide team audiences.
		source.emit({ type: "project_access_changed", projectId: "p", reason: "grant_changed" });
		expect(refreshes).toBe(2);
		// Without team or subagent tabs a project change does nothing.
		tabs = [tab({ id: "plain" })];
		source.emit({ type: "project_access_changed", projectId: "p", reason: "grant_changed" });
		expect(refreshes).toBe(2);
		// Other frames never reach it.
		source.emit({ type: "status_change", narratorId: "plain", status: "waiting" });
		expect(refreshes).toBe(2);
		// A team subagent tab: its root is unknown here, so any narrator change re-reads.
		tabs = [tab({ id: "worker", type: "subagent", teamSession: true })];
		source.emit({ type: "narrator_access_changed", narratorId: "lead", reason: "unshared" });
		expect(refreshes).toBe(3);
		// A subagent tab known not to be a team session: nothing to re-read.
		tabs = [tab({ id: "plain-worker", type: "subagent", teamSession: false })];
		source.emit({ type: "narrator_access_changed", narratorId: "lead", reason: "unshared" });
		source.emit({ type: "project_access_changed", projectId: "p", reason: "visibility_changed" });
		expect(refreshes).toBe(3);
		remove();
		expect(source.listeners.size).toBe(0);
		source.emit({ type: "project_access_changed", projectId: "p" });
		expect(refreshes).toBe(3);
	});
});

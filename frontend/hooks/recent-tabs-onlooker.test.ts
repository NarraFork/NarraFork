/**
 * A team session waits for a member (M1): a tab the server marked `teamOnlooker` (the user may
 * only read that coordinator or its subagent) raises no "waiting" alert — no favicon dot, sound
 * or PWA notification — but a session that is also unread (done) still alerts as unread. Every
 * other tab is unchanged.
 */
import { describe, expect, test } from "bun:test";
import {
	accessChangeNeedsRuntimeRefresh,
	isTeamOnlookerTab,
	type RecentTab,
	statusAttention,
} from "./recent-tabs-utils";

const tab = (patch: Partial<RecentTab>): RecentTab =>
	({ type: "narrator", id: "n", title: "t", ...patch }) as RecentTab;

describe("team onlooker alerts", () => {
	test("which tabs are a team onlooker's", () => {
		const tabs = [
			tab({ id: "lead", teamOnlooker: true }),
			tab({ id: "worker", type: "subagent", teamOnlooker: true }),
			tab({ id: "mine", teamOnlooker: false }),
			tab({ id: "plain" }),
		];
		expect(isTeamOnlookerTab(tabs, "lead")).toBe(true);
		expect(isTeamOnlookerTab(tabs, "worker")).toBe(true);
		expect(isTeamOnlookerTab(tabs, "mine")).toBe(false);
		expect(isTeamOnlookerTab(tabs, "plain")).toBe(false);
		expect(isTeamOnlookerTab(tabs, "absent")).toBe(false);
	});

	test("waiting is silent for an onlooker; unread is not", () => {
		expect(statusAttention("waiting", [], false)).toBe("waiting");
		expect(statusAttention("waiting", [], true)).toBeNull();
		expect(statusAttention("waiting", ["unread"], true)).toBe("unread");
		expect(statusAttention("waiting", ["unread"], false)).toBe("waiting");
		expect(statusAttention("idle", ["unread"], true)).toBe("unread");
		expect(statusAttention("idle", ["unread"], false)).toBe("unread");
		expect(statusAttention("idle", [], false)).toBeNull();
		expect(statusAttention(undefined, null, true)).toBeNull();
	});

	test("an access change reads the runtime patches again when it may move the flag", () => {
		const lead = tab({ id: "lead" });
		expect(accessChangeNeedsRuntimeRefresh([lead], "lead")).toBe(true);
		expect(accessChangeNeedsRuntimeRefresh([lead], "other")).toBe(false);
		// A promoted onlooker: its stale flag must be read again, whatever narrator changed.
		expect(accessChangeNeedsRuntimeRefresh([tab({ id: "w", teamOnlooker: true })], "lead")).toBe(
			true,
		);
		// A subagent's root is not known on the client: a team subagent's tab re-reads, and so does
		// one whose runtime patch (team or not) has not been read yet; a non-team one does not.
		expect(
			accessChangeNeedsRuntimeRefresh(
				[tab({ id: "w", type: "subagent", teamSession: true })],
				"lead",
			),
		).toBe(true);
		expect(accessChangeNeedsRuntimeRefresh([tab({ id: "w", type: "subagent" })], "lead")).toBe(
			true,
		);
		expect(
			accessChangeNeedsRuntimeRefresh(
				[tab({ id: "w", type: "subagent", teamSession: false })],
				"lead",
			),
		).toBe(false);
		expect(accessChangeNeedsRuntimeRefresh([], "lead")).toBe(false);
	});
});

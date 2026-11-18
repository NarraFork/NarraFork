/**
 * A team session waits for a member (M1): a tab the server marked `teamOnlooker` (the user may
 * only read that coordinator or its subagent) raises no "waiting" alert — no favicon dot, sound
 * or PWA notification. Done / unread and every other tab are unchanged.
 */
import { describe, expect, test } from "bun:test";
import { type RecentTab, silentForTeamOnlooker } from "./recent-tabs-utils";

const tab = (patch: Partial<RecentTab>): RecentTab =>
	({ type: "narrator", id: "n", title: "t", ...patch }) as RecentTab;

describe("silentForTeamOnlooker", () => {
	test("only a waiting team session the user may only read", () => {
		const tabs = [
			tab({ id: "lead", teamOnlooker: true }),
			tab({ id: "worker", type: "subagent", teamOnlooker: true }),
			tab({ id: "mine", teamOnlooker: false }),
			tab({ id: "plain" }),
		];
		expect(silentForTeamOnlooker(tabs, "lead", "waiting")).toBe(true);
		expect(silentForTeamOnlooker(tabs, "worker", "waiting")).toBe(true);
		expect(silentForTeamOnlooker(tabs, "lead", "idle")).toBe(false);
		expect(silentForTeamOnlooker(tabs, "lead", undefined)).toBe(false);
		expect(silentForTeamOnlooker(tabs, "mine", "waiting")).toBe(false);
		expect(silentForTeamOnlooker(tabs, "plain", "waiting")).toBe(false);
		expect(silentForTeamOnlooker(tabs, "absent", "waiting")).toBe(false);
	});
});

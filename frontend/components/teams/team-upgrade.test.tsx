/**
 * Upgrading a session to a team and disbanding a team, on the client: which sessions the overflow
 * menu offers 升级为团队 to, the body the dialog posts (the session, never an audience), the
 * mutations' requests and cache effects, and the localized refusals and strings.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import type { TeamDetail } from "@shared/project-teams";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { teamKeys, useDisbandTeam, useUpgradeToTeam } from "../../hooks/useTeams";
import { api } from "../../lib/api";
import { ApiError } from "../../lib/api/client";
import en from "../../locales/en/projects.json";
import zh from "../../locales/zh-CN/projects.json";
import { canOfferTeamUpgrade, TEAM_UPGRADE_EXCLUDED_TRAITS } from "./team-upgrade-eligibility";
import { buildUpgradePayload, teamErrorMessage } from "./UpgradeToTeamModal";

const keys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = keys.map(
	(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
afterAll(() => {
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

async function i18nFor(lng: "en" | "zh-CN") {
	const i18n = createInstance();
	await i18n.init({
		lng,
		resources: { en: { projects: en }, "zh-CN": { projects: zh } },
		defaultNS: "projects",
		interpolation: { escapeValue: false },
	});
	return i18n;
}

const ordinary = {
	type: "primary",
	status: "idle",
	traits: ["standalone"],
	scheduledTaskId: null,
	hiddenFromLists: false,
	oauthPolicySnapshotJson: null,
};

describe("which sessions are offered the upgrade", () => {
	test("an ordinary session of a known project", () => {
		expect(canOfferTeamUpgrade(ordinary, "p1")).toBe(true);
		expect(canOfferTeamUpgrade({ ...ordinary, status: "working" }, "p1")).toBe(true);
	});

	test("not without a project, nor for subagents, archived or special sessions", () => {
		expect(canOfferTeamUpgrade(ordinary, null)).toBe(false);
		expect(canOfferTeamUpgrade(undefined, "p1")).toBe(false);
		expect(canOfferTeamUpgrade({ ...ordinary, type: "subagent" }, "p1")).toBe(false);
		expect(canOfferTeamUpgrade({ ...ordinary, status: "archived" }, "p1")).toBe(false);
		expect(canOfferTeamUpgrade({ ...ordinary, scheduledTaskId: "s1" }, "p1")).toBe(false);
		expect(canOfferTeamUpgrade({ ...ordinary, hiddenFromLists: true }, "p1")).toBe(false);
		expect(canOfferTeamUpgrade({ ...ordinary, oauthPolicySnapshotJson: {} }, "p1")).toBe(false);
		for (const trait of TEAM_UPGRADE_EXCLUDED_TRAITS)
			expect(canOfferTeamUpgrade({ ...ordinary, traits: ["standalone", trait] }, "p1")).toBe(false);
	});
});

describe("the upgrade request", () => {
	test("posts the session and only the fields filled in", () => {
		expect(buildUpgradePayload("n1", { name: " ", baseBranch: "", brief: "" })).toEqual({
			fromNarratorId: "n1",
		});
		expect(
			buildUpgradePayload("n1", { name: " Crew ", baseBranch: " trunk ", brief: "Rules" }),
		).toEqual({ fromNarratorId: "n1", name: "Crew", baseBranch: "trunk", brief: "Rules" });
	});

	test("refusals are worded per code in both locales; others fall back", async () => {
		for (const lng of ["en", "zh-CN"] as const) {
			const i18n = await i18nFor(lng);
			const t = i18n.getFixedT(lng, "projects") as Parameters<typeof teamErrorMessage>[1];
			const busy = new ApiError("busy", 409, { code: "NARRATOR_EXECUTION_BUSY", error: "busy" });
			const upgradeText = teamErrorMessage(busy, t, "upgrade");
			expect(upgradeText).toBe(
				(lng === "en" ? en : zh).teams.upgrade.errors.NARRATOR_EXECUTION_BUSY,
			);
			const live = new ApiError("live", 409, { code: "TEAM_HAS_LIVE_WORK", error: "live" });
			expect(teamErrorMessage(live, t, "disband")).toBe(
				(lng === "en" ? en : zh).teams.disband.errors.TEAM_HAS_LIVE_WORK,
			);
			const other = new ApiError("boom", 500, { code: "SOMETHING_ELSE", error: "boom" });
			expect(teamErrorMessage(other, t, "upgrade")).toBe("boom");
		}
	});
});

function mountHook<T>(useHook: () => T, client: QueryClient): { current: T; unmount: () => void } {
	const { window } = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
	Object.assign(globalThis, {
		window,
		document: window.document,
		navigator: window.navigator,
		IS_REACT_ACT_ENVIRONMENT: true,
	});
	const ref = {} as { current: T; unmount: () => void };
	function Probe() {
		ref.current = useHook();
		return null;
	}
	const root = createRoot(window.document.getElementById("root") as unknown as Element);
	act(() => {
		root.render(
			<QueryClientProvider client={client}>
				<Probe />
			</QueryClientProvider>,
		);
	});
	ref.unmount = () => act(() => root.unmount());
	return ref;
}

describe("the mutations", () => {
	test("upgrade posts fromNarratorId to the project's team route and refreshes the session", async () => {
		const team = { id: "n1", projectId: "p1", name: "Crew" } as TeamDetail;
		const spy = spyOn(api, "upgradeSessionToTeam").mockResolvedValue(team);
		const client = new QueryClient();
		const invalidated: unknown[] = [];
		const original = client.invalidateQueries.bind(client);
		client.invalidateQueries = ((filters) => {
			invalidated.push(filters?.queryKey);
			return original(filters);
		}) as typeof client.invalidateQueries;
		try {
			const ref = mountHook(() => useUpgradeToTeam("p1"), client);
			await act(async () => {
				await ref.current.mutateAsync({ fromNarratorId: "n1" });
			});
			expect(spy).toHaveBeenCalledWith("p1", { fromNarratorId: "n1" });
			expect(invalidated).toContainEqual(teamKeys.list("p1"));
			expect(invalidated).toContainEqual(["narrators", "n1"]);
			ref.unmount();
		} finally {
			spy.mockRestore();
		}
	});

	test("disband posts to the team's disband route and drops the team's page caches", async () => {
		const spy = spyOn(api, "disbandTeam").mockResolvedValue({ narratorId: "n1" });
		const client = new QueryClient();
		client.setQueryData(teamKeys.team("n1"), { id: "n1" });
		client.setQueryData(teamKeys.summary("n1"), { teamId: "n1" });
		try {
			const ref = mountHook(() => useDisbandTeam("p1", "n1"), client);
			let result: { narratorId: string } | undefined;
			await act(async () => {
				result = await ref.current.mutateAsync();
			});
			expect(spy).toHaveBeenCalledWith("p1", "n1");
			expect(result).toEqual({ narratorId: "n1" });
			expect(client.getQueryData(teamKeys.team("n1"))).toBeUndefined();
			expect(client.getQueryData(teamKeys.summary("n1"))).toBeUndefined();
			ref.unmount();
		} finally {
			spy.mockRestore();
		}
	});
});

describe("the strings", () => {
	test("the menu entries read 升级为团队 and 解散团队", async () => {
		expect(zh.teams.upgrade.menu).toBe("升级为团队");
		expect(zh.teams.disband.menu).toBe("解散团队");
		// The confirmation says what goes and what stays.
		expect(en.teams.disband.confirm).toContain("work items and its activity history are deleted");
		expect(en.teams.disband.confirm).toContain("session and its conversation are kept");
		expect(zh.teams.disband.confirm).toContain("工作项和动态记录会被删除");
		expect(zh.teams.disband.confirm).toContain("会话和对话会保留");
		const i18n = await i18nFor("zh-CN");
		expect(i18n.t("teams.upgrade.title")).toBe("把这个会话升级为团队");
	});
});

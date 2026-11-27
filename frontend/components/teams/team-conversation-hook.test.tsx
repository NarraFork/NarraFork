/**
 * The team mode value across a team switch: the previous team's dividers never show in the new
 * team's conversation, while one team's own refetch (an older `since`) keeps its dividers until
 * the new page arrives.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TeamActivityPage } from "@shared/project-teams";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { api } from "../../lib/api";
import enNarrator from "../../locales/en/narrator.json";
import en from "../../locales/en/projects.json";
import type { TeamConversationMode } from "../narrator/team-conversation-mode";
import { sameTeamPlaceholder, useTeamConversationModeValue } from "./team-conversation";

const keys = ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
const originals = keys.map(
	(key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);
const originalRead = api.getTeamConversationEvents;

beforeAll(() => {
	const { window, document } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of [
		["window", window],
		["document", document],
		["navigator", window.navigator],
		["IS_REACT_ACT_ENVIRONMENT", true],
	] as const)
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
});

afterAll(() => {
	api.getTeamConversationEvents = originalRead;
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

function page(teamId: string, title: string): TeamActivityPage {
	return {
		events: [
			{
				id: `${teamId}-e1`,
				kind: "work.merged",
				workItemId: "w1",
				workItemTitle: title,
				actorKind: "agent",
				actorId: null,
				actorName: null,
				detail: {},
				detailOmitted: false,
				createdAt: "2026-11-27T02:10:00.000Z",
			},
		],
		nextCursor: null,
	};
}

let latest: TeamConversationMode | null = null;
function Harness({ teamId }: { teamId: string }) {
	latest = useTeamConversationModeValue("p1", teamId);
	return null;
}

const settle = () => act(async () => await new Promise((resolve) => setTimeout(resolve, 20)));

describe("team switch", () => {
	test("another team's dividers never show; a team waits for its own window", async () => {
		const calls: string[] = [];
		const pending: Record<string, (value: TeamActivityPage) => void> = {};
		api.getTeamConversationEvents = ((_projectId: string, teamId: string) => {
			calls.push(teamId);
			if (teamId === "team-a") return Promise.resolve(page("team-a", "Alpha item"));
			return new Promise<TeamActivityPage>((resolve) => {
				pending[teamId] = resolve;
			});
		}) as typeof api.getTeamConversationEvents;
		const i18n = createInstance();
		await i18n.init({
			lng: "en",
			resources: { en: { projects: en, narrator: enNarrator } },
			defaultNS: "projects",
			interpolation: { escapeValue: false },
		});
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const host = document.createElement("div");
		document.body.appendChild(host);
		let root: Root | null = null;
		const render = (teamId: string) =>
			act(async () => {
				root ??= createRoot(host);
				root.render(
					<I18nextProvider i18n={i18n}>
						<QueryClientProvider client={client}>
							<Harness teamId={teamId} />
						</QueryClientProvider>
					</I18nextProvider>,
				);
			});

		await render("team-a");
		expect(calls).toEqual([]);
		await act(async () => latest?.onWindowChange?.({ oldestAt: null, hasPrev: false }));
		await settle();
		expect(latest?.narratorId).toBe("team-a");
		expect(latest?.events.map((event) => event.text)).toEqual([
			expect.stringContaining("「Alpha item」"),
		]);

		// Same hook instance, another team: no window yet, so nothing is read and nothing shows.
		await render("team-b");
		await settle();
		expect(latest?.narratorId).toBe("team-b");
		expect(latest?.events).toEqual([]);
		expect(calls).toEqual(["team-a"]);
		// Its window arrives and its read is in flight: still none of team A's dividers.
		await act(async () => latest?.onWindowChange?.({ oldestAt: null, hasPrev: false }));
		await settle();
		expect(calls).toEqual(["team-a", "team-b"]);
		expect(latest?.events).toEqual([]);
		await act(async () => pending["team-b"]?.(page("team-b", "Beta item")));
		await settle();
		expect(latest?.events.map((event) => event.text)).toEqual([
			expect.stringContaining("「Beta item」"),
		]);
		await act(async () => root?.unmount());
	});

	test("the placeholder keeps only the same team's previous page", () => {
		const keep = sameTeamPlaceholder("team-a");
		const previous = { pages: [] };
		expect(
			keep(previous, { queryKey: ["teams", "page", "team-a", "activity", "conversation"] }),
		).toBe(previous);
		expect(
			keep(previous, { queryKey: ["teams", "page", "team-b", "activity", "conversation"] }),
		).toBeUndefined();
		expect(keep(previous, undefined)).toBeUndefined();
	});
});

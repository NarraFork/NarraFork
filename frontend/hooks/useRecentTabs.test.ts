import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { RecentTab } from "./useRecentTabs";

const upsertRecentTab = mock(async (_tab: Record<string, unknown>) => []);

mock.module("../lib/api", () => ({
	api: {
		upsertRecentTab,
	},
}));

const queryClient = new QueryClient();

mock.module("../lib/query-client", () => ({
	queryClient,
}));

const { addRecentTab, RECENT_TABS_QUERY_KEY } = await import("./useRecentTabs");

afterEach(() => {
	upsertRecentTab.mockClear();
	queryClient.clear();
});

describe("addRecentTab", () => {
	test("defaults to upsert even when a matching tab exists in local cache", async () => {
		queryClient.setQueryData<RecentTab[]>(RECENT_TABS_QUERY_KEY, [
			{
				type: "narrator",
				id: "narrator-1",
				title: "Cached narrator",
				lastVisitedAt: 100,
			},
		]);

		addRecentTab({
			type: "narrator",
			id: "narrator-1",
			title: "Opened narrator",
		});
		await Promise.resolve();

		expect(upsertRecentTab).toHaveBeenCalledTimes(1);
		expect(upsertRecentTab.mock.calls[0]?.[0]).toMatchObject({
			type: "narrator",
			id: "narrator-1",
			title: "Opened narrator",
			updateOnly: false,
		});
	});

	test("normalizes nullable text fields before sending to the API", async () => {
		addRecentTab({
			type: "narrator",
			id: "narrator-null-cwd",
			title: "Narrator without cwd",
			// API responses can contain null cwd values for existing narrators.
			subtitle: null as unknown as string,
		});
		await Promise.resolve();

		expect(upsertRecentTab).toHaveBeenCalledTimes(1);
		expect(upsertRecentTab.mock.calls[0]?.[0]).toMatchObject({
			type: "narrator",
			id: "narrator-null-cwd",
			title: "Narrator without cwd",
			updateOnly: false,
		});
		expect(upsertRecentTab.mock.calls[0]?.[0]?.subtitle).toBeUndefined();
	});

	test("preserves explicit updateOnly for workspace membership updates", async () => {
		addRecentTab({
			type: "narrator",
			id: "narrator-2",
			title: "",
			workspaceId: "workspace-1",
			updateOnly: true,
		});
		await Promise.resolve();

		expect(upsertRecentTab).toHaveBeenCalledTimes(1);
		expect(upsertRecentTab.mock.calls[0]?.[0]).toMatchObject({
			type: "narrator",
			id: "narrator-2",
			workspaceId: "workspace-1",
			updateOnly: true,
		});
	});
});

import { describe, expect, test } from "bun:test";
import {
	buildRecentTabUpsert,
	buildSubagentRecentTab,
	shouldAddSubagentRecentTab,
} from "./recent-tabs-utils";

describe("shouldAddSubagentRecentTab", () => {
	test("waits until preferences finish loading", () => {
		expect(
			shouldAddSubagentRecentTab({
				isLoading: true,
				addSubagentToRecentTabs: true,
			}),
		).toBeFalse();
		expect(
			shouldAddSubagentRecentTab({
				isLoading: true,
				addSubagentToRecentTabs: undefined,
			}),
		).toBeFalse();
	});

	test("defaults to enabled after preferences load", () => {
		expect(
			shouldAddSubagentRecentTab({
				isLoading: false,
				addSubagentToRecentTabs: undefined,
			}),
		).toBeTrue();
	});

	test("respects explicit enabled and disabled preferences", () => {
		expect(
			shouldAddSubagentRecentTab({
				isLoading: false,
				addSubagentToRecentTabs: true,
			}),
		).toBeTrue();
		expect(
			shouldAddSubagentRecentTab({
				isLoading: false,
				addSubagentToRecentTabs: false,
			}),
		).toBeFalse();
	});
});

describe("recent tab payload builders", () => {
	test("defaults ordinary visits to a real upsert", () => {
		const payload = buildRecentTabUpsert({
			type: "narrator",
			id: "narrator-1",
			title: "Opened narrator",
			lastVisitedAt: 100,
		});

		expect(payload).toMatchObject({
			type: "narrator",
			id: "narrator-1",
			title: "Opened narrator",
			lastVisitedAt: 100,
			updateOnly: false,
		});
	});

	test("normalizes nullable text fields", () => {
		const payload = buildRecentTabUpsert({
			type: "narrator",
			id: "narrator-null-cwd",
			title: "Narrator without cwd",
			subtitle: null as unknown as string,
		});

		expect(payload.subtitle).toBeUndefined();
	});

	test("builds standalone subagent navigation metadata", () => {
		const payload = buildRecentTabUpsert(
			buildSubagentRecentTab({
				id: "subagent-1",
				parentNarratorId: "parent-1",
				title: "Child task",
				cwd: "/workspace/project",
				status: "working",
				isScheduled: true,
			}),
		);

		expect(payload).toMatchObject({
			type: "subagent",
			id: "subagent-1",
			parentNarratorId: "parent-1",
			title: "Child task",
			subtitle: "/workspace/project",
			status: "working",
			isScheduled: true,
			updateOnly: false,
		});
	});

	test("preserves explicit updateOnly for workspace membership updates", () => {
		const payload = buildRecentTabUpsert({
			type: "chapter",
			id: "chapter-1",
			narratorId: "narrator-1",
			workspaceId: "workspace-1",
			title: "Chapter",
			updateOnly: true,
		});

		expect(payload.updateOnly).toBeTrue();
	});
});

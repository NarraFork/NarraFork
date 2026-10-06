import { describe, expect, test } from "bun:test";
import type { PublicCodexQuotaOverview } from "../../../server/lib/codex-manager";
import { createCodexQuotaOverviewWsMessage } from "../../../server/websocket/narrator-ws-types";

describe("Codex quota WebSocket contract", () => {
	test("forwards modeled plus missing usage as mixed coverage", () => {
		const overview: PublicCodexQuotaOverview = {
			generatedAt: "2026-05-01T00:00:00.000Z",
			unit: "account_equivalent",
			totalRemainingAccountEquivalents: 0.6,
			totalAccountEquivalents: 1,
			trackedAccountCount: 2,
			modeledAccountCount: 1,
			unmodeledAccountCount: 1,
			segments: [
				{
					type: "plus",
					remainingAccountEquivalents: 0.6,
					totalAccountEquivalents: 1,
					trackedAccountCount: 1,
					modeledAccountCount: 1,
					unmodeledAccountCount: 0,
					averageRemainingPercent: 60,
					nextResetAt: 1_800_000_000_000,
				},
			],
			trend: {
				generatedAt: "2026-05-01T00:00:00.000Z",
				points: [{ timestamp: 1_700_000_000_000, byType: { plus: 0.6 } }],
				types: ["plus"],
			},
			nextResetAt: 1_800_000_000_000,
			usageQueueRunning: false,
			schedulerStarted: true,
		};

		const message = createCodexQuotaOverviewWsMessage(overview);
		expect(message).toEqual({
			type: "codex_quota_overview_updated",
			overview,
		});
		expect(message.overview.segments[0]?.unmodeledAccountCount).toBe(0);
		expect(message.overview.unmodeledAccountCount).toBe(1);
	});
});

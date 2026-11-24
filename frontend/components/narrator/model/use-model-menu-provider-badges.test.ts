import { describe, expect, test } from "bun:test";
import type { PublicQuotaSnapshot, QuotaSnapshotEntry } from "@shared/quota-snapshot";
import { selectQuotaEntries } from "../../../hooks/useQuotaSnapshots";
import { buildModelMenuProviderBadges } from "./use-model-menu-provider-badges";

const t = (key: string, options?: Record<string, unknown>) =>
	`${key}${options ? ` ${JSON.stringify(options)}` : ""}`;
const snapshot = (overrides: Partial<PublicQuotaSnapshot> = {}): PublicQuotaSnapshot => ({
	fetchedAt: 10,
	scope: "key",
	windows: [],
	balances: [],
	...overrides,
});
const entry = (
	templateId: string,
	value: PublicQuotaSnapshot | null,
	overrides: Partial<QuotaSnapshotEntry> = {},
): QuotaSnapshotEntry => ({
	groupId: templateId,
	prefix: templateId,
	templateId,
	credentialId: "key",
	snapshot: value,
	supported: true,
	...overrides,
});

describe("unified model-menu quota badges", () => {
	test("all templates get the same window and balance presentation", () => {
		const templates = [
			"codex",
			"kimi-code",
			"opencode-go",
			"deepseek",
			"tokendance",
			"command-code",
			"nug",
			"openai-compatible",
		];
		for (const template of templates) {
			const result = buildModelMenuProviderBadges(
				[
					entry(
						template,
						snapshot({
							windows: [{ kind: "5h", usedRatio: 0.8, resetsAt: 1000 }],
							balances: [{ unit: "USD", remaining: 12.5 }],
							plan: "Pro",
						}),
					),
				],
				100,
				t,
			);
			expect(result.providerBadges?.[template].bars?.[0].remainingPercent).toBe(20);
			expect(result.providerBalances?.[template].text).toContain("12.5");
		}
	});

	test("stream never replaces valid probe windows, regardless of entry order", () => {
		const probe = entry(
			"kimi-code",
			snapshot({ windows: [{ kind: "weekly", usedRatio: 0.2, resetsAt: null }] }),
			{ source: "probe" },
		);
		const stream = entry("kimi-code", snapshot({ balances: [{ unit: "USD", remaining: 9 }] }), {
			source: "quota_balance",
		});
		expect(selectQuotaEntries([probe, stream])).toEqual([probe]);
		expect(selectQuotaEntries([stream, probe])).toEqual([probe]);
		const unknownProbe = { ...probe, snapshot: null };
		expect(selectQuotaEntries([unknownProbe, stream])).toEqual([stream]);
	});

	test("keeps credentials separate and never sums a shared account wallet", () => {
		const values = ["one", "two"].map((credentialId) =>
			entry(
				"nug",
				snapshot({
					balances: [{ unit: "USD", remaining: 10 }],
				}),
				{ credentialId },
			),
		);
		const result = buildModelMenuProviderBadges(values, 100, t);
		expect(result.providerBalances?.nug.text).toContain(" / ");
		expect(result.providerBalances?.nug.text).not.toContain("20");
	});

	test("unknown/plugin/no key never looks like zero; disabled sources stay hidden", () => {
		const result = buildModelMenuProviderBadges(
			[
				entry("command-code", null, { credentialId: null }),
				entry("plugin", null, { supported: false }),
				entry("disabled", snapshot({ balances: [{ unit: "USD", remaining: 0 }] })),
			],
			100,
			t,
			{ customApiProviders: [{ id: "disabled", disabled: true }] },
		);
		expect(result.providerBadges?.["command-code"].text).not.toContain("0");
		expect(result.providerBadges?.plugin).toBeUndefined();
		expect(result.providerBalances).toBeUndefined();
	});

	test("failed snapshots retain known values dimmed and unlimited stays unlimited", () => {
		const result = buildModelMenuProviderBadges(
			[
				entry(
					"nug",
					snapshot({
						hasError: true,
						balances: [{ unit: "USD", remaining: null, unlimited: true }],
					}),
				),
				entry(
					"kimi",
					snapshot({
						error: "unavailable",
						windows: [{ kind: "weekly", usedRatio: 1, resetsAt: 500 }],
					}),
				),
			],
			100,
			t,
		);
		expect(result.providerBalances?.nug.stale).toBe(true);
		expect(result.providerBalances?.nug.text).not.toContain("0");
		expect(result.providerBadges?.kimi.stale).toBe(true);
		expect(result.providerBadges?.kimi.bars?.[0].level).toBe("exhausted");
	});
});

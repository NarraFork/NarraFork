import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { AppError } from "../../../server/lib/errors";

type CodexTier = "free" | "plus" | "team" | "k12" | "prolite" | "pro" | "other";

const DEFAULT_CODEX_TIER_ORDER: CodexTier[] = ["pro", "prolite", "plus", "team", "k12", "free"];
const ALL_CODEX_TIER_ORDER: CodexTier[] = [...DEFAULT_CODEX_TIER_ORDER, "other"];

const settingsState: {
	codex: {
		useWebSocket?: boolean;
		defaultReasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
		loadBalancingMode?: "priority" | "balanced" | "tier-balanced";
		tierOrder?: CodexTier[];
	};
} = {
	codex: {
		useWebSocket: undefined,
		defaultReasoningEffort: undefined,
	},
};

let saveSettingsCalls = 0;
let codexImportedCredentials: unknown[] = [];
let codexRemoveUnhealthyCalls = 0;
let managerTierOrder = [...DEFAULT_CODEX_TIER_ORDER];

function getEffectiveTierOrder(): CodexTier[] {
	const effective = [...managerTierOrder];
	for (const tier of ALL_CODEX_TIER_ORDER) {
		if (!effective.includes(tier)) effective.push(tier);
	}
	return effective;
}

const actualSettingsModule = await import("../../../server/lib/settings");

mock.module("../../../server/lib/settings", () => ({
	...actualSettingsModule,
	settings: settingsState,
	saveSettings: () => {
		saveSettingsCalls++;
	},
}));

mock.module("../../../server/lib/codex-manager", () => ({
	getCodexManager: () => ({
		snapshot: () => ({
			available: 0,
			total: 0,
			entries: [],
			availableEntries: [],
			unavailableEntries: [],
			availableTotal: 0,
			unavailableTotal: 0,
			unhealthyTotal: 0,
			stickySessionCount: 0,
			usageCache: {},
			loadBalancingMode: "priority",
			tierOrder: [...managerTierOrder],
			effectiveTierOrder: getEffectiveTierOrder(),
		}),
		setLoadBalancingMode: () => {},
		setTierOrder: (tierOrder: CodexTier[]) => {
			managerTierOrder = [...tierOrder];
		},
		importCredentials: (credentials: unknown[]) => {
			codexImportedCredentials = credentials;
			return { added: credentials.length, duplicates: 0, skipped: 0 };
		},
		removeUnhealthyCredentials: () => {
			codexRemoveUnhealthyCalls++;
			return { removed: ["failed-1", "banned-1"], reasons: ["too_many_failures", "banned"] };
		},
		getPublicQuotaOverview: () => ({
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
		}),
	}),
}));

mock.module("../../../server/lib/codex-usage-queue", () => ({
	codexUsageQueue: {
		clearCompleted: () => {},
		getSnapshot: () => ({ items: [], isRunning: false }),
	},
}));

mock.module("../../../server/lib/logger", () => ({
	logger: {
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
	},
}));

mock.module("../../../server/middleware/auth", () => ({
	requireAuth: async (
		c: { set: (key: string, value: unknown) => void },
		next: () => Promise<void>,
	) => {
		c.set("user", { sub: "admin-1", role: "admin" });
		await next();
	},
	requireAdmin: async (_c: unknown, next: () => Promise<void>) => {
		await next();
	},
}));

const { codexRoutes } = await import("../../../server/routes/codex");

const app = new Hono();
app.route("/", codexRoutes);
app.onError((err, c) => {
	if (err instanceof AppError) {
		return c.json({ error: err.message, code: err.code }, err.statusCode as ContentfulStatusCode);
	}
	return c.json({ error: String(err) }, 500);
});

beforeEach(() => {
	settingsState.codex.useWebSocket = undefined;
	settingsState.codex.defaultReasoningEffort = undefined;
	settingsState.codex.loadBalancingMode = undefined;
	settingsState.codex.tierOrder = undefined;
	saveSettingsCalls = 0;
	codexImportedCredentials = [];
	codexRemoveUnhealthyCalls = 0;
	managerTierOrder = [...DEFAULT_CODEX_TIER_ORDER];
});

describe("codex routes validation", () => {
	it("defaults websocket mode to enabled when unset", async () => {
		const res = await app.request("/status");

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ useWebSocket: true });
	});

	it("returns modeled plus missing usage as mixed HTTP coverage", async () => {
		const res = await app.request("/quota-overview");

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			trend: { types: string[]; points: Array<{ byType: Record<string, number> }> };
		};
		expect(body).toMatchObject({
			totalRemainingAccountEquivalents: 0.6,
			trackedAccountCount: 2,
			modeledAccountCount: 1,
			unmodeledAccountCount: 1,
			segments: [
				{
					type: "plus",
					trackedAccountCount: 1,
					modeledAccountCount: 1,
					unmodeledAccountCount: 0,
					averageRemainingPercent: 60,
				},
			],
			trend: { types: ["plus"], points: [{ byType: { plus: 0.6 } }] },
		});
	});

	it("accepts boolean websocket settings and persists them", async () => {
		const res = await app.request("/use-websocket", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ useWebSocket: true }),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, useWebSocket: true });
		expect(settingsState.codex.useWebSocket).toBe(true);
		expect(saveSettingsCalls).toBe(1);
	});

	it("rejects non-boolean websocket settings", async () => {
		const res = await app.request("/use-websocket", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ useWebSocket: "false" }),
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
		expect(settingsState.codex.useWebSocket).toBeUndefined();
		expect(saveSettingsCalls).toBe(0);
	});

	it("rejects unsupported default reasoning effort values", async () => {
		const res = await app.request("/default-reasoning-effort", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ reasoningEffort: "turbo" }),
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
		expect(settingsState.codex.defaultReasoningEffort).toBeUndefined();
		expect(saveSettingsCalls).toBe(0);
	});

	it("accepts tier-balanced load balancing mode", async () => {
		const res = await app.request("/load-balancing-mode", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mode: "tier-balanced" }),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, mode: "tier-balanced" });
		expect(settingsState.codex.loadBalancingMode).toBe("tier-balanced");
		expect(saveSettingsCalls).toBe(1);
	});

	it("rejects unsupported load balancing modes", async () => {
		const res = await app.request("/load-balancing-mode", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mode: "fastest" }),
		});

		expect(res.status).toBe(400);
		expect(settingsState.codex.loadBalancingMode).toBeUndefined();
		expect(saveSettingsCalls).toBe(0);
	});

	it("accepts k12 in custom tier order", async () => {
		const res = await app.request("/tier-order", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tierOrder: ["k12", "free"] }),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			ok: true,
			tierOrder: ["k12", "free"],
			effectiveTierOrder: ["k12", "free", "pro", "prolite", "plus", "team", "other"],
		});
		expect(settingsState.codex.tierOrder).toEqual(["k12", "free"]);
		expect(saveSettingsCalls).toBe(1);
	});

	it("normalizes custom tier order and appends the full default tail including k12", async () => {
		const res = await app.request("/tier-order", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tierOrder: ["plus", "pro", "plus", "free"] }),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			ok: true,
			tierOrder: ["plus", "pro", "free"],
			effectiveTierOrder: ["plus", "pro", "free", "prolite", "team", "k12", "other"],
		});
		expect(settingsState.codex.tierOrder).toEqual(["plus", "pro", "free"]);
		expect(saveSettingsCalls).toBe(1);
	});

	it("rejects invalid tier order values", async () => {
		const res = await app.request("/tier-order", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tierOrder: ["pro", "enterprise"] }),
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ code: "VALIDATION_ERROR" });
		expect(settingsState.codex.tierOrder).toBeUndefined();
		expect(saveSettingsCalls).toBe(0);
	});

	it("extracts email from at-marker import text", async () => {
		const res = await app.request("/import", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				importText: "user@example.com----password-----at----access-token-from-line",
			}),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ added: 1, duplicates: 0, skipped: 0 });
		expect(codexImportedCredentials).toEqual([
			{
				accessToken: "access-token-from-line",
				email: "user@example.com",
				displayName: "user@example.com",
			},
		]);
	});

	it("expands sub2api account exports during import", async () => {
		const res = await app.request("/import", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				importText: JSON.stringify({
					exported_at: "2026-05-18T14:06:47.807Z",
					accounts: [
						{
							name: "Sub2Api Plus Account",
							platform: "openai",
							type: "oauth",
							credentials: {
								access_token: "access-token-from-sub2api",
								chatgpt_account_id: "acc-sub2api",
								chatgpt_user_id: "user-sub2api",
								email: "sub2api@example.com",
								expires_at: "2026-05-28T14:06:40.000Z",
							},
							priority: 3,
						},
					],
				}),
			}),
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ added: 1, duplicates: 0, skipped: 0 });
		expect(codexImportedCredentials).toEqual([
			expect.objectContaining({
				name: "Sub2Api Plus Account",
				priority: 3,
				credentials: expect.objectContaining({
					access_token: "access-token-from-sub2api",
					chatgpt_account_id: "acc-sub2api",
					chatgpt_user_id: "user-sub2api",
					email: "sub2api@example.com",
				}),
			}),
		]);
	});

	it("deletes all unhealthy Codex credentials across pages", async () => {
		const res = await app.request("/credentials/unhealthy", { method: "DELETE" });

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			removed: ["failed-1", "banned-1"],
			reasons: ["too_many_failures", "banned"],
		});
		expect(codexRemoveUnhealthyCalls).toBe(1);
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexManager } from "../codex-manager";

function createManagerWithOneCredential(
	id: string,
	overrides: Record<string, unknown> = {},
): { manager: CodexManager; tmpHome: string } {
	const tmpHome = mkdtempSync(join(tmpdir(), "narrafork-codex-usage-"));
	const narraforkDir = join(tmpHome, ".narrafork");
	mkdirSync(narraforkDir, { recursive: true });

	const now = Date.now();
	const payload = [
		{
			id,
			refreshToken: `rt-${id}`,
			accessToken: `at-${id}`,
			expiresAt: now + 30 * 60_000,
			accountId: `acc-${id}`,
			priority: 0,
			disabled: false,
			...overrides,
		},
	];
	writeFileSync(join(narraforkDir, "codex-credentials.json"), JSON.stringify(payload, null, 2));
	writeFileSync(join(narraforkDir, "codex-stats.json"), JSON.stringify({}, null, 2));

	const manager = new CodexManager({ homeDir: tmpHome, registerProcessHooks: false });
	return { manager, tmpHome };
}

function createUsageResponse(primaryUsedPercent: number, resetAtSec: number): Response {
	return new Response(
		JSON.stringify({
			plan_type: "plus",
			rate_limit: {
				allowed: true,
				limit_reached: primaryUsedPercent >= 100,
				primary_window: {
					used_percent: primaryUsedPercent,
					limit_window_seconds: 18_000,
					reset_after_seconds: Math.max(resetAtSec - Math.floor(Date.now() / 1000), 0),
					reset_at: resetAtSec,
				},
				secondary_window: null,
			},
			code_review_rate_limit: {
				allowed: true,
				limit_reached: false,
				primary_window: null,
				secondary_window: null,
			},
			additional_rate_limits: [],
		}),
		{
			status: 200,
			headers: { "Content-Type": "application/json" },
		},
	);
}

const tempHomes: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const p of tempHomes.splice(0)) {
		rmSync(p, { recursive: true, force: true });
	}
});

describe("CodexManager usage quota state", () => {
	test("查询 usage 剩余为 0% 时直接标记 quota_exhausted", async () => {
		const { manager, tmpHome } = createManagerWithOneCredential("cred-a");
		tempHomes.push(tmpHome);
		const resetAtSec = Math.floor(Date.now() / 1000) + 3600;

		globalThis.fetch = (async () =>
			createUsageResponse(100, resetAtSec)) as unknown as typeof fetch;

		await manager.getUsage("cred-a");
		const entry = manager.snapshot().entries.find((item) => item.id === "cred-a");

		expect(entry).toBeDefined();
		expect(entry?.disabled).toBe(true);
		expect(entry?.disabledReason).toBe("quota_exhausted");
		expect(entry?.quotaResetsAt).toBe(resetAtSec * 1000);
	});

	test("查询 usage 仍有剩余时不标记 quota_exhausted", async () => {
		const { manager, tmpHome } = createManagerWithOneCredential("cred-b");
		tempHomes.push(tmpHome);
		const resetAtSec = Math.floor(Date.now() / 1000) + 3600;

		globalThis.fetch = (async () => createUsageResponse(62, resetAtSec)) as unknown as typeof fetch;

		await manager.getUsage("cred-b");
		const entry = manager.snapshot().entries.find((item) => item.id === "cred-b");

		expect(entry).toBeDefined();
		expect(entry?.disabled).toBe(false);
		expect(entry?.disabledReason).toBeUndefined();
	});

	test("查询 usage 恢复剩余时清理 quota_exhausted 状态", async () => {
		const { manager, tmpHome } = createManagerWithOneCredential("cred-c", {
			disabled: true,
			disabledReason: "quota_exhausted",
			quotaResetsAt: Date.now() - 1_000,
		});
		tempHomes.push(tmpHome);
		const resetAtSec = Math.floor(Date.now() / 1000) + 3600;

		globalThis.fetch = (async () => createUsageResponse(62, resetAtSec)) as unknown as typeof fetch;

		await manager.getUsage("cred-c");
		const entry = manager.snapshot().entries.find((item) => item.id === "cred-c");

		expect(entry).toBeDefined();
		expect(entry?.disabled).toBe(false);
		expect(entry?.disabledReason).toBeUndefined();
		expect(entry?.quotaResetsAt).toBeUndefined();
	});

	test("quota_exhausted 调度优先使用耗尽窗口的恢复时间", () => {
		const now = Date.now();
		const quotaResetsAt = now + 120_000;
		const { manager, tmpHome } = createManagerWithOneCredential("cred-d", {
			disabled: true,
			disabledReason: "quota_exhausted",
			quotaResetsAt,
			usage: {
				plan_type: "plus",
				primary_window: {
					used_percent: 50,
					remaining_percent: 50,
					reset_at: Math.floor((now + 60_000) / 1000),
					reset_after_seconds: 60,
					window_type: "5h",
				},
				secondary_window: {
					used_percent: 100,
					remaining_percent: 0,
					reset_at: Math.floor(quotaResetsAt / 1000),
					reset_after_seconds: 120,
					window_type: "weekly",
				},
				queriedAt: new Date(now).toISOString(),
			},
		});
		tempHomes.push(tmpHome);

		expect(manager.snapshot().usageScheduler.nextRunAt).toBe(quotaResetsAt);
	});
});

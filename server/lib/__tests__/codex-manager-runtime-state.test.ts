import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexManager } from "../codex-manager";
import { readSecretJSON } from "../secret-store";

const homes: string[] = [];
const managers: CodexManager[] = [];
const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	for (const manager of managers.splice(0)) manager.dispose();
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function setupHome(credentials: unknown[], files: { stats?: unknown; state?: unknown } = {}) {
	const home = mkdtempSync(join(tmpdir(), "narrafork-codex-state-"));
	homes.push(home);
	const dir = join(home, ".narrafork");
	mkdirSync(dir, { recursive: true });
	const paths = {
		credentials: join(dir, "codex-credentials.json"),
		stats: join(dir, "codex-stats.json"),
		state: join(dir, "credential-state.json"),
	};
	writeFileSync(paths.credentials, JSON.stringify(credentials));
	if (files.stats) writeFileSync(paths.stats, JSON.stringify(files.stats));
	if (files.state) writeFileSync(paths.state, JSON.stringify(files.state));
	return { home, paths };
}

function open(home: string): CodexManager {
	const manager = new CodexManager({ homeDir: home, registerProcessHooks: false });
	managers.push(manager);
	return manager;
}

function credential(id: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		refreshToken: `rt-${id}`,
		accessToken: `at-${id}`,
		expiresAt: Date.now() + 60 * 60_000,
		accountId: `acc-${id}`,
		priority: 0,
		disabled: false,
		...extra,
	};
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const storedCredentials = (path: string) => readSecretJSON(path) as Array<Record<string, unknown>>;

function mockUsage(usedPercent: number) {
	const resetAt = Math.floor(Date.now() / 1000) + 3_600;
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({
				plan_type: "plus",
				rate_limit: {
					allowed: usedPercent < 100,
					limit_reached: usedPercent >= 100,
					primary_window: {
						used_percent: usedPercent,
						limit_window_seconds: 18_000,
						reset_after_seconds: 3_600,
						reset_at: resetAt,
					},
					secondary_window: null,
				},
				additional_rate_limits: [],
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		)) as unknown as typeof fetch;
}

describe("CodexManager runtime state", () => {
	test("usage refreshes and request outcomes go to credential-state.json, not the credential file", async () => {
		const { home, paths } = setupHome([credential("a")]);
		const manager = open(home);
		// Loading a current-format file rewrites nothing.
		const before = readFileSync(paths.credentials, "utf8");

		mockUsage(40);
		await manager.getUsage("a");
		manager.reportSuccess("a");
		manager.reportSuccess("a");
		manager.reportFailure("a");
		expect(readFileSync(paths.credentials, "utf8")).toBe(before);

		manager.dispose();
		const state = readJson(paths.state).a;
		expect(state.usage.plan_type).toBe("plus");
		expect(state.usageHistory).toHaveLength(1);
		expect(state.stats).toMatchObject({ successCount: 2, failureCount: 1 });
		expect(state.blocked).toBeUndefined();

		const reloaded = open(home).snapshot().entries[0];
		expect(reloaded).toMatchObject({ successCount: 2, failureCount: 1, disabled: false });
		expect(reloaded?.usage?.plan_type).toBe("plus");
	});

	test("system blocks persist as state; a ban stays on the credential", async () => {
		const { home, paths } = setupHome([credential("a"), credential("b", { priority: 1 })]);
		const manager = open(home);
		const before = readFileSync(paths.credentials, "utf8");

		mockUsage(100);
		await manager.getUsage("a");
		for (let i = 0; i < 3; i++) manager.reportFailure("b");
		expect(readFileSync(paths.credentials, "utf8")).toBe(before);
		manager.dispose();

		const state = readJson(paths.state);
		expect(state.a.blocked.reason).toBe("quota_exhausted");
		expect(state.a.blocked.resetsAt).toBeGreaterThan(Date.now());
		expect(state.b.blocked).toEqual({ reason: "too_many_failures" });
		expect(storedCredentials(paths.credentials).every((c) => c.disabled === false)).toBe(true);

		const reloaded = open(home);
		expect(reloaded.snapshot().entries.map((e) => [e.id, e.disabled, e.disabledReason])).toEqual([
			["a", true, "quota_exhausted"],
			["b", true, "too_many_failures"],
		]);

		reloaded.markBanned("a");
		const banned = storedCredentials(paths.credentials).find((c) => c.id === "a");
		expect(banned).toMatchObject({ disabled: true, disabledReason: "banned" });
		reloaded.dispose();
		expect(readJson(paths.state).a.blocked).toBeUndefined();
	});

	test("recovery clears only the system block and leaves a manual stop alone", async () => {
		const { home, paths } = setupHome(
			[
				credential("quota"),
				credential("failed", { priority: 1 }),
				credential("manual", { priority: 2, disabled: true, disabledReason: "manual" }),
			],
			{
				state: {
					quota: { blocked: { reason: "quota_exhausted", resetsAt: Date.now() - 1_000 } },
					failed: { blocked: { reason: "too_many_failures" } },
					// A stale block under a manual stop must not replace it.
					manual: { blocked: { reason: "quota_exhausted", resetsAt: Date.now() - 1_000 } },
				},
			},
		);
		const manager = open(home);
		const before = readFileSync(paths.credentials, "utf8");
		const status = () =>
			Object.fromEntries(manager.snapshot().entries.map((e) => [e.id, e.disabledReason ?? "ok"]));

		expect(status()).toEqual({ quota: "ok", failed: "too_many_failures", manual: "manual" });
		expect(readFileSync(paths.credentials, "utf8")).toBe(before);

		manager.setDisabled("quota", true);
		const afterManualStop = readFileSync(paths.credentials, "utf8");
		const context = await manager.acquireContext();
		expect(context.id).toBe("failed");
		expect(status()).toEqual({ quota: "manual", failed: "ok", manual: "manual" });
		expect(readFileSync(paths.credentials, "utf8")).toBe(afterManualStop);

		manager.dispose();
		const state = readJson(paths.state);
		expect(Object.values(state).some((s) => (s as { blocked?: unknown }).blocked)).toBe(false);
		const stored = storedCredentials(paths.credentials);
		expect(stored.find((c) => c.id === "manual")).toMatchObject({ disabledReason: "manual" });
	});

	test("upgrades runtime fields in the credential file and codex-stats.json in place", () => {
		const resetsAt = Date.now() + 3_600_000;
		const usage = { plan_type: "pro", queriedAt: new Date().toISOString() };
		const history = [{ timestamp: Date.now() - 60_000, tier: "pro", remainingPercent: 50 }];
		const { home, paths } = setupHome(
			[
				credential("a", {
					disabled: true,
					disabledReason: "quota_exhausted",
					quotaResetsAt: resetsAt,
					usage,
					usageHistory: history,
				}),
				credential("b", { priority: 1, disabled: true, disabledReason: "manual" }),
			],
			{ stats: { a: { successCount: 7, failureCount: 3, lastUsedAt: "2026-01-01T00:00:00Z" } } },
		);

		const manager = open(home);

		expect(existsSync(paths.stats)).toBe(false);
		expect(readJson(paths.state)).toEqual({
			a: {
				usage,
				usageHistory: history,
				blocked: { reason: "quota_exhausted", resetsAt },
				stats: { successCount: 7, failureCount: 3, lastUsedAt: "2026-01-01T00:00:00Z" },
			},
		});
		const stored = storedCredentials(paths.credentials);
		expect(stored[0]).not.toHaveProperty("usage");
		expect(stored[0]).not.toHaveProperty("usageHistory");
		expect(stored[0]).not.toHaveProperty("quotaResetsAt");
		expect(stored[0]).toMatchObject({ disabled: false });
		expect(stored[0]).not.toHaveProperty("disabledReason");
		expect(stored[1]).toMatchObject({ disabled: true, disabledReason: "manual" });

		// What callers see is unchanged.
		expect(manager.snapshot().entries[0]).toMatchObject({
			disabled: true,
			disabledReason: "quota_exhausted",
			quotaResetsAt: resetsAt,
			successCount: 7,
			usage,
		});
	});

	test("writes nothing when the credential file cannot be read", () => {
		const { home, paths } = setupHome([], { stats: { a: { successCount: 1, failureCount: 0 } } });
		const envelope = {
			format: "narrafork.secret.v1",
			cipher: "aes-256-gcm",
			iv: "AAAAAAAAAAAAAAAA",
			tag: "AAAAAAAAAAAAAAAAAAAAAA==",
			data: "AAAA",
		};
		writeFileSync(paths.credentials, JSON.stringify(envelope));
		const before = readFileSync(paths.credentials, "utf8");

		const manager = open(home);
		manager.reportSuccess("a");
		manager.dispose();

		expect(readFileSync(paths.credentials, "utf8")).toBe(before);
		expect(existsSync(paths.stats)).toBe(true);
		expect(existsSync(paths.state)).toBe(false);
	});

	test("an unreadable state file starts empty without blocking credentials", () => {
		const { home, paths } = setupHome([credential("a")]);
		writeFileSync(paths.state, "{broken");
		const entries = open(home).snapshot().entries;
		expect(entries.map((e) => [e.id, e.disabled, e.successCount])).toEqual([["a", false, 0]]);
	});
});

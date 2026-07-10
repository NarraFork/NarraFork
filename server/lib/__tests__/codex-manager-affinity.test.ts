import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexManager } from "../codex-manager";

function createManagerWithCredentials(
	creds: Array<{
		id: string;
		priority: number;
		planType?: string;
		remainingPercent?: number;
	}>,
): {
	manager: CodexManager;
	tmpHome: string;
} {
	const tmpHome = mkdtempSync(join(tmpdir(), "narrafork-codex-affinity-"));
	const narraforkDir = join(tmpHome, ".narrafork");
	mkdirSync(narraforkDir, { recursive: true });

	const now = Date.now();
	const payload = creds.map((c, i) => ({
		id: c.id,
		refreshToken: `rt-${c.id}`,
		accessToken: `at-${c.id}`,
		expiresAt: now + 30 * 60_000,
		accountId: `acc-${c.id}`,
		priority: c.priority,
		disabled: false,
		disabledReason: undefined,
		usage:
			c.planType || i % 2 === 0
				? {
						plan_type: c.planType ?? "pro",
						...(c.remainingPercent !== undefined
							? {
									primary_window: {
										used_percent: 100 - c.remainingPercent,
										remaining_percent: c.remainingPercent,
										reset_at: Math.floor((now + 60 * 60_000) / 1000),
										reset_after_seconds: 60 * 60,
										window_type: "5h",
									},
								}
							: {}),
						queriedAt: new Date(now).toISOString(),
					}
				: undefined,
	}));
	writeFileSync(join(narraforkDir, "codex-credentials.json"), JSON.stringify(payload, null, 2));
	writeFileSync(join(narraforkDir, "codex-stats.json"), JSON.stringify({}, null, 2));

	const manager = new CodexManager({ homeDir: tmpHome, registerProcessHooks: false });
	return { manager, tmpHome };
}

const tempHomes: string[] = [];

afterEach(() => {
	for (const p of tempHomes.splice(0)) {
		rmSync(p, { recursive: true, force: true });
	}
});

describe("CodexManager session affinity", () => {
	test("balanced 模式下同一 session 复用同一 credential", async () => {
		const { manager, tmpHome } = createManagerWithCredentials([
			{ id: "cred-a", priority: 0 },
			{ id: "cred-b", priority: 1 },
		]);
		tempHomes.push(tmpHome);

		manager.setLoadBalancingMode("balanced");

		const first = await manager.acquireContext("session-1");
		const second = await manager.acquireContext("session-1");

		expect(second.id).toBe(first.id);
		expect(manager.snapshot().stickySessionCount).toBe(1);
	});

	test("balanced 模式不同 session 随机分配（不考虑 priority）", async () => {
		const { manager, tmpHome } = createManagerWithCredentials([
			{ id: "cred-a", priority: 0 },
			{ id: "cred-b", priority: 1 },
		]);
		tempHomes.push(tmpHome);

		manager.setLoadBalancingMode("balanced");

		const originalRandom = Math.random;
		const randomValues = [0.1, 0.9];
		let randomIndex = 0;
		Math.random = () => randomValues[randomIndex++] ?? 0;

		try {
			const s1 = await manager.acquireContext("session-a");
			const s2 = await manager.acquireContext("session-b");

			expect(s1.id).toBe("cred-a");
			expect(s2.id).toBe("cred-b");
			expect(manager.snapshot().stickySessionCount).toBe(2);
		} finally {
			Math.random = originalRandom;
		}
	});

	test("粘性绑定凭据被禁用后自动切换并重绑", async () => {
		const { manager, tmpHome } = createManagerWithCredentials([
			{ id: "cred-a", priority: 0 },
			{ id: "cred-b", priority: 1 },
		]);
		tempHomes.push(tmpHome);

		manager.setLoadBalancingMode("balanced");

		const first = await manager.acquireContext("session-1");
		manager.setDisabled(first.id, true);

		const second = await manager.acquireContext("session-1");
		expect(second.id).not.toBe(first.id);
		expect(manager.snapshot().stickySessionCount).toBe(1);
	});

	test("priority 模式不受会话粘性影响", async () => {
		const { manager, tmpHome } = createManagerWithCredentials([
			{ id: "cred-a", priority: 0 },
			{ id: "cred-b", priority: 1 },
		]);
		tempHomes.push(tmpHome);

		const originalRandom = Math.random;
		const randomValues = [0.8, 0.1];
		let randomIndex = 0;
		Math.random = () => randomValues[randomIndex++] ?? 0;

		try {
			manager.setLoadBalancingMode("balanced");
			const first = await manager.acquireContext("session-1");
			manager.reportSuccess(first.id);
			const second = await manager.acquireContext("session-2");
			expect(second.id).not.toBe(first.id);
			expect(manager.snapshot().stickySessionCount).toBe(2);

			manager.setLoadBalancingMode("priority");
			expect(manager.snapshot().stickySessionCount).toBe(0);

			const p1 = await manager.acquireContext("session-1");
			const p2 = await manager.acquireContext("session-2");
			expect(p1.id).toBe("cred-a");
			expect(p2.id).toBe("cred-a");
			expect(manager.snapshot().stickySessionCount).toBe(0);
		} finally {
			Math.random = originalRandom;
		}
	});

	test("balanced 无 sessionKey 时保持旧行为且不创建粘性绑定", async () => {
		const { manager, tmpHome } = createManagerWithCredentials([
			{ id: "cred-a", priority: 0 },
			{ id: "cred-b", priority: 1 },
		]);
		tempHomes.push(tmpHome);

		const originalRandom = Math.random;
		const randomValues = [0.1, 0.9];
		let randomIndex = 0;
		Math.random = () => randomValues[randomIndex++] ?? 0;

		try {
			manager.setLoadBalancingMode("balanced");
			const first = await manager.acquireContext();
			manager.reportSuccess(first.id);
			const second = await manager.acquireContext();

			expect(second.id).not.toBe(first.id);
			expect(manager.snapshot().stickySessionCount).toBe(0);
		} finally {
			Math.random = originalRandom;
		}
	});

	test("tier-balanced 默认 effectiveTierOrder 包含 K12 的完整顺序", () => {
		const { manager, tmpHome } = createManagerWithCredentials([]);
		tempHomes.push(tmpHome);

		expect(manager.snapshot().effectiveTierOrder).toEqual([
			"pro",
			"prolite",
			"plus",
			"team",
			"k12",
			"free",
			"other",
		]);
	});

	test("tier-balanced 默认按 pro/prolite/plus/team/k12/free 选择最高等级", async () => {
		const { manager, tmpHome } = createManagerWithCredentials([
			{ id: "cred-plus", priority: 0, planType: "plus" },
			{ id: "cred-pro", priority: 10, planType: "pro" },
			{ id: "cred-team", priority: 1, planType: "team" },
		]);
		tempHomes.push(tmpHome);

		manager.setLoadBalancingMode("tier-balanced");

		const ctx = await manager.acquireContext("session-tier");
		expect(ctx.id).toBe("cred-pro");
		expect(manager.snapshot().stickySessionCount).toBe(1);
	});

	test("tier-balanced 在 Team/K12/Free 中优先 Team，Team 不可用后优先 K12", async () => {
		const { manager, tmpHome } = createManagerWithCredentials([
			{ id: "cred-free", priority: 0, planType: "free" },
			{ id: "cred-k12", priority: 1, planType: "k12" },
			{ id: "cred-team", priority: 2, planType: "team" },
		]);
		tempHomes.push(tmpHome);

		manager.setLoadBalancingMode("tier-balanced");

		const withTeam = await manager.acquireContext("session-with-team");
		expect(withTeam.id).toBe("cred-team");

		manager.setDisabled("cred-team", true);
		const withoutTeam = await manager.acquireContext("session-without-team");
		expect(withoutTeam.id).toBe("cred-k12");
	});

	test("K12 凭据出现在公共额度 segments 和 trend 中", () => {
		const { manager, tmpHome } = createManagerWithCredentials([
			{ id: "cred-k12", priority: 0, planType: "k12", remainingPercent: 65 },
		]);
		tempHomes.push(tmpHome);

		const overview = manager.getPublicQuotaOverview();

		expect(overview.segments).toContainEqual(
			expect.objectContaining({
				type: "k12",
				remainingAccountEquivalents: 0.65,
				totalAccountEquivalents: 1,
			}),
		);
		expect(overview.trend.types).toContain("k12");
		expect(overview.trend.points.length).toBeGreaterThan(0);
		expect(overview.trend.points[0]?.byType.k12).toBe(0.65);
	});

	test("tier-balanced 同等级内均衡随机选择", async () => {
		const { manager, tmpHome } = createManagerWithCredentials([
			{ id: "cred-pro-a", priority: 0, planType: "pro" },
			{ id: "cred-pro-b", priority: 1, planType: "pro" },
			{ id: "cred-plus", priority: 2, planType: "plus" },
		]);
		tempHomes.push(tmpHome);

		manager.setLoadBalancingMode("tier-balanced");

		const originalRandom = Math.random;
		const randomValues = [0.1, 0.9];
		let randomIndex = 0;
		Math.random = () => randomValues[randomIndex++] ?? 0;

		try {
			const first = await manager.acquireContext("session-a");
			const second = await manager.acquireContext("session-b");

			expect(first.id).toBe("cred-pro-a");
			expect(second.id).toBe("cred-pro-b");
		} finally {
			Math.random = originalRandom;
		}
	});

	test("tier-balanced 支持自定义等级顺序", async () => {
		const { manager, tmpHome } = createManagerWithCredentials([
			{ id: "cred-pro", priority: 0, planType: "pro" },
			{ id: "cred-plus", priority: 1, planType: "plus" },
			{ id: "cred-free", priority: 2, planType: "free" },
		]);
		tempHomes.push(tmpHome);

		manager.setLoadBalancingMode("tier-balanced");
		manager.setTierOrder(["plus", "pro", "free"]);

		const ctx = await manager.acquireContext("session-custom-tier");
		expect(ctx.id).toBe("cred-plus");
		expect(manager.snapshot().effectiveTierOrder.slice(0, 3)).toEqual(["plus", "pro", "free"]);
	});

	test("tier-balanced 将未知等级排在已配置等级之后", async () => {
		const { manager, tmpHome } = createManagerWithCredentials([
			{ id: "cred-unknown", priority: 0, planType: "unknown-plan" },
			{ id: "cred-team", priority: 1, planType: "team" },
		]);
		tempHomes.push(tmpHome);

		manager.setLoadBalancingMode("tier-balanced");

		const ctx = await manager.acquireContext("session-known-tier");
		expect(ctx.id).toBe("cred-team");
	});
});

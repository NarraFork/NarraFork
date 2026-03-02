import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexManager } from "../codex-manager";

function createManagerWithCredentials(creds: Array<{ id: string; priority: number }>): {
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
			i % 2 === 0
				? {
						plan_type: "pro",
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

	test("balanced 模式不同 session 按 least-used 分配", async () => {
		const { manager, tmpHome } = createManagerWithCredentials([
			{ id: "cred-a", priority: 0 },
			{ id: "cred-b", priority: 1 },
		]);
		tempHomes.push(tmpHome);

		manager.setLoadBalancingMode("balanced");

		const s1 = await manager.acquireContext("session-a");
		manager.reportSuccess(s1.id);
		const s2 = await manager.acquireContext("session-b");

		expect(s2.id).not.toBe(s1.id);
		expect(manager.snapshot().stickySessionCount).toBe(2);
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
	});

	test("balanced 无 sessionKey 时保持旧行为且不创建粘性绑定", async () => {
		const { manager, tmpHome } = createManagerWithCredentials([
			{ id: "cred-a", priority: 0 },
			{ id: "cred-b", priority: 1 },
		]);
		tempHomes.push(tmpHome);

		manager.setLoadBalancingMode("balanced");
		const first = await manager.acquireContext();
		manager.reportSuccess(first.id);
		const second = await manager.acquireContext();

		expect(second.id).not.toBe(first.id);
		expect(manager.snapshot().stickySessionCount).toBe(0);
	});
});

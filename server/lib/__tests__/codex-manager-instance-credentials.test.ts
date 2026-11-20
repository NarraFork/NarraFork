import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexManager } from "../codex-manager";

/** 造一个只含指定凭据的账号池；每个平台实例各看自己那部分。 */
function createManagerWithCredentials(ids: readonly string[]): {
	manager: CodexManager;
	tmpHome: string;
} {
	const tmpHome = mkdtempSync(join(tmpdir(), "narrafork-codex-instance-"));
	const narraforkDir = join(tmpHome, ".narrafork");
	mkdirSync(narraforkDir, { recursive: true });
	const now = Date.now();
	const payload = ids.map((id, index) => ({
		id,
		refreshToken: `rt-${id}`,
		accessToken: `at-${id}`,
		expiresAt: now + 30 * 60_000,
		accountId: `acc-${id}`,
		priority: index,
		disabled: false,
		usage: { plan_type: "pro", queriedAt: new Date(now).toISOString() },
	}));
	writeFileSync(join(narraforkDir, "codex-credentials.json"), JSON.stringify(payload, null, 2));
	writeFileSync(join(narraforkDir, "codex-stats.json"), JSON.stringify({}, null, 2));
	return {
		manager: new CodexManager({ homeDir: tmpHome, registerProcessHooks: false }),
		tmpHome,
	};
}

const tempHomes: string[] = [];

afterEach(() => {
	for (const path of tempHomes.splice(0)) rmSync(path, { recursive: true, force: true });
});

function managerWith(ids: readonly string[]): CodexManager {
	const { manager, tmpHome } = createManagerWithCredentials(ids);
	tempHomes.push(tmpHome);
	manager.setLoadBalancingMode("balanced");
	return manager;
}

describe("CodexManager 的平台实例凭据隔离", () => {
	test("实例只在自己选中的凭据里选", async () => {
		const manager = managerWith(["cred-a", "cred-b"]);
		for (let i = 0; i < 5; i += 1) {
			const context = await manager.acquireContext(`session-${i}`, { credentialIds: ["cred-b"] });
			expect(context.id).toBe("cred-b");
		}
	});

	test("两个实例的凭据集合互不影响", async () => {
		const manager = managerWith(["cred-a", "cred-b"]);
		for (let i = 0; i < 5; i += 1) {
			expect((await manager.acquireContext(`a-${i}`, { credentialIds: ["cred-a"] })).id).toBe(
				"cred-a",
			);
			expect((await manager.acquireContext(`b-${i}`, { credentialIds: ["cred-b"] })).id).toBe(
				"cred-b",
			);
		}
	});

	test("选中的凭据一个都不存在时直接失败，不落回其它凭据", async () => {
		const manager = managerWith(["cred-a"]);
		await expect(manager.acquireContext("session", { credentialIds: ["gone"] })).rejects.toThrow(
			"No usable Codex credential is selected for this instance",
		);
	});

	test("不传 credentialIds 时仍用整个凭据池（初始实例的既有行为）", async () => {
		const manager = managerWith(["cred-a", "cred-b"]);
		const seen = new Set<string>();
		for (let i = 0; i < 6; i += 1) {
			seen.add((await manager.acquireContext(`session-${i}`)).id);
		}
		expect(seen.size).toBeGreaterThan(0);
		for (const id of seen) expect(["cred-a", "cred-b"]).toContain(id);
	});

	test("hasAvailableCredentialsAmong 只看选中的凭据", () => {
		const manager = managerWith(["cred-a"]);
		expect(manager.hasAvailableCredentialsAmong(["cred-a"])).toBe(true);
		expect(manager.hasAvailableCredentialsAmong(["cred-b"])).toBe(false);
		expect(manager.hasAvailableCredentialsAmong([])).toBe(false);
	});
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexManager } from "../codex-manager";

// The selector's source rows ask which account a new request would use. Must not touch the
// credential file, unlike snapshot()/hasAvailableCredentials, which revive accounts.

const tempHomes: string[] = [];
afterEach(() => {
	for (const p of tempHomes.splice(0)) rmSync(p, { recursive: true, force: true });
});

function createManager(
	creds: Array<{ id: string; priority: number; disabled?: boolean; quotaResetsAt?: number }>,
) {
	const tmpHome = mkdtempSync(join(tmpdir(), "narrafork-codex-preview-"));
	const dir = join(tmpHome, ".narrafork");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "codex-credentials.json"),
		JSON.stringify(
			creds.map((c) => ({
				id: c.id,
				refreshToken: `rt-${c.id}`,
				accessToken: `at-${c.id}`,
				expiresAt: Date.now() + 30 * 60_000,
				accountId: `acc-${c.id}`,
				displayName: `Account ${c.id}`,
				priority: c.priority,
				disabled: c.disabled === true,
				...(c.quotaResetsAt ? { quotaResetsAt: c.quotaResetsAt } : {}),
			})),
		),
	);
	writeFileSync(join(dir, "codex-stats.json"), JSON.stringify({}));
	return { manager: new CodexManager({ homeDir: tmpHome, registerProcessHooks: false }), dir };
}

describe("CodexManager routingPreview", () => {
	test("the first available account by priority, and no write to the credential file", () => {
		const { manager, dir } = createManager([
			{ id: "b", priority: 1 },
			{ id: "a", priority: 0 },
			{ id: "c", priority: 2, disabled: true },
		]);
		tempHomes.push(join(dir, ".."));
		manager.setLoadBalancingMode("priority");
		const path = join(dir, "codex-credentials.json");
		const before = Bun.file(path).size;
		const mtime = statSync(path).mtimeMs;
		expect(manager.routingPreview.label).toBe("Account a");
		expect(manager.routingPreview.rotating).toBe(false);
		expect(statSync(path).mtimeMs).toBe(mtime);
		expect(Bun.file(path).size).toBe(before);
	});

	test("balanced mode says it rotates", () => {
		const { manager, dir } = createManager([{ id: "a", priority: 0 }]);
		tempHomes.push(join(dir, ".."));
		manager.setLoadBalancingMode("balanced");
		expect(manager.routingPreview.rotating).toBe(true);
	});

	test("when every account is resting, the earliest reset is reported", () => {
		const soon = Date.now() + 30 * 60_000;
		const later = Date.now() + 60 * 60_000;
		const { manager, dir } = createManager([
			{ id: "a", priority: 0, disabled: true, quotaResetsAt: later },
			{ id: "b", priority: 1, disabled: true, quotaResetsAt: soon },
		]);
		tempHomes.push(join(dir, ".."));
		expect(manager.routingPreview.resetsAt).toBe(soon);
		expect(manager.routingPreview.label).toBeUndefined();
	});
});

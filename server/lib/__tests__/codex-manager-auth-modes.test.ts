import { afterEach, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexManager } from "../codex-manager";

function agentPrivateKeyBase64(): string {
	const kp = crypto.generateKeyPairSync("ed25519");
	return (kp.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64");
}

function createManager(): { manager: CodexManager; tmpHome: string } {
	const tmpHome = mkdtempSync(join(tmpdir(), "narrafork-codex-authmodes-"));
	mkdirSync(join(tmpHome, ".narrafork"), { recursive: true });
	const manager = new CodexManager({ homeDir: tmpHome, registerProcessHooks: false });
	return { manager, tmpHome };
}

let cleanup: string[] = [];
afterEach(() => {
	for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
	cleanup = [];
});

describe("CodexManager import auth modes", () => {
	test("imports a personal access token credential", () => {
		const { manager, tmpHome } = createManager();
		cleanup.push(tmpHome);
		try {
			const result = manager.importCredentials([
				{ access_token: "at-personal-token", email: "pat@example.com" },
			]);
			expect(result.added).toBe(1);
			const entry = manager.snapshot().entries.find((e) => e.email === "pat@example.com");
			expect(entry?.authMode).toBe("personal_access_token");
		} finally {
			manager.dispose();
		}
	});

	test("imports an agent identity credential from nested object", () => {
		const { manager, tmpHome } = createManager();
		cleanup.push(tmpHome);
		try {
			const result = manager.importCredentials([
				{
					auth_mode: "agentIdentity",
					agent_identity: {
						agent_runtime_id: "rt-agent-1",
						agent_private_key: agentPrivateKeyBase64(),
						account_id: "acc-agent-1",
						chatgpt_user_id: "user-agent-1",
						email: "agent@example.com",
					},
				},
			]);
			expect(result.added).toBe(1);
			const entry = manager.snapshot().entries.find((e) => e.email === "agent@example.com");
			expect(entry?.authMode).toBe("agent_identity");
			expect(entry?.accountId).toBe("acc-agent-1");
		} finally {
			manager.dispose();
		}
	});

	test("skips an agent identity credential with an invalid private key", () => {
		const { manager, tmpHome } = createManager();
		cleanup.push(tmpHome);
		try {
			const result = manager.importCredentials([
				{
					agent_identity: {
						agent_runtime_id: "rt-agent-2",
						agent_private_key: "not-a-real-key",
						account_id: "acc-agent-2",
					},
				},
			]);
			expect(result.added).toBe(0);
			expect(result.skipped).toBe(1);
		} finally {
			manager.dispose();
		}
	});

	test("dedupes agent identity by runtime id", () => {
		const { manager, tmpHome } = createManager();
		cleanup.push(tmpHome);
		try {
			const key = agentPrivateKeyBase64();
			const first = manager.importCredentials([
				{
					agent_identity: {
						agent_runtime_id: "rt-dup",
						agent_private_key: key,
						account_id: "acc-dup",
					},
				},
			]);
			expect(first.added).toBe(1);
			const second = manager.importCredentials([
				{
					agent_identity: {
						agent_runtime_id: "rt-dup",
						agent_private_key: key,
						account_id: "acc-dup",
					},
				},
			]);
			expect(second.duplicates).toBe(1);
		} finally {
			manager.dispose();
		}
	});

	test("snapshot never exposes the agent private key", () => {
		const { manager, tmpHome } = createManager();
		cleanup.push(tmpHome);
		try {
			manager.importCredentials([
				{
					agent_identity: {
						agent_runtime_id: "rt-secret",
						agent_private_key: agentPrivateKeyBase64(),
						account_id: "acc-secret",
					},
				},
			]);
			const serialized = JSON.stringify(manager.snapshot());
			expect(serialized).not.toContain("agentPrivateKey");
			expect(serialized).not.toContain("agent_private_key");
		} finally {
			manager.dispose();
		}
	});

	test("manualRefresh rejects PAT and agent identity credentials", async () => {
		const { manager, tmpHome } = createManager();
		cleanup.push(tmpHome);
		try {
			manager.importCredentials([{ access_token: "at-refresh-me", email: "pat2@example.com" }]);
			const patId = manager.snapshot().entries.find((e) => e.email === "pat2@example.com")?.id;
			expect(patId).toBeDefined();
			if (patId) {
				await expect(manager.manualRefresh(patId)).rejects.toThrow();
			}
		} finally {
			manager.dispose();
		}
	});
});

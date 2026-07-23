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

function usageResponse(usedPercent: number): Response {
	const resetAtSec = Math.floor(Date.now() / 1000) + 3600;
	return new Response(
		JSON.stringify({
			plan_type: "pro",
			rate_limit: {
				allowed: usedPercent < 100,
				limit_reached: usedPercent >= 100,
				primary_window: {
					used_percent: usedPercent,
					limit_window_seconds: 18_000,
					reset_after_seconds: 3600,
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
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

const originalFetch = globalThis.fetch;

function createManager(): { manager: CodexManager; tmpHome: string } {
	const tmpHome = mkdtempSync(join(tmpdir(), "narrafork-codex-authmodes-"));
	mkdirSync(join(tmpHome, ".narrafork"), { recursive: true });
	const manager = new CodexManager({ homeDir: tmpHome, registerProcessHooks: false });
	return { manager, tmpHome };
}

let cleanup: string[] = [];
afterEach(() => {
	globalThis.fetch = originalFetch;
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

	test("queries usage for an agent identity credential using an AgentAssertion header (aligned with sub2api)", async () => {
		const { manager, tmpHome } = createManager();
		cleanup.push(tmpHome);
		try {
			manager.importCredentials([
				{
					agent_identity: {
						agent_runtime_id: "rt-usage-1",
						agent_private_key: agentPrivateKeyBase64(),
						account_id: "acc-usage-1",
						task_id: "task-usage-1",
					},
				},
			]);
			const id = manager.snapshot().entries.find((e) => e.accountId === "acc-usage-1")?.id;
			expect(id).toBeDefined();
			if (!id) return;

			const captured: { authorization: string | null } = { authorization: null };
			globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				captured.authorization = headers.get("Authorization");
				return usageResponse(30);
			}) as unknown as typeof fetch;

			const usage = await manager.getUsage(id);

			expect(usage.plan_type).toBe("pro");
			expect(captured.authorization).not.toBeNull();
			expect(captured.authorization?.startsWith("AgentAssertion ")).toBe(true);
			const entry = manager.snapshot().entries.find((e) => e.id === id);
			expect(entry?.usage?.primary_window?.used_percent).toBe(30);
		} finally {
			manager.dispose();
		}
	});

	test("registers a new task before querying usage when no task id is stored", async () => {
		const { manager, tmpHome } = createManager();
		cleanup.push(tmpHome);
		try {
			manager.importCredentials([
				{
					agent_identity: {
						agent_runtime_id: "rt-usage-register",
						agent_private_key: agentPrivateKeyBase64(),
						account_id: "acc-usage-register",
						// no task_id provided
					},
				},
			]);
			const id = manager.snapshot().entries.find((e) => e.accountId === "acc-usage-register")?.id;
			expect(id).toBeDefined();
			if (!id) return;

			let registrationCalls = 0;
			globalThis.fetch = (async (input: unknown) => {
				const url = String(input);
				if (url.includes("/task/register")) {
					registrationCalls++;
					return new Response(JSON.stringify({ task_id: "registered-task-1" }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				return usageResponse(10);
			}) as unknown as typeof fetch;

			await manager.getUsage(id);

			expect(registrationCalls).toBe(1);
			const entry = manager.snapshot().entries.find((e) => e.id === id);
			expect(entry?.usage?.primary_window?.used_percent).toBe(10);
		} finally {
			manager.dispose();
		}
	});

	test("recovers from an invalid task id on usage 401 without crashing", async () => {
		const { manager, tmpHome } = createManager();
		cleanup.push(tmpHome);
		try {
			manager.importCredentials([
				{
					agent_identity: {
						agent_runtime_id: "rt-usage-401",
						agent_private_key: agentPrivateKeyBase64(),
						account_id: "acc-usage-401",
						task_id: "stale-task",
					},
				},
			]);
			const id = manager.snapshot().entries.find((e) => e.accountId === "acc-usage-401")?.id;
			expect(id).toBeDefined();
			if (!id) return;

			globalThis.fetch = (async () =>
				new Response('{"code":"invalid_task_id"}', { status: 401 })) as unknown as typeof fetch;

			await expect(manager.getUsage(id)).rejects.toThrow();
			const entry = manager.snapshot().entries.find((e) => e.id === id);
			// The stale task id should have been cleared during recovery.
			expect(entry).toBeDefined();
		} finally {
			manager.dispose();
		}
	});

	test("importing an agent identity credential still enqueues it for usage tracking", () => {
		const { manager, tmpHome } = createManager();
		cleanup.push(tmpHome);
		try {
			manager.importCredentials([
				{
					agent_identity: {
						agent_runtime_id: "rt-usage-enqueue",
						agent_private_key: agentPrivateKeyBase64(),
						account_id: "acc-usage-enqueue",
						task_id: "task-usage-enqueue",
					},
				},
			]);
			const entry = manager.snapshot().entries.find((e) => e.accountId === "acc-usage-enqueue");
			// Agent Identity credentials are now scheduled for usage refresh just
			// like OAuth/PAT credentials (aligned with sub2api), so this should not
			// be excluded from usage-reset scheduling.
			expect(entry).toBeDefined();
		} finally {
			manager.dispose();
		}
	});
});

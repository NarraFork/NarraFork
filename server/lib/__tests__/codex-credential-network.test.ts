import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CredentialNetworkError,
	maskProxyUrl,
	normalizeCredentialNetwork,
} from "@shared/credential-network";
import { createCodexRequestIdentity } from "../agent/codex-request";
import { CodexManager } from "../codex-manager";
import { codexFingerprintConfig, codexInstallationId, codexProxy } from "../codex-network";
import { getInstallationId } from "../installation-id";
import { settings } from "../settings";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function managerWith(ids: string[]) {
	const home = mkdtempSync(join(tmpdir(), "narrafork-codex-network-"));
	homes.push(home);
	mkdirSync(join(home, ".narrafork"), { recursive: true });
	const now = Date.now();
	writeFileSync(
		join(home, ".narrafork", "codex-credentials.json"),
		JSON.stringify(
			ids.map((id, priority) => ({
				id,
				refreshToken: `rt-${id}`,
				accessToken: `at-${id}`,
				expiresAt: now + 30 * 60_000,
				accountId: `acc-${id}`,
				priority,
				disabled: false,
			})),
		),
	);
	return {
		home,
		manager: new CodexManager({ homeDir: home, registerProcessHooks: false }),
		stored: () =>
			JSON.parse(readFileSync(join(home, ".narrafork", "codex-credentials.json"), "utf8")) as Array<
				Record<string, unknown>
			>,
	};
}

describe("credential network identity", () => {
	test("absent and default values mean follow; bad values name their field", () => {
		expect(normalizeCredentialNetwork({ proxy: { mode: "default" }, userAgentMode: "" })).toEqual(
			{},
		);
		const field = (input: unknown) => {
			try {
				normalizeCredentialNetwork(input);
				return "accepted";
			} catch (error) {
				return error instanceof CredentialNetworkError ? error.field : "other";
			}
		};
		expect(field({ proxy: { mode: "custom", url: "not a url" } })).toBe("proxy.url");
		expect(field({ proxy: { mode: "custom", url: "ftp://h:1" } })).toBe("proxy.url");
		expect(field({ userAgentMode: "custom" })).toBe("customUserAgent");
		expect(field({ extraHeaders: { "bad header": "x" } })).toBe("extraHeaders");
		expect(field({ deviceId: "abc" })).toBe("deviceId");
		expect(field({ proxy: { mode: "socks5" } })).toBe("proxy");
	});

	test("a proxy password never leaves the server, and an untouched mask keeps it", () => {
		expect(maskProxyUrl("http://user:secret@proxy.local:8080")).toBe(
			"http://user:***@proxy.local:8080",
		);
		const { manager, stored } = managerWith(["a"]);
		manager.updateCredential("a", {
			network: normalizeCredentialNetwork({
				proxy: { mode: "custom", url: "http://user:secret@proxy.local:8080" },
				deviceId: "11111111-2222-4333-8444-555555555555",
			}),
		});
		const entry = manager.snapshot().entries.find((e) => e.id === "a");
		expect(entry?.network?.proxy?.url).toBe("http://user:***@proxy.local:8080");
		expect(JSON.stringify(manager.snapshot())).not.toContain("secret");

		// The browser sends the masked URL back unchanged together with another edit.
		manager.updateCredential("a", {
			network: normalizeCredentialNetwork({ ...entry?.network, userAgentMode: "narrafork" }),
		});
		expect(stored()[0]?.network).toEqual({
			proxy: { mode: "custom", url: "http://user:secret@proxy.local:8080" },
			userAgentMode: "narrafork",
			deviceId: "11111111-2222-4333-8444-555555555555",
		});

		manager.updateCredential("a", { network: null });
		expect(stored()[0]?.network).toBeUndefined();
	});

	test("each credential resolves its own proxy, fingerprint and device id over Codex settings", () => {
		const saved = settings.codex;
		settings.codex = {
			...saved,
			proxy: { mode: "custom", url: "http://codex-default:1" },
			userAgentMode: "codex",
			extraHeaders: { "X-Shared": "codex", "X-Both": "codex" },
		} as typeof settings.codex;
		try {
			const own = {
				network: {
					proxy: { mode: "custom" as const, url: "http://account-a:2" },
					extraHeaders: { "X-Both": "account" },
					deviceId: "11111111-2222-4333-8444-555555555555",
				},
			};
			expect(codexProxy(own)).toBe("http://account-a:2");
			expect(codexProxy({ network: { proxy: { mode: "direct" } } })).toBeUndefined();
			expect(codexProxy({})).toBe("http://codex-default:1");
			expect(codexFingerprintConfig(own)).toEqual({
				userAgentMode: "codex",
				extraHeaders: { "X-Shared": "codex", "X-Both": "account" },
			});
			expect(codexInstallationId(own)).toBe("11111111-2222-4333-8444-555555555555");
			expect(codexInstallationId({})).toBe(getInstallationId());
			expect(
				createCodexRequestIdentity("conv", codexInstallationId(own)).clientMetadata[
					"x-codex-installation-id"
				],
			).toBe("11111111-2222-4333-8444-555555555555");
		} finally {
			settings.codex = saved;
		}
	});
});

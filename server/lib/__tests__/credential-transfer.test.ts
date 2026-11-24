import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexManager } from "../codex-manager";
import { BundleError, openBundle, sealBundle } from "../credential-transfer/bundle";

const homes: string[] = [];
afterEach(() => {
	for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function manager(entries: Array<Record<string, unknown>>) {
	const home = mkdtempSync(join(tmpdir(), "narrafork-transfer-"));
	homes.push(home);
	mkdirSync(join(home, ".narrafork"), { recursive: true });
	writeFileSync(join(home, ".narrafork", "codex-credentials.json"), JSON.stringify(entries));
	return new CodexManager({ homeDir: home, registerProcessHooks: false });
}

const account = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	displayName: `${id}@example.com`,
	refreshToken: `rt-${id}`,
	accessToken: `at-${id}`,
	expiresAt: Date.now() + 30 * 60_000,
	accountId: `acc-${id}`,
	sub: `sub-${id}`,
	priority: 0,
	disabled: false,
	...extra,
});

describe("credential bundle", () => {
	test("round-trips with the passphrase and hides the secrets", async () => {
		const text = await sealBundle(
			{ exportedAt: 1, items: [{ kind: "codex", id: "a", label: "A", data: { rt: "rt-secret" } }] },
			"a long passphrase",
		);
		expect(text).not.toContain("rt-secret");
		const opened = await openBundle(text, "a long passphrase");
		expect(opened.items).toEqual([
			{ kind: "codex", id: "a", label: "A", data: { rt: "rt-secret" } },
		]);
	});

	test("a wrong passphrase, a tampered file or a foreign file is refused", async () => {
		const text = await sealBundle({ exportedAt: 1, items: [] }, "a long passphrase");
		const code = async (run: () => Promise<unknown>) => {
			try {
				await run();
				return "opened";
			} catch (error) {
				return error instanceof BundleError ? error.code : "other";
			}
		};
		expect(await code(() => openBundle(text, "another passphrase"))).toBe("BUNDLE_PASSPHRASE");
		const tampered = JSON.parse(text);
		tampered.data = Buffer.from("x").toString("base64");
		expect(await code(() => openBundle(JSON.stringify(tampered), "a long passphrase"))).toBe(
			"BUNDLE_PASSPHRASE",
		);
		const greedy = JSON.parse(text);
		greedy.kdf.N = 2 ** 24;
		expect(await code(() => openBundle(JSON.stringify(greedy), "a long passphrase"))).toBe(
			"BUNDLE_INVALID",
		);
		expect(await code(() => openBundle("{}", "x"))).toBe("BUNDLE_INVALID");
	});
});

describe("codex credential transfer", () => {
	test("exports login and settings but not runtime state", () => {
		const source = manager([
			account("a", {
				disabled: true,
				disabledReason: "quota_exhausted",
				quotaResetsAt: Date.now() + 1000,
				network: { deviceId: "11111111-2222-4333-8444-555555555555" },
			}),
			account("b", { priority: 1, disabled: true, disabledReason: "manual" }),
		]);
		const [a, b] = source.exportForTransfer();
		expect(a?.refreshToken).toBe("rt-a");
		expect(a?.network?.deviceId).toBe("11111111-2222-4333-8444-555555555555");
		expect(a?.disabled).toBe(false);
		expect(a?.quotaResetsAt).toBeUndefined();
		expect(b?.disabledReason).toBe("manual");
		expect(source.exportForTransfer(["b"]).map((c) => c.id)).toEqual(["b"]);
	});

	test("matches by account, then adds, replaces or skips as decided", () => {
		const source = manager([account("a"), account("b", { priority: 1 })]);
		const bundle = source.exportForTransfer();
		// The target already has account b under another id, and an unrelated "a" id.
		const target = manager([
			account("b", { id: "local-b", displayName: "old label" }),
			account("other", { id: "a" }),
		]);
		const matches = target.matchForTransfer(bundle);
		expect(matches.map((m) => m?.existingId)).toEqual([undefined, "local-b"]);

		const skipped = target.importFromTransfer(bundle, (_i, existing) =>
			existing ? "skip" : "add",
		);
		expect(skipped).toEqual({ added: 1, replaced: 0, skipped: 1 });
		const ids = target.snapshot().entries.map((e) => e.id);
		expect(ids).toHaveLength(3);
		// The incoming "a" collided with an unrelated local id and got a fresh one.
		expect(ids.filter((id) => id === "a")).toHaveLength(1);

		const replaced = target.importFromTransfer(bundle, (_i, existing) =>
			existing ? "replace" : "skip",
		);
		expect(replaced.replaced).toBe(2);
		const localB = target.snapshot().entries.find((e) => e.id === "local-b");
		expect(localB?.displayName).toBe("b@example.com");
	});

	test("an unusable item is skipped, not imported", () => {
		const target = manager([]);
		expect(target.matchForTransfer([{ displayName: "no tokens" }])).toEqual([null]);
		expect(target.importFromTransfer([{ displayName: "no tokens" }], () => "add")).toEqual({
			added: 0,
			replaced: 0,
			skipped: 1,
		});
	});
});

describe("unified credential transfer", () => {
	test("NUG, singleton credentials and group secrets round-trip with fresh ids", async () => {
		const { KINDS } = await import("../credential-transfer/kinds");
		const { getProviderKeyStore } = await import("../provider-keys");
		const { saveSettings, settings } = await import("../settings");
		const kind = KINDS[0];
		if (!kind) throw new Error("credential kind missing");
		const original = structuredClone(settings);
		const store = getProviderKeyStore();
		try {
			saveSettings({
				...settings,
				customApiProviders: [],
				nugProviders: [
					{
						id: "nug-source",
						name: "NUG",
						prefix: "nug-source",
						baseUrl: "https://nug.example",
						defaultModel: "",
						apiKey: "nug-secret",
						oauthClientSecret: "oauth-secret",
					},
				],
				tokendance: {
					apiKey: "td-secret",
					disabled: false,
					generation: 1,
					models: [
						{
							id: "td-model",
							name: "TokenDance model",
							context_length: 128_000,
							supported_protocols: ["openai:responses"],
						},
					],
				},
				commandCode: { apiKey: "cc-secret", baseUrl: "https://cc.example" },
			});
			const exported = kind
				.export(undefined)
				.filter((item) => item.kind === "credential")
				.filter((item) => {
					const data = item.data as { templateId?: string };
					return ["nug", "tokendance", "command-code"].includes(data.templateId ?? "");
				});
			expect(exported).toHaveLength(4);
			for (const item of exported) {
				const data = item.data as { credential?: { id?: string }; group: Record<string, unknown> };
				expect(data.credential?.id).toBeUndefined();
				expect(data.group).not.toHaveProperty("apiKey");
				expect(data.group).not.toHaveProperty("oauthClientSecret");
			}

			saveSettings({
				...settings,
				nugProviders: [],
				tokendance: { apiKey: "", disabled: false, generation: 0 },
				commandCode: undefined,
			});
			for (const id of ["nug-source", "tokendance", "CommandCode"]) store.removeGroup(id);
			const data = exported.map((item) => item.data);
			expect(kind.match(data).every((item) => item && !item.existingId)).toBe(true);
			expect(kind.import(data, () => "add")).toEqual({ added: 4, replaced: 0, skipped: 0 });

			expect(settings.nugProviders?.[0]?.apiKey).toBe("nug-secret");
			expect(settings.nugProviders?.[0]?.oauthClientSecret).toBe("oauth-secret");
			expect(settings.tokendance?.apiKey).toBe("td-secret");
			expect(settings.tokendance?.models?.map((model) => model.id)).toEqual(["td-model"]);
			const { getTokenDanceCatalogModels } = await import("../../services/tokendance-service");
			expect(getTokenDanceCatalogModels().map((model) => model.id)).toEqual(["td-model"]);
			expect(settings.commandCode?.apiKey).toBe("cc-secret");
			expect(store.groupSecrets("nug-source")).toEqual({ oauthClientSecret: "oauth-secret" });
			const oldIds = new Set(exported.map((item) => item.id));
			for (const id of ["nug-source", "tokendance", "CommandCode"]) {
				for (const key of store.listGroup(id)) expect(oldIds.has(key.id)).toBe(false);
			}
		} finally {
			for (const id of ["nug-source", "tokendance", "CommandCode"]) store.removeGroup(id);
			saveSettings(original);
		}
	});

	test("distinct groups with the same endpoint do not collapse during one import", async () => {
		const { KINDS } = await import("../credential-transfer/kinds");
		const { getProviderKeyStore } = await import("../provider-keys");
		const { saveSettings, settings } = await import("../settings");
		const kind = KINDS[0];
		if (!kind) throw new Error("credential kind missing");
		const original = structuredClone(settings);
		const store = getProviderKeyStore();
		const provider = (id: string, apiKey: string) => ({
			id,
			name: id,
			prefix: id,
			baseUrl: "https://shared.example/v1",
			defaultModel: "",
			protocol: "completions-compatible" as const,
			apiKey,
		});
		try {
			saveSettings({
				...settings,
				customApiProviders: [provider("group-a", "key-a"), provider("group-b", "key-b")],
			});
			const exported = kind.export(undefined).filter((item) => {
				const data = item.data as { group: { id: string } };
				return ["group-a", "group-b"].includes(data.group.id);
			});
			saveSettings({ ...settings, customApiProviders: [] });
			for (const id of ["group-a", "group-b"]) store.removeGroup(id);
			expect(
				kind.import(
					exported.map((item) => item.data),
					() => "add",
				),
			).toEqual({
				added: 2,
				replaced: 0,
				skipped: 0,
			});
			expect(settings.customApiProviders?.map((group) => group.id)).toEqual(["group-a", "group-b"]);
			expect(store.firstGroupKey("group-a")).toBe("key-a");
			expect(store.firstGroupKey("group-b")).toBe("key-b");
		} finally {
			for (const id of ["group-a", "group-b"]) store.removeGroup(id);
			saveSettings(original);
		}
	});

	test("old api-key and codex bundles are normalized and imported with new credential ids", async () => {
		const { previewCredentialImport, applyCredentialImport } = await import(
			"../credential-transfer"
		);
		const { getProviderKeyStore } = await import("../provider-keys");
		const { getCodexManager } = await import("../codex-manager");
		const { saveSettings, settings } = await import("../settings");
		const original = structuredClone(settings);
		const store = getProviderKeyStore();
		const manager = getCodexManager();
		const oldCodexIds = [...manager.snapshot().entries, ...manager.snapshot().archivedEntries].map(
			(entry) => entry.id,
		);
		try {
			saveSettings({ ...settings, customApiProviders: [] });
			const legacy = await sealBundle(
				{
					exportedAt: 1,
					items: [
						{
							kind: "api-key",
							id: "legacy-key-id",
							label: "Legacy",
							data: {
								provider: {
									id: "legacy-provider",
									name: "Legacy",
									prefix: "legacy",
									baseUrl: "https://legacy.example/v1",
									defaultModel: "",
									protocol: "completions-compatible",
								},
								key: { id: "legacy-key-id", apiKey: "legacy-secret" },
							},
						},
						{
							kind: "codex",
							id: "legacy-codex-id",
							label: "legacy@example.com",
							data: account("legacy-codex", { id: "legacy-codex-id" }),
						},
					],
				},
				"a long passphrase",
			);
			const preview = await previewCredentialImport(legacy, "a long passphrase");
			expect(preview.items.map((item) => item.kind)).toEqual(["credential", "credential"]);
			expect(preview.items.every((item) => !item.unsupported)).toBe(true);
			const result = await applyCredentialImport(
				legacy,
				"a long passphrase",
				new Map([
					[0, "import"],
					[1, "import"],
				]),
				{ userId: "admin" },
			);
			expect(result).toEqual({ added: 2, replaced: 0, skipped: 0 });
			expect(settings.customApiProviders?.[0]?.id).toBe("legacy-provider");
			expect(store.listGroup("legacy-provider")[0]?.id).not.toBe("legacy-key-id");
			const importedCodex = manager
				.snapshot()
				.entries.find((entry) => entry.email === "legacy-codex@example.com");
			expect(importedCodex).toBeDefined();
			expect(importedCodex?.id).not.toBe("legacy-codex-id");
		} finally {
			store.removeGroup("legacy-provider");
			const current = manager
				.snapshot()
				.entries.filter((entry) => !oldCodexIds.includes(entry.id))
				.map((entry) => entry.id);
			if (current.length) manager.removeCredentials(current);
			saveSettings(original);
		}
	});
});

describe("api key transfer", () => {
	test("keys travel with their provider config and recreate it where it is missing", async () => {
		const { KINDS } = await import("../credential-transfer/kinds");
		const { getProviderKeyStore } = await import("../provider-keys");
		const { saveSettings, settings } = await import("../settings");
		const kind = KINDS.find((k) => k.kind === "credential");
		if (!kind) throw new Error("credential kind missing");
		const saved = structuredClone(settings.customApiProviders);
		const store = getProviderKeyStore();
		try {
			saveSettings({
				...settings,
				customApiProviders: [
					{
						id: "kimiA",
						name: "Kimi Code",
						prefix: "kimi",
						apiKey: "sk-kimi-first",
						baseUrl: "https://api.kimi.com/coding/v1",
						defaultModel: "kimi-for-coding",
						protocol: "anthropic-messages",
					},
				],
			});
			store.add("kimiA", { apiKey: "sk-kimi-second", label: "backup" });
			const exported = kind.export(undefined);
			expect(exported.map((item) => item.label)).toEqual([
				"Kimi Code · sk-k…irst",
				"Kimi Code · backup",
			]);
			expect(JSON.stringify(exported)).not.toContain('"apiKey":"sk-kimi-first","baseUrl"');

			// Same instance: both keys are already here.
			const data = exported.map((item) => item.data);
			expect(kind.match(data).map((m) => m?.existingId)).toEqual(["kimiA", expect.any(String)]);

			// "Another device": the provider does not exist yet.
			saveSettings({ ...settings, customApiProviders: [] });
			store.removeProvider("kimiA");
			expect(kind.match(data).map((m) => m?.existingId)).toEqual([undefined, undefined]);
			expect(kind.import(data, () => "add")).toEqual({ added: 2, replaced: 0, skipped: 0 });
			const recreated = settings.customApiProviders?.find((p) => p.id === "kimiA");
			expect(recreated?.baseUrl).toBe("https://api.kimi.com/coding/v1");
			expect(recreated?.apiKey).toBe("sk-kimi-first");
			expect(store.list("kimiA").map((k) => [k.apiKey, k.label])).toEqual([
				["sk-kimi-first", undefined],
				["sk-kimi-second", "backup"],
			]);
		} finally {
			saveSettings({ ...settings, customApiProviders: saved });
			store.removeProvider("kimiA");
		}
	});
});

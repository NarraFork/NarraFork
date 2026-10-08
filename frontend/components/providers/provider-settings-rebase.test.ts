import { describe, expect, test } from "bun:test";
import { rebaseProviderState } from "./provider-settings-rebase";
import {
	createSnapshot,
	initialProvidersState,
	providersStateFromSettings,
} from "./providers-reducer";

function provider(id: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		name: id,
		prefix: id,
		apiKey: "****abcd",
		baseUrl: "https://example.com",
		defaultModel: "model",
		protocol: "openai-responses",
		...extra,
	};
}

const families = ["customApiProviders", "nugProviders"] as const;

describe("provider settings three-way rebase", () => {
	for (const family of families) {
		test(`${family}: combines edits, deletions and additions by immutable ID`, () => {
			const saved = providersStateFromSettings({
				[family]: [
					provider("edited"),
					provider("deleted"),
					provider("unchanged"),
					provider("gone"),
				],
			});
			const baseline = createSnapshot(saved);
			const local = structuredClone(saved);
			local[family].splice(
				local[family].findIndex((p) => p.id === "deleted"),
				1,
			);
			local[family][0] = { ...local[family][0], prefix: "draft-prefix", name: "draft" };
			if (family === "customApiProviders") {
				local.customApiProviders.push({ ...local.customApiProviders[0], id: "local-new" });
			} else {
				local.nugProviders.push({ ...local.nugProviders[0], id: "local-new" });
			}
			const result = rebaseProviderState(local, baseline, {
				[family]: [
					provider("server-new"),
					provider("unchanged", { name: "remote" }),
					provider("deleted"),
					provider("edited", { apiKey: "****remote", baseUrl: "https://remote.com" }),
				],
			});
			expect(result[family].map((p) => p.id)).toEqual([
				"server-new",
				"unchanged",
				"edited",
				"local-new",
			]);
			expect(result[family].find((p) => p.id === "edited")).toEqual(local[family][0]);
			expect(result[family].find((p) => p.id === "unchanged")?.name).toBe("remote");
		});

		test(`${family}: remote deletion removes unchanged records but preserves edited drafts`, () => {
			const saved = providersStateFromSettings({
				[family]: [provider("clean"), provider("dirty")],
			});
			const local = structuredClone(saved);
			local[family][1].name = "draft";
			const result = rebaseProviderState(local, createSnapshot(saved), {});
			expect(result[family]).toEqual([local[family][1]]);
		});
	}

	test("normalizes new server providers and derives legacy projections from the final list", () => {
		const saved = providersStateFromSettings({
			customApiProviders: [provider("openai"), provider("remove")],
		});
		const local = structuredClone(saved);
		local.customApiProviders = [
			{ ...local.customApiProviders[0], protocol: "anthropic-messages", name: "draft" },
		];
		const result = rebaseProviderState(local, createSnapshot(saved), {
			customApiProviders: [
				provider("remove"),
				provider("openai"),
				provider("gemini", { protocol: "gemini-compatible" }),
				provider("new-openai"),
			],
			agent: { modelContextWindows: { "gemini:model": 1_000_000 } },
		});
		expect(result.customApiProviders.find((p) => p.id === "gemini")).toMatchObject({
			geminiTransport: "generate-content",
			codexAccountId: "",
			tlsRejectUnauthorized: true,
		});
		expect(result.openaiProviders.map((p) => p.id)).toEqual(["new-openai"]);
		expect(result.anthropicProviders.map((p) => p.id)).toEqual(["openai"]);
		expect(result.anthropicProviders[0].name).toBe("draft");
		expect(result.modelContextWindows).toEqual({ "gemini:model": 1_000_000 });
	});

	test("context windows merge per key, including local and remote removals", () => {
		const saved = providersStateFromSettings({
			agent: { modelContextWindows: { edited: 10, deleted: 20, updated: 30, gone: 40 } },
		});
		const local = structuredClone(saved);
		local.modelContextWindows = { edited: 11, updated: 30, gone: 40, added: 50 };
		const result = rebaseProviderState(local, createSnapshot(saved), {
			agent: {
				modelContextWindows: { edited: 99, deleted: 99, updated: 31, added: 99, fresh: 60 },
			},
		});
		expect(result.modelContextWindows).toEqual({ edited: 11, updated: 31, added: 50, fresh: 60 });
	});

	test("unchanged collections adopt external updates, regardless of set insertion order", () => {
		const saved = providersStateFromSettings({
			agent: { hiddenModels: ["a:m", "b:m"], disabledProviders: ["a", "b"] },
		});
		const local = structuredClone(saved);
		local.hiddenModels = new Set(["b:m", "a:m"]);
		local.disabledProviders = new Set(["b", "a"]);
		const fresh = {
			agent: {
				hiddenModels: ["c:m"],
				disabledProviders: ["c"],
				customModels: [{ value: "c:m", label: "remote" }],
				providerOrder: ["c"],
			},
		};
		const result = rebaseProviderState(local, createSnapshot(saved), fresh);
		expect(result).toEqual(providersStateFromSettings(fresh));
	});

	test("dirty collections remain whole local values", () => {
		const saved = providersStateFromSettings({});
		const local = structuredClone(saved);
		local.hiddenModels.add("local:m");
		local.disabledProviders.add("local");
		local.customModels.push({ value: "local:m", label: "draft" });
		local.providerOrder.push("local");
		const result = rebaseProviderState(local, createSnapshot(saved), {
			agent: {
				hiddenModels: ["remote:m"],
				disabledProviders: ["remote"],
				customModels: [{ value: "remote:m", label: "remote" }],
				providerOrder: ["remote"],
			},
		});
		expect(result.hiddenModels).toEqual(local.hiddenModels);
		expect(result.disabledProviders).toEqual(local.disabledProviders);
		expect(result.customModels).toEqual(local.customModels);
		expect(result.providerOrder).toEqual(local.providerOrder);
	});

	test("unchanged masked keys and reordered object keys do not mask server updates", () => {
		const saved = providersStateFromSettings({
			customApiProviders: [provider("key", { extraHeaders: { a: "1", b: "2" } })],
		});
		const baseline = JSON.parse(JSON.stringify(createSnapshot(saved)));
		const local = structuredClone(saved);
		local.customApiProviders[0].extraHeaders = { b: "2", a: "1" };
		const result = rebaseProviderState(local, baseline, {
			customApiProviders: [provider("key", { apiKey: "****wxyz", name: "updated" })],
		});
		expect(result.customApiProviders[0]).toMatchObject({ apiKey: "****wxyz", name: "updated" });
	});

	test("does not mutate or share mutable output with any input", () => {
		const settings = {
			customApiProviders: [provider("clean", { extraHeaders: { token: "clean" } })],
			agent: { modelContextWindows: { "clean:m": 100 }, providerOrder: ["clean"] },
		};
		const local = providersStateFromSettings(settings);
		const baseline = createSnapshot(local);
		local.customApiProviders[0].name = "draft";
		local.hiddenModels.add("clean:m");
		const before = structuredClone({ local, baseline, settings });
		const result = rebaseProviderState(local, baseline, settings);
		expect({ local, baseline, settings }).toEqual(before);
		const headers = result.customApiProviders[0].extraHeaders;
		const projectedHeaders = result.openaiProviders[0].extraHeaders;
		if (!headers || !projectedHeaders) throw new Error("Missing rebased headers");
		headers.token = "changed";
		projectedHeaders.token = "projection";
		result.hiddenModels.clear();
		result.disabledProviders.add("changed");
		result.modelContextWindows["clean:m"] = 200;
		result.providerOrder.push("changed");
		expect({ local, baseline, settings }).toEqual(before);
	});

	test("initializes even an empty fresh response", () => {
		const result = rebaseProviderState(
			initialProvidersState,
			createSnapshot(initialProvidersState),
			{},
		);
		expect(result.initialized).toBe(true);
	});
});

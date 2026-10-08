import { describe, expect, test } from "bun:test";
import { type AddProviderDraft, customProviderFromDraft } from "./provider-add-draft";
import { createProviderAndRefresh, type ProviderCreateDependencies } from "./provider-create-flow";
import type { AddProviderType } from "./provider-presets";
import { providersStateFromSettings } from "./providers-reducer";

const draft: AddProviderDraft = {
	protocol: "openai-responses",
	name: " New Provider ",
	baseUrl: " https://api.example.com/v1 ",
	apiKey: " sk-real-key ",
	prefix: "",
	userAgentMode: "codex",
};

function provider(id: string, prefix = id) {
	return customProviderFromDraft(id, { ...draft, protocol: "openai-responses", prefix });
}

function fixture(initial: Record<string, unknown> = {}) {
	let persisted = structuredClone(initial);
	const events: string[] = [];
	const payloads: Record<string, unknown>[] = [];
	const refreshes: Array<{ id: string; protocol: AddProviderType }> = [];
	const deps: ProviderCreateDependencies = {
		async getSettings() {
			events.push("get");
			return structuredClone(persisted);
		},
		async updateSettings(payload) {
			events.push("save");
			payloads.push(structuredClone(payload));
			persisted = { ...persisted, ...structuredClone(payload) };
			return structuredClone(persisted);
		},
		async refreshModels(id, protocol) {
			events.push("refresh");
			refreshes.push({ id, protocol });
			persisted = { ...persisted, refreshed: true };
		},
		onSaved(settings) {
			events.push("saved");
			expect(providersStateFromSettings(settings).initialized).toBe(true);
		},
		onRefreshed(settings) {
			events.push("refreshed");
			expect(settings.refreshed).toBe(true);
		},
		messages: {
			invalidDraft: "Invalid draft",
			prefixConflict: (prefix) => `Prefix conflict: ${prefix}`,
			unconfirmedSave: "Unconfirmed save",
		},
	};
	return { deps, events, payloads, refreshes };
}

const emptyLocal = () => providersStateFromSettings({});

function savedRecords(payload: Record<string, unknown>, field = "customApiProviders") {
	return payload[field] as Record<string, unknown>[];
}

describe("createProviderAndRefresh", () => {
	for (const protocol of [
		"openai-responses",
		"completions-compatible",
		"anthropic-messages",
		"gemini-compatible",
		"nug",
	] as const) {
		test(`${protocol}: confirms save before refreshing the new stable ID`, async () => {
			const f = fixture();
			const result = await createProviderAndRefresh(
				"stable-id",
				{ ...draft, protocol },
				emptyLocal(),
				f.deps,
			);
			expect(result).toEqual({ providerId: "stable-id" });
			expect(f.events).toEqual(["get", "save", "saved", "refresh", "get", "refreshed"]);
			expect(f.refreshes).toEqual([{ id: "stable-id", protocol }]);
			const field = protocol === "nug" ? "nugProviders" : "customApiProviders";
			expect(Object.keys(f.payloads[0])).toEqual([field]);
			const record = savedRecords(f.payloads[0], field)[0];
			expect(record).toMatchObject({
				id: "stable-id",
				name: "New Provider",
				apiKey: "sk-real-key",
				baseUrl: "https://api.example.com/v1",
				prefix: "example",
			});
			if (protocol !== "nug") expect(record.userAgentMode).toBe("codex");
			if (protocol === "gemini-compatible") {
				expect(record.geminiTransport).toBe("generate-content");
			}
		});
	}

	test.each([
		["https://api.example.com", "Ignored Name", "example"],
		["http://localhost:7779", "My Local: Gateway!", "my-local-gateway"],
		["http://127.0.0.1:8000", "本地服务", "provider"],
		["http://[::1]:8000", "!!!", "provider"],
		["https://api.codex.com", "Ignored", "codex-2"],
	])("auto prefix for %s / %s", async (baseUrl, name, prefix) => {
		const f = fixture();
		await createProviderAndRefresh("new", { ...draft, baseUrl, name }, emptyLocal(), f.deps);
		expect(savedRecords(f.payloads[0])[0].prefix).toBe(prefix);
	});

	test("auto prefix checks latest server and dirty local custom/NUG records", async () => {
		const f = fixture({ customApiProviders: [provider("server", "example")] });
		const local = providersStateFromSettings({
			customApiProviders: [provider("local", "example-2")],
			nugProviders: [{ id: "local-nug", prefix: "example-3" }],
		});
		await createProviderAndRefresh("new", draft, local, f.deps);
		expect(savedRecords(f.payloads[0])[1].prefix).toBe("example-4");
	});

	for (const source of ["server-custom", "server-nug", "local-custom", "local-nug", "codex"]) {
		test(`rejects explicitly conflicting prefix from ${source}`, async () => {
			const settings = source.startsWith("server")
				? {
						[source === "server-nug" ? "nugProviders" : "customApiProviders"]: [
							provider("other", "taken"),
						],
					}
				: {};
			const local = source.startsWith("local")
				? providersStateFromSettings({
						[source === "local-nug" ? "nugProviders" : "customApiProviders"]: [
							provider("other", "taken"),
						],
					})
				: emptyLocal();
			const prefix = source === "codex" ? "codex" : "taken";
			const f = fixture(settings);
			await expect(
				createProviderAndRefresh("new", { ...draft, prefix }, local, f.deps),
			).rejects.toThrow(`Prefix conflict: ${prefix}`);
			expect(f.events).toEqual(["get"]);
		});
	}

	test("scoped PATCH retains raw other fields and masked secrets, not dirty local state", async () => {
		const other = {
			...provider("other"),
			apiKey: "********",
			extraHeaders: { Authorization: "********" },
			futureField: { enabled: true },
		};
		const f = fixture({
			customApiProviders: [other],
			nugProviders: [],
			agent: { hiddenModels: [] },
		});
		const local = providersStateFromSettings({
			customApiProviders: [
				{ ...other, name: "dirty", apiKey: "unsaved-secret" },
				provider("unsaved"),
			],
			nugProviders: [{ id: "dirty-nug", prefix: "dirty-nug" }],
			agent: { hiddenModels: ["dirty:model"] },
		});
		await createProviderAndRefresh("new", draft, local, f.deps);
		expect(Object.keys(f.payloads[0])).toEqual(["customApiProviders"]);
		expect(savedRecords(f.payloads[0])).toHaveLength(2);
		expect(savedRecords(f.payloads[0])[0]).toEqual(other);
	});

	test("NUG scoped PATCH preserves other NUG credential and extra fields", async () => {
		const other = {
			id: "other",
			prefix: "other",
			apiKey: "********",
			oauthClientSecret: "********",
			futureField: 4,
		};
		const f = fixture({ nugProviders: [other], customApiProviders: [provider("custom")] });
		await createProviderAndRefresh("new", { ...draft, protocol: "nug" }, emptyLocal(), f.deps);
		expect(Object.keys(f.payloads[0])).toEqual(["nugProviders"]);
		expect(savedRecords(f.payloads[0], "nugProviders")[0]).toEqual(other);
	});

	test("legacy records migrate through the reducer before scoped save", async () => {
		const f = fixture({
			openaiProviders: [
				{ ...provider("legacy"), apiMode: "completions", apiKey: "********", futureField: 7 },
			],
		});
		await createProviderAndRefresh("new", draft, emptyLocal(), f.deps);
		expect(savedRecords(f.payloads[0])[0]).toMatchObject({
			id: "legacy",
			protocol: "completions-compatible",
			apiKey: "********",
			futureField: 7,
		});
		expect(Object.keys(f.payloads[0])).toEqual(["customApiProviders"]);
	});

	test.each([
		"ftp://example.com",
		"not a URL",
		"https://user:pass@example.com",
	])("invalid HTTP draft %s makes no requests", async (baseUrl) => {
		const f = fixture();
		await expect(
			createProviderAndRefresh("new", { ...draft, baseUrl }, emptyLocal(), f.deps),
		).rejects.toThrow("Invalid draft");
		expect(f.events).toEqual([]);
	});

	test("save failure never calls onSaved or refresh", async () => {
		const f = fixture();
		const failure = new Error("save failed");
		f.deps.updateSettings = async () => {
			throw failure;
		};
		await expect(createProviderAndRefresh("new", draft, emptyLocal(), f.deps)).rejects.toBe(
			failure,
		);
		expect(f.events).toEqual(["get"]);
	});

	for (const stage of ["refresh", "get", "onRefreshed"] as const) {
		test(`${stage} failure after save returns partial success`, async () => {
			const f = fixture();
			const failure = new Error(`${stage} failed`);
			if (stage === "refresh")
				f.deps.refreshModels = async () => {
					throw failure;
				};
			if (stage === "get") {
				const get = f.deps.getSettings;
				let calls = 0;
				f.deps.getSettings = async () => {
					if (calls++) throw failure;
					return get();
				};
			}
			if (stage === "onRefreshed")
				f.deps.onRefreshed = () => {
					throw failure;
				};
			expect(await createProviderAndRefresh("new", draft, emptyLocal(), f.deps)).toEqual({
				providerId: "new",
				refreshError: failure,
			});
			expect(f.events).toContain("saved");
			expect(f.payloads).toHaveLength(1);
		});
	}

	test.each([
		"openai-responses",
		"nug",
	] as const)("retry %s upserts same ID and honors changed or explicitly cleared API key", async (protocol) => {
		const f = fixture();
		await createProviderAndRefresh(
			"new",
			{ ...draft, protocol, prefix: "same" },
			emptyLocal(),
			f.deps,
		);
		await createProviderAndRefresh(
			"new",
			{ ...draft, protocol, prefix: "same", apiKey: " " },
			emptyLocal(),
			f.deps,
		);
		const field = protocol === "nug" ? "nugProviders" : "customApiProviders";
		expect(savedRecords(f.payloads[1], field)).toHaveLength(1);
		expect(savedRecords(f.payloads[1], field)[0].apiKey).toBe("");
		await createProviderAndRefresh(
			"new",
			{ ...draft, protocol, prefix: "same", apiKey: " sk-replaced " },
			emptyLocal(),
			f.deps,
		);
		expect(savedRecords(f.payloads[2], field)).toHaveLength(1);
		expect(savedRecords(f.payloads[2], field)[0].apiKey).toBe("sk-replaced");
		expect(f.refreshes).toHaveLength(3);
	});

	test("lost save response can be retried without duplicate records", async () => {
		const f = fixture();
		const save = f.deps.updateSettings;
		f.deps.updateSettings = async (payload) => {
			await save(payload);
			throw new Error("response lost");
		};
		await expect(createProviderAndRefresh("new", draft, emptyLocal(), f.deps)).rejects.toThrow(
			"response lost",
		);
		expect(f.refreshes).toHaveLength(0);
		f.deps.updateSettings = save;
		await createProviderAndRefresh("new", draft, emptyLocal(), f.deps);
		expect(savedRecords(f.payloads[1])).toHaveLength(1);
	});

	for (const [initialProtocol, retryProtocol] of [
		["openai-responses", "nug"],
		["nug", "anthropic-messages"],
	] as const) {
		test(`lost response retry ${initialProtocol} -> ${retryProtocol} atomically moves only the stable ID`, async () => {
			const customOther = {
				...provider("custom-other"),
				apiKey: "********",
				futureField: { enabled: true },
			};
			const nugOther = {
				id: "nug-other",
				prefix: "nug-other",
				apiKey: "********",
				oauthClientSecret: "********",
				futureField: 9,
			};
			const initial = { customApiProviders: [customOther], nugProviders: [nugOther] };
			const before = structuredClone(initial);
			const f = fixture(initial);
			const save = f.deps.updateSettings;
			let savedBeforeLostResponse: Record<string, unknown> = {};
			f.deps.updateSettings = async (payload) => {
				savedBeforeLostResponse = await save(payload);
				throw new Error("response lost");
			};
			await expect(
				createProviderAndRefresh(
					"intent-id",
					{ ...draft, protocol: initialProtocol, prefix: "same" },
					emptyLocal(),
					f.deps,
				),
			).rejects.toThrow("response lost");
			expect(Object.keys(f.payloads[0])).toEqual([
				initialProtocol === "nug" ? "nugProviders" : "customApiProviders",
			]);
			expect(f.refreshes).toHaveLength(0);
			f.deps.updateSettings = save;
			expect(
				await createProviderAndRefresh(
					"intent-id",
					{ ...draft, protocol: retryProtocol, prefix: "same", apiKey: "replacement-key" },
					providersStateFromSettings(savedBeforeLostResponse),
					f.deps,
				),
			).toEqual({ providerId: "intent-id" });
			expect(Object.keys(f.payloads[1]).sort()).toEqual(["customApiProviders", "nugProviders"]);
			const custom = savedRecords(f.payloads[1]);
			const nug = savedRecords(f.payloads[1], "nugProviders");
			expect(custom.find((record) => record.id === "custom-other")).toEqual(customOther);
			expect(nug.find((record) => record.id === "nug-other")).toEqual(nugOther);
			expect([...custom, ...nug].filter((record) => record.id === "intent-id")).toHaveLength(1);
			expect([...custom, ...nug].filter((record) => record.prefix === "same")).toHaveLength(1);
			const target = retryProtocol === "nug" ? nug : custom;
			expect(target.find((record) => record.id === "intent-id")).toMatchObject({
				prefix: "same",
				apiKey: "replacement-key",
			});
			expect(f.refreshes).toEqual([{ id: "intent-id", protocol: retryProtocol }]);
			expect(initial).toEqual(before);
		});
	}

	test("uses actual normalized protocol returned by server", async () => {
		const f = fixture();
		const save = f.deps.updateSettings;
		f.deps.updateSettings = (payload) =>
			save({
				customApiProviders: savedRecords(payload).map((record) => ({
					...record,
					protocol: "anthropic-messages",
				})),
			});
		await createProviderAndRefresh("new", draft, emptyLocal(), f.deps);
		expect(f.refreshes).toEqual([{ id: "new", protocol: "anthropic-messages" }]);
	});

	test("missing ID in response triggers GET verification before onSaved/refresh", async () => {
		const f = fixture();
		const save = f.deps.updateSettings;
		f.deps.updateSettings = async (payload) => {
			await save(payload);
			return {};
		};
		await createProviderAndRefresh("new", draft, emptyLocal(), f.deps);
		expect(f.events).toEqual(["get", "save", "get", "saved", "refresh", "get", "refreshed"]);
	});

	test("unconfirmed save throws without onSaved or refresh", async () => {
		const f = fixture();
		f.deps.updateSettings = async () => ({});
		await expect(createProviderAndRefresh("new", draft, emptyLocal(), f.deps)).rejects.toThrow(
			"Unconfirmed save",
		);
		expect(f.events).toEqual(["get", "get"]);
	});

	test("concurrent saves read the preceding committed array without waiting for refresh", async () => {
		const f = fixture();
		const refresh = f.deps.refreshModels;
		let releaseRefresh: () => void = () => {};
		const blockedRefresh = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		f.deps.refreshModels = async (id, protocol) => {
			if (id === "first") await blockedRefresh;
			return refresh(id, protocol);
		};
		const first = createProviderAndRefresh(
			"first",
			{ ...draft, prefix: "first" },
			emptyLocal(),
			f.deps,
		);
		const second = createProviderAndRefresh(
			"second",
			{ ...draft, prefix: "second" },
			emptyLocal(),
			f.deps,
		);
		try {
			expect(await second).toEqual({ providerId: "second" });
			expect(savedRecords(f.payloads[1]).map((record) => record.id)).toEqual(["first", "second"]);
		} finally {
			releaseRefresh();
			await first;
		}
	});

	test("a failed save does not poison the next queued creation", async () => {
		const f = fixture();
		const save = f.deps.updateSettings;
		let calls = 0;
		f.deps.updateSettings = async (payload) => {
			if (!calls++) throw new Error("first failed");
			return save(payload);
		};
		const first = createProviderAndRefresh("first", draft, emptyLocal(), f.deps);
		const second = createProviderAndRefresh("second", draft, emptyLocal(), f.deps);
		await expect(first).rejects.toThrow("first failed");
		expect(await second).toEqual({ providerId: "second" });
		expect(f.refreshes).toEqual([{ id: "second", protocol: "openai-responses" }]);
	});

	test("does not mutate server settings, local reducer state or draft", async () => {
		const latest = { customApiProviders: [provider("other")], agent: { hiddenModels: [] } };
		const local = providersStateFromSettings(latest);
		const input = { ...draft };
		const before = structuredClone({ latest, local, input });
		const f = fixture();
		f.deps.getSettings = async () => latest;
		await createProviderAndRefresh("new", input, local, f.deps);
		expect({ latest, local, input }).toEqual(before);
	});
});

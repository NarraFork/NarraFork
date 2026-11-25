import { afterEach, describe, expect, test } from "bun:test";
import { setNugCachedModels } from "../../nug-model-cache";
import {
	COMMAND_CODE_KEY_OWNER,
	getProviderKeyStore,
	nugKeyOwner,
	TOKENDANCE_KEY_OWNER,
} from "../../provider-keys";
import {
	listAutoModelCandidates,
	registerAutoSourceProbe,
	resolveEffectiveModel,
	settings,
} from "../../settings";
import { autoSourceFacts } from "../auto-route-signals";
import { reportKeyFault, resetProviderKeyRuntimeForTests } from "../pooled-provider";
import { ApiError } from "../types";

// Live facts the auto: router orders sources by. Runs under tests/preload.ts's temp home.

const saved = structuredClone(settings.customApiProviders);
const savedNug = structuredClone(settings.nugProviders);
const savedTokenDance = structuredClone(settings.tokendance);
const savedCommandCode = structuredClone(settings.commandCode);
const savedAgent = structuredClone(settings.agent);
const provider = (id: string, prefix: string, baseUrl: string) => ({
	id,
	name: prefix,
	prefix,
	apiKey: "",
	baseUrl,
	defaultModel: "m",
	protocol: "completions-compatible" as const,
});

afterEach(() => {
	settings.customApiProviders = saved;
	settings.nugProviders = savedNug;
	settings.tokendance = savedTokenDance;
	settings.commandCode = savedCommandCode;
	Object.assign(settings.agent, savedAgent);
	registerAutoSourceProbe(null);
	setNugCachedModels("sigNug", []);
	for (const id of [
		"sigRelay",
		"sigKimi",
		nugKeyOwner("sigNug"),
		TOKENDANCE_KEY_OWNER,
		COMMAND_CODE_KEY_OWNER,
	])
		getProviderKeyStore().removeProvider(id);
	resetProviderKeyRuntimeForTests();
});

describe("auto route signals", () => {
	test("unknown prefixes are available pay-per-use", () => {
		expect(autoSourceFacts("not-configured")).toEqual({ available: true, subscription: false });
	});

	test("a Kimi Code plan is a subscription; a relay is not", () => {
		settings.customApiProviders = [
			provider("sigRelay", "sigrelay", "https://relay.example/v1"),
			provider("sigKimi", "sigkimi", "https://api.kimi.com/coding/v1"),
		];
		getProviderKeyStore().add("sigRelay", { apiKey: "sk-relay" });
		getProviderKeyStore().add("sigKimi", { apiKey: "sk-kimi" });
		expect(autoSourceFacts("sigkimi")).toEqual({ available: true, subscription: true });
		expect(autoSourceFacts("sigrelay")).toEqual({ available: true, subscription: false });
	});

	test("a short 429 rest does not count; a used-up allowance or a 403 does, until it ends", () => {
		settings.customApiProviders = [provider("sigRelay", "sigrelay", "https://relay.example/v1")];
		const [first, second] = [
			getProviderKeyStore().add("sigRelay", { apiKey: "sk-1" }),
			getProviderKeyStore().add("sigRelay", { apiKey: "sk-2" }),
		];
		const now = Date.now();
		// Every key rate limited: still able to serve, so an auto: session keeps its service.
		reportKeyFault(first, new ApiError(429, "Too many requests"), now);
		reportKeyFault(second, new ApiError(429, "Too many requests"), now);
		expect(autoSourceFacts("sigrelay", now).available).toBe(true);
		// Allowance used up (402) and forbidden (403): cannot serve until the rests end.
		reportKeyFault(first, new ApiError(402, "Payment required"), now);
		reportKeyFault(second, new ApiError(403, "Forbidden"), now);
		expect(autoSourceFacts("sigrelay", now).available).toBe(false);
		expect(autoSourceFacts("sigrelay", now + 11 * 60_000).available).toBe(true);
	});

	for (const [prefix, owner] of [
		["tokendance", TOKENDANCE_KEY_OWNER],
		["CommandCode", COMMAND_CODE_KEY_OWNER],
		["signug", nugKeyOwner("sigNug")],
	] as const) {
		test(`${prefix} Auto pool facts reject disabled/exhausted keys; NUG also switches the real sticky route`, () => {
			settings.customApiProviders = [provider("sigRelay", "sigrelay", "https://relay.example/v1")];
			settings.tokendance = { apiKey: "", generation: 1, disabled: false };
			settings.commandCode = { apiKey: "", disabled: false };
			settings.nugProviders = [
				{
					id: "sigNug",
					name: "NUG",
					prefix: "signug",
					apiKey: "",
					baseUrl: "https://nug.example",
					defaultModel: "claude-opus-4-6",
				},
			];
			settings.agent.hiddenModels = [];
			settings.agent.disabledProviders = [];
			settings.agent.autoExcludedProviders = [];
			settings.agent.customModels = [prefix, "sigrelay"].map((provider) => ({
				value: `${provider}:claude-opus-4-6`,
				label: provider,
				provider,
			}));
			const store = getProviderKeyStore();
			store.add("sigRelay", { apiKey: "available-alternative" });
			const first = store.add(owner, { apiKey: "projected-first-key" });
			const second = store.add(owner, { apiKey: "managed-backup" });
			// Keep the real catalog/resolver path, excluding unrelated default-cache sources.
			settings.agent.autoExcludedProviders = listAutoModelCandidates("claude-opus-4-6")
				.map((value) => value.slice(0, value.indexOf(":")))
				.filter((candidate) => candidate !== prefix && candidate !== "sigrelay");
			const now = Date.now();
			registerAutoSourceProbe((provider, value) => autoSourceFacts(provider, now, value));
			const expectAvailability = (available: boolean) => {
				expect(autoSourceFacts(prefix, now).available).toBe(available);
				// Builtin TD/CC catalog-prefix matching is separate from this managed-pool guard.
				if (prefix === "signug")
					expect(resolveEffectiveModel("auto:claude-opus-4-6", prefix)).toBe(
						available ? `${prefix}:claude-opus-4-6` : "sigrelay:claude-opus-4-6",
					);
			};
			expectAvailability(true);
			store.update(first.id, { disabled: true });
			store.update(second.id, { disabled: true });
			expectAvailability(false);
			store.update(second.id, { disabled: false });
			reportKeyFault(second, new ApiError(402, "allowance exhausted"), now);
			expectAvailability(false);
			reportKeyFault(second, new ApiError(429, "retry-after: 7"), now);
			expectAvailability(true);
			if (prefix === "CommandCode") {
				store.removeProvider(owner);
				settings.commandCode.apiKey = "";
				expect(autoSourceFacts(prefix, now).available).toBe(true);
			}
		});
	}

	test("a NUG model recorded as down cannot serve; its other channels still can", () => {
		settings.nugProviders = [
			{
				id: "sigNug",
				name: "sig nug",
				prefix: "signug",
				apiKey: "nug-key",
				baseUrl: "http://nug.example",
				defaultModel: "kiro:claude-opus-4.6",
			},
		];
		setNugCachedModels("sigNug", [
			{ id: "kiro:claude-opus-4.6", available: false },
			{ id: "antigravity:claude-opus-4.6", available: true },
		]);
		expect(autoSourceFacts("signug", Date.now(), "signug:kiro:claude-opus-4.6").available).toBe(
			false,
		);
		expect(
			autoSourceFacts("signug", Date.now(), "signug:antigravity:claude-opus-4.6").available,
		).toBe(true);
		// Without the model value nothing is known, so the gateway counts as able.
		expect(autoSourceFacts("signug").available).toBe(true);
	});

	test("a key the upstream rejected (401) leaves the pool", () => {
		settings.customApiProviders = [provider("sigRelay", "sigrelay", "https://relay.example/v1")];
		const only = getProviderKeyStore().add("sigRelay", { apiKey: "sk-only" });
		reportKeyFault(only, new ApiError(401, "Unauthorized"));
		expect(autoSourceFacts("sigrelay").available).toBe(false);
	});
});

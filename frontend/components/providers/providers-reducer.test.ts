import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
	type CommandCodeState,
	createSnapshot,
	initialProvidersState,
	isPlatformProviderPrefix,
	type ProvidersState,
	providersReducer,
	providersStateFromSettings,
	type SavedSnapshot,
	useIsDirty,
} from "./providers-reducer";

/** 用真实的 useIsDirty 判定脏标记（服务端渲染会执行 hooks，无需 DOM）。 */
function dirtyLabel(state: ProvidersState, snapshot: SavedSnapshot): string {
	const Probe = () => createElement("i", null, String(useIsDirty(state, snapshot)));
	return renderToStaticMarkup(createElement(Probe));
}

const provider = {
	id: "provider-id",
	name: "Gemini",
	prefix: "gemini-old",
	apiKey: "****abcd",
	baseUrl: "https://example.com/v1beta",
	defaultModel: "gemini-test",
	protocol: "gemini-compatible" as const,
	codexAccountId: "",
};

describe("providers reducer server synchronization", () => {
	test("SYNC_FROM_SETTINGS replaces local state with the server-final normalized response", () => {
		const local = providersStateFromSettings({
			customApiProviders: [provider],
			agent: {},
		});
		const serverResponse = {
			customApiProviders: [{ ...provider, prefix: "gemini-new", apiKey: "****wxyz" }],
			agent: {
				providerOrder: ["gemini-new"],
				disabledProviders: [],
			},
		};

		const synced = providersReducer(local, {
			type: "SYNC_FROM_SETTINGS",
			settings: serverResponse,
		});
		expect(synced.customApiProviders[0]?.prefix).toBe("gemini-new");
		expect(synced.customApiProviders[0]?.apiKey).toBe("****wxyz");
		expect(synced.providerOrder).toEqual(["gemini-new"]);
	});

	test("normalizes missing Gemini transport and preserves explicit legacy split transport", () => {
		const unified = providersStateFromSettings({ customApiProviders: [provider], agent: {} });
		expect(unified.customApiProviders[0]?.geminiTransport).toBe("generate-content");

		const legacy = providersStateFromSettings({
			geminiProviders: [{ ...provider, protocol: undefined, geminiTransport: "interactions" }],
			agent: {},
		});
		expect(legacy.customApiProviders[0]).toMatchObject({
			protocol: "gemini-compatible",
			geminiTransport: "interactions",
		});
	});

	test("provider disable toggles keep detail state and overview state aligned", () => {
		const initialized = providersStateFromSettings({ customApiProviders: [provider], agent: {} });
		const disabled = providersReducer(initialized, {
			type: "TOGGLE_PROVIDER_DISABLED",
			prefix: "gemini-old",
		});
		expect(disabled.customApiProviders[0]?.disabled).toBe(true);
		expect(disabled.disabledProviders.has("gemini-old")).toBe(true);

		const enabled = providersReducer(disabled, {
			type: "TOGGLE_PROVIDER_DISABLED",
			prefix: "gemini-old",
		});
		expect(enabled.customApiProviders[0]?.disabled).toBe(false);
		expect(enabled.disabledProviders.has("gemini-old")).toBe(false);
	});

	test("ignores empty-prefix global toggles so unsaved providers stay local", () => {
		const initialized = providersStateFromSettings({
			customApiProviders: [{ ...provider, prefix: "" }],
			agent: {},
		});
		const next = providersReducer(initialized, {
			type: "TOGGLE_PROVIDER_DISABLED",
			prefix: "",
		});
		expect(next).toBe(initialized);
		expect(next.disabledProviders.has("")).toBe(false);
	});

	test("empty settings still produce an initialized state", () => {
		const state = providersReducer(initialProvidersState, {
			type: "SYNC_FROM_SETTINGS",
			settings: {},
		});
		expect(state.initialized).toBe(true);
	});
});

/**
 * Command Code 的 API key 是受控草稿，由页面底部的全局保存条统一提交。这里锁住三件
 * 失败得很安静的事：settings 的脱敏值必须回填（否则保存会把空串写回服务端）、快照必须
 * 携带草稿（否则改了 key 保存条也不出现）、保存后回灌必须重新变干净（否则保存条不消失）。
 */
describe("Command Code 草稿", () => {
	const MASKED_KEY = "********abcd";
	const REAL_KEY = "user_demo0000000000000000";

	/** 只提供 reducer 关心的字段；settings 的其余部分与草稿无关。 */
	function settingsWithCommandCode(commandCode: Partial<CommandCodeState> = {}) {
		return {
			customApiProviders: [],
			openaiProviders: [],
			anthropicProviders: [],
			nugProviders: [],
			commandCode,
			agent: {},
		};
	}

	test("从 settings 回填脱敏 apiKey 与停用标记，缺失时取默认值", () => {
		const state = providersStateFromSettings(
			settingsWithCommandCode({ apiKey: MASKED_KEY, disabled: true }),
		);
		expect(state.commandCode).toEqual({ apiKey: MASKED_KEY, disabled: true });

		const empty = providersStateFromSettings(settingsWithCommandCode());
		expect(empty.commandCode).toEqual({ apiKey: "", disabled: false });
	});

	test("SET_COMMAND_CODE 只替换草稿", () => {
		const base = providersStateFromSettings(settingsWithCommandCode({ apiKey: MASKED_KEY }));
		const next = providersReducer(base, {
			type: "SET_COMMAND_CODE",
			config: { ...base.commandCode, apiKey: REAL_KEY },
		});
		expect(next.commandCode.apiKey).toBe(REAL_KEY);
		expect(next.hiddenModels).toBe(base.hiddenModels);
		expect(next.initialized).toBe(true);
	});

	test("改 key 或停用都让状态变脏，放弃更改后回到干净", () => {
		const saved = providersStateFromSettings(settingsWithCommandCode({ apiKey: MASKED_KEY }));
		const snapshot = createSnapshot(saved);
		expect(dirtyLabel(saved, snapshot)).toBe("<i>false</i>");

		const edited = providersReducer(saved, {
			type: "SET_COMMAND_CODE",
			config: { ...saved.commandCode, apiKey: REAL_KEY },
		});
		expect(dirtyLabel(edited, snapshot)).toBe("<i>true</i>");

		// 停用开关也必须进草稿：它决定后端是否把该 provider 从可用候选里剔除。
		const paused = providersReducer(saved, {
			type: "SET_COMMAND_CODE",
			config: { ...saved.commandCode, disabled: true },
		});
		expect(paused.commandCode.disabled).toBe(true);
		expect(dirtyLabel(paused, snapshot)).toBe("<i>true</i>");

		const discarded = providersReducer(paused, { type: "RESTORE_FROM_SNAPSHOT", snapshot });
		expect(discarded.commandCode).toEqual({ apiKey: MASKED_KEY, disabled: false });
		expect(dirtyLabel(discarded, snapshot)).toBe("<i>false</i>");
	});

	test("保存成功回灌后重新变干净", () => {
		const draft = providersReducer(initialProvidersState, {
			type: "SET_COMMAND_CODE",
			config: { apiKey: REAL_KEY, disabled: false },
		});
		const baseline = createSnapshot(
			providersStateFromSettings(settingsWithCommandCode({ apiKey: MASKED_KEY })),
		);
		expect(dirtyLabel({ ...draft, initialized: true }, baseline)).toBe("<i>true</i>");

		// 保存流程：state 与快照都来自服务端响应重建后的同一状态。
		const synced = providersStateFromSettings(settingsWithCommandCode({ apiKey: REAL_KEY }));
		expect(dirtyLabel(synced, createSnapshot(synced))).toBe("<i>false</i>");
	});

	test("代理与 UA 指纹同样进草稿与快照", () => {
		const saved = providersStateFromSettings(
			settingsWithCommandCode({
				apiKey: MASKED_KEY,
				proxy: { mode: "custom", url: "http://127.0.0.1:8080" },
				userAgentMode: "codex",
				extraHeaders: { "X-Test": "1" },
			}),
		);
		expect(saved.commandCode).toMatchObject({
			proxy: { mode: "custom", url: "http://127.0.0.1:8080" },
			userAgentMode: "codex",
			extraHeaders: { "X-Test": "1" },
		});
		const snapshot = createSnapshot(saved);
		expect(dirtyLabel(saved, snapshot)).toBe("<i>false</i>");

		const edited = providersReducer(saved, {
			type: "SET_COMMAND_CODE",
			config: { ...saved.commandCode, proxy: { mode: "direct" } },
		});
		expect(dirtyLabel(edited, snapshot)).toBe("<i>true</i>");
	});

	test("逐模型协议进草稿：可放弃更改、可清空，且与键顺序无关", () => {
		const saved = providersStateFromSettings({
			...settingsWithCommandCode(),
			agent: { modelProtocols: { "CommandCode:gpt-x": "openai-responses" } },
		});
		expect(saved.modelProtocols).toEqual({ "CommandCode:gpt-x": "openai-responses" });
		const snapshot = createSnapshot(saved);
		expect(dirtyLabel(saved, snapshot)).toBe("<i>false</i>");

		// 改协议 → 脏；放弃更改 → 回到原值（这正是之前「选了就立即落库」做不到的）。
		const changed = providersReducer(saved, {
			type: "SET_MODEL_PROTOCOL",
			modelVal: "CommandCode:gpt-x",
			protocol: "completions-compatible",
		});
		expect(changed.modelProtocols["CommandCode:gpt-x"]).toBe("completions-compatible");
		expect(dirtyLabel(changed, snapshot)).toBe("<i>true</i>");
		const discarded = providersReducer(changed, { type: "RESTORE_FROM_SNAPSHOT", snapshot });
		expect(discarded.modelProtocols).toEqual({ "CommandCode:gpt-x": "openai-responses" });
		expect(dirtyLabel(discarded, snapshot)).toBe("<i>false</i>");

		// 选择「跟随默认」= 删除该键；新增与删除都进草稿。
		const withExtra = providersReducer(changed, {
			type: "SET_MODEL_PROTOCOL",
			modelVal: "openai:gpt-y",
			protocol: "anthropic-messages",
		});
		const resetToDefault = providersReducer(withExtra, {
			type: "SET_MODEL_PROTOCOL",
			modelVal: "CommandCode:gpt-x",
			protocol: null,
		});
		expect(resetToDefault.modelProtocols).toEqual({ "openai:gpt-y": "anthropic-messages" });

		// 同一个映射换一种键顺序不该算脏，否则保存条会因为对象重排无故出现。
		const baseline: ProvidersState = {
			...saved,
			modelProtocols: {
				"CommandCode:gpt-x": "openai-responses",
				"openai:gpt-y": "anthropic-messages",
			},
		};
		const reordered: ProvidersState = {
			...saved,
			modelProtocols: {
				"openai:gpt-y": "anthropic-messages",
				"CommandCode:gpt-x": "openai-responses",
			},
		};
		expect(dirtyLabel(reordered, createSnapshot(baseline))).toBe("<i>false</i>");
	});
});

/**
 * 平台集成（codex / Command Code / TokenDance）的开关必须是草稿：只改 state，由底部保存条
 * 统一提交，「放弃更改」随快照回滚。这组用例锁住「不许绕过草稿直接生效」这条约定 ——
 * 新增平台 provider 时把它加进 PLATFORM_PROVIDER_PREFIXES，并在这里补一条映射。
 */
describe("平台 provider 的开关走草稿", () => {
	function baseState(): ProvidersState {
		return providersStateFromSettings({
			customApiProviders: [],
			openaiProviders: [],
			anthropicProviders: [],
			nugProviders: [],
			commandCode: { apiKey: "********abcd" },
			tokendance: { disabled: false },
			agent: { disabledProviders: [] },
		});
	}

	test("三个平台前缀都只改草稿，脏标记与放弃更改同步生效", () => {
		const base = baseState();
		const snapshot = createSnapshot(base);
		expect(dirtyLabel(base, snapshot)).toBe("<i>false</i>");

		const cases = [
			["codex", (state: ProvidersState) => state.disabledProviders.has("codex")],
			["CommandCode", (state: ProvidersState) => state.commandCode.disabled],
			["tokendance", (state: ProvidersState) => state.tokenDanceDisabled],
		] as const;

		for (const [prefix, read] of cases) {
			const next = providersReducer(base, {
				type: "SET_PLATFORM_DISABLED",
				prefix,
				disabled: true,
			});
			expect(read(next)).toBe(true);
			expect(dirtyLabel(next, snapshot)).toBe("<i>true</i>");

			const reverted = providersReducer(next, { type: "RESTORE_FROM_SNAPSHOT", snapshot });
			expect(read(reverted)).toBe(false);
			expect(dirtyLabel(reverted, snapshot)).toBe("<i>false</i>");
		}
	});

	test("平台清单是判定开关路径的唯一依据", () => {
		for (const prefix of ["codex", "CommandCode", "tokendance"]) {
			expect(isPlatformProviderPrefix(prefix)).toBe(true);
		}
		expect(isPlatformProviderPrefix("custom-api")).toBe(false);
	});

	/**
	 * The custom-provider state is built by an explicit field list, so anything missing there is
	 * dropped on every rebuild. A dropped value makes the site-quota inputs behave like they are
	 * read-only: the keystroke lands in state, then the next rebuild erases it.
	 */
	test("site quota fields survive the settings→state mapping and a server re-sync", () => {
		const site = {
			...provider,
			protocol: "completions-compatible" as const,
			quotaSiteUrl: "https://api.example.com",
			quotaAccessToken: "********wxyz",
			quotaUserId: "12345",
		};
		const settings = { customApiProviders: [site], agent: {} };

		const mapped = providersStateFromSettings(settings).customApiProviders[0];
		expect(mapped?.quotaSiteUrl).toBe("https://api.example.com");
		expect(mapped?.quotaAccessToken).toBe("********wxyz");
		expect(mapped?.quotaUserId).toBe("12345");

		// A server re-sync rebuilds the whole list through the same normalizer, which is what
		// used to erase a value the operator had just typed.
		const resynced = providersReducer(providersStateFromSettings(settings), {
			type: "SYNC_FROM_SETTINGS",
			settings,
		}).customApiProviders[0];
		expect(resynced?.quotaSiteUrl).toBe("https://api.example.com");
		expect(resynced?.quotaAccessToken).toBe("********wxyz");
		expect(resynced?.quotaUserId).toBe("12345");
	});
});

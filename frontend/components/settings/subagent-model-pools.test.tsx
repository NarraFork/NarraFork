import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type {
	SubagentModelPools,
	SubagentModelReasoningEfforts,
} from "@shared/subagent-model-policy";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next, { type i18n } from "i18next";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import {
	type UseInstanceSettingsReturn,
	useInstanceSettings,
} from "../../hooks/useInstanceSettings";
import {
	useClearSubagentModelRestriction,
	useNarratorCustomTraits,
	useUpdateSubagentModelRestriction,
} from "../../hooks/useNarrator";
import type { NarratorCustomTraits } from "../../lib/api/narrators";
import commonEn from "../../locales/en/common.json";
import narratorEn from "../../locales/en/narrator.json";
import settingsEn from "../../locales/en/settings.json";
import narratorZh from "../../locales/zh-CN/narrator.json";
import settingsZh from "../../locales/zh-CN/settings.json";
import {
	SubagentModelPoolEditor,
	useSubagentModelPoolDraft,
} from "../narrator/SubagentModelPoolEditor";
import { ModelsSection } from "./ModelsSection";

let root: Root;
let container: HTMLDivElement;
let testI18n: i18n;
let queryClient: QueryClient;
let latestSettings: UseInstanceSettingsReturn | undefined;
const globals = new Map<string, PropertyDescriptor | undefined>();
let originalFetch: typeof fetch;
let makeEvent: (type: string, init?: EventInit) => Event;
let setNativeValue: (input: HTMLInputElement | HTMLTextAreaElement, value: string) => void;

function installDom() {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	makeEvent = (type, init) => new (window as unknown as { Event: typeof Event }).Event(type, init);
	Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", {
		value: () => {},
		configurable: true,
	});
	setNativeValue = (input, value) => {
		const proto =
			input.tagName === "TEXTAREA"
				? window.HTMLTextAreaElement.prototype
				: window.HTMLInputElement.prototype;
		const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
		if (!setter) throw new Error("missing native value setter");
		setter.call(input, value);
	};
	for (const proto of [window.HTMLInputElement.prototype, window.HTMLTextAreaElement.prototype]) {
		Object.defineProperties(proto, {
			attachEvent: { value: () => {}, configurable: true },
			detachEvent: { value: () => {}, configurable: true },
			select: { value: () => {}, configurable: true },
			setSelectionRange: { value: () => {}, configurable: true },
		});
	}
	const typeDescriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "type");
	if (typeDescriptor?.get) {
		const get = typeDescriptor.get;
		Object.defineProperty(window.HTMLInputElement.prototype, "type", {
			...typeDescriptor,
			get(this: HTMLInputElement) {
				return get.call(this) ?? "text";
			},
		});
	}
	(window.document as unknown as Record<string, unknown>).oninput = null;
	const computedStyle = () =>
		new Proxy({}, { get: (_target, key) => (key === "getPropertyValue" ? () => "" : "") });
	const matchMedia = () => ({
		matches: false,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
	});
	const storage = new Map<string, string>();
	const values: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		HTMLInputElement: window.HTMLInputElement,
		HTMLTextAreaElement: window.HTMLTextAreaElement,
		Element: window.Element,
		Node: window.Node,
		Document: window.Document,
		ShadowRoot: class {},
		getComputedStyle: computedStyle,
		matchMedia,
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
		cancelAnimationFrame: (id: Timer) => clearTimeout(id),
		localStorage: {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => storage.set(key, value),
			removeItem: (key: string) => storage.delete(key),
		},
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(values)) {
		globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
	}
	Object.assign(window, { getComputedStyle: computedStyle, matchMedia });
}

beforeEach(async () => {
	originalFetch = globalThis.fetch;
	installDom();
	testI18n = i18next.createInstance();
	await testI18n.use(initReactI18next).init({
		lng: "en",
		fallbackLng: "en",
		defaultNS: "narrator",
		resources: { en: { narrator: narratorEn, settings: settingsEn, common: commonEn } },
		interpolation: { escapeValue: false },
		react: { useSuspense: false },
	});
	queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
	});
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	queryClient.clear();
	container.remove();
	globalThis.fetch = originalFetch;
	latestSettings = undefined;
	for (const [key, descriptor] of globals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	globals.clear();
});

async function render(node: ReactNode) {
	await act(async () =>
		root.render(
			<I18nextProvider i18n={testI18n}>
				<QueryClientProvider client={queryClient}>
					<MantineProvider>{node}</MantineProvider>
				</QueryClientProvider>
			</I18nextProvider>,
		),
	);
}

async function click(element: Element | null) {
	if (!element) throw new Error("missing click target");
	await act(async () => element.dispatchEvent(makeEvent("click", { bubbles: true })));
}

function button(text: string) {
	return (
		[...container.querySelectorAll("button")].find((element) =>
			element.textContent?.includes(text),
		) ?? null
	);
}

function disclosure() {
	return button(narratorEn.poolReasoningEffort.title);
}
function effortInput(model: string) {
	return [...container.querySelectorAll("input")].find(
		(element) =>
			element.getAttribute("aria-label") === `${model}: ${narratorEn.poolReasoningEffort.title}`,
	);
}

async function chooseEffort(model: string, label: string) {
	const input = effortInput(model);
	await click(input ?? null);
	const listId = input?.getAttribute("aria-controls");
	const list = listId ? document.getElementById(listId) : null;
	const option = [...(list?.querySelectorAll('[role="option"]') ?? [])].find(
		(element) => element.textContent === label,
	);
	await click(option ?? null);
}

async function typePurpose(value: string) {
	const field = container.querySelector("textarea");
	if (!field) throw new Error("purpose textarea missing");
	await act(async () => field.dispatchEvent(makeEvent("focusin", { bubbles: true })));
	await act(async () => {
		setNativeValue(field, value);
		field.dispatchEvent(makeEvent("input", { bubbles: true }));
		field.dispatchEvent(makeEvent("keyup", { bubbles: true }));
	});
}

const stored: SubagentModelPools = {
	explore: [{ model: "p:visible", purpose: "existing purpose" }],
	plan: [],
	search: [{ model: "p:hidden", purpose: "hidden search", reasoningEffort: "high" }],
	review: [{ model: "aggregation:review", reasoningEffort: "max" }],
	custom: [{ model: "summary", purpose: "custom purpose", reasoningEffort: "none" }],
};

function SessionEditorHarness({
	hidden = false,
	ownerId = "session",
	...props
}: Partial<React.ComponentProps<typeof SubagentModelPoolEditor>> & {
	hidden?: boolean;
	ownerId?: string;
}) {
	const draft = useSubagentModelPoolDraft(props.pools, props.loaded ?? true, ownerId);
	if (hidden) return null;
	return (
		<SubagentModelPoolEditor
			availableModels={[]}
			loaded
			saving={false}
			clearing={false}
			onSave={() => {}}
			onClear={() => {}}
			{...props}
			{...draft}
		/>
	);
}

function sessionEditor(
	props: Partial<React.ComponentProps<typeof SubagentModelPoolEditor>> & {
		hidden?: boolean;
		ownerId?: string;
	} = {},
) {
	return <SessionEditorHarness pools={stored} {...props} />;
}

describe("session pool editor: real Mantine interactions", () => {
	test("defaults collapsed, old save preserves hidden pools, purposes, explicit empty pools and tiers", async () => {
		const saves: SubagentModelPools[] = [];
		await render(sessionEditor({ onSave: (pools) => saves.push(pools) }));
		expect(disclosure()?.getAttribute("aria-expanded")).toBe("false");
		expect(disclosure()?.textContent).toContain("3 fixed");
		expect(effortInput("p:visible")).toBeUndefined();
		expect(container.querySelector("textarea")?.value).toBe("existing purpose");
		await click(button(commonEn.save));
		expect(saves).toEqual([stored]);
	});

	test("the disclosure is a keyboard-focusable button and tiers support keyboard selection", async () => {
		const saves: SubagentModelPools[] = [];
		await render(
			sessionEditor({
				pools: { general: [{ model: "default" }] },
				onSave: (pools) => saves.push(pools),
			}),
		);
		expect(disclosure()?.tagName).toBe("BUTTON");
		expect(disclosure()?.getAttribute("tabindex")).not.toBe("-1");
		await click(disclosure());
		const input = effortInput("default");
		if (!input) throw new Error("missing effort input");
		await act(async () => input.dispatchEvent(makeEvent("focusin", { bubbles: true })));
		await click(input);
		const list = document.getElementById(input.getAttribute("aria-controls") ?? "");
		expect(list?.querySelectorAll('[role="option"]').length).toBe(7);
		for (const code of ["ArrowDown", "Enter"]) {
			await act(async () => {
				const event = makeEvent("keydown", { bubbles: true, cancelable: true });
				Object.assign(event, { code, key: code });
				input.dispatchEvent(event);
			});
		}
		await click(button(commonEn.save));
		expect(saves[0]).toEqual({ general: [{ model: "default", reasoningEffort: "none" }] });
	});

	test("configure, close, save, reload and clear only the effort field", async () => {
		const saves: SubagentModelPools[] = [];
		const onSave = (pools: SubagentModelPools) => saves.push(structuredClone(pools));
		await render(sessionEditor({ onSave }));
		await click(disclosure());
		expect(effortInput("p:hidden")?.value).toBe(narratorEn.reasoning_high);
		expect(effortInput("summary")?.value).toBe(narratorEn.reasoning_none);
		await chooseEffort("p:visible", narratorEn.reasoning_high);
		await click(disclosure());
		expect(disclosure()?.textContent).toContain("4 fixed");
		await click(button(commonEn.save));
		expect(saves[0].explore[0]).toEqual({ ...stored.explore[0], reasoningEffort: "high" });
		expect(saves[0].search).toEqual(stored.search);
		await render(sessionEditor({ pools: saves[0], onSave }));
		await click(disclosure());
		expect(effortInput("p:visible")?.value).toBe(narratorEn.reasoning_high);
		await chooseEffort("p:visible", narratorEn.poolReasoningEffort.unspecified);
		await chooseEffort("p:hidden", narratorEn.poolReasoningEffort.unspecified);
		await click(disclosure());
		await click(button(commonEn.save));
		expect(saves[1].explore).toEqual(stored.explore);
		expect(saves[1].search[0]).toEqual({ model: "p:hidden", purpose: "hidden search" });
		expect(saves[1].plan).toEqual([]);
		expect(saves[1].review).toEqual(stored.review);
	});

	test("purpose edit preserves tier; explicitly removing the model restores type inheritance", async () => {
		const saves: SubagentModelPools[] = [];
		await render(
			sessionEditor({
				pools: { ...stored, explore: [{ ...stored.explore[0], reasoningEffort: "high" }] },
				onSave: (pools) => saves.push(pools),
			}),
		);
		await typePurpose("edited purpose");
		await click(button(commonEn.save));
		expect(saves[0].explore[0]).toEqual({
			model: "p:visible",
			purpose: "edited purpose",
			reasoningEffort: "high",
		});
		await click(container.querySelector("[data-with-remove] button"));
		await click(button(commonEn.save));
		expect(saves[1]).not.toHaveProperty("explore");
		expect(saves[1].plan).toEqual([]);
		expect(saves[1].search).toEqual(stored.search);
	});

	test("hiding the details section keeps a draft; switching narrator resets it", async () => {
		const saves: SubagentModelPools[] = [];
		const onSave = (pools: SubagentModelPools) => saves.push(pools);
		await render(sessionEditor({ onSave }));
		await typePurpose("unsaved purpose");
		await render(sessionEditor({ hidden: true, onSave }));
		await render(sessionEditor({ onSave }));
		expect(container.querySelector("textarea")?.value).toBe("unsaved purpose");
		await click(button(commonEn.save));
		expect(saves[0].explore[0].purpose).toBe("unsaved purpose");
		await render(sessionEditor({ ownerId: "another-session", onSave }));
		expect(container.querySelector("textarea")?.value).toBe("existing purpose");
	});

	test("no configuration stays empty after disclosure; none remains an explicit tier", async () => {
		const saves: SubagentModelPools[] = [];
		await render(sessionEditor({ pools: {}, onSave: (pools) => saves.push(pools) }));
		await click(disclosure());
		await click(disclosure());
		await click(button(commonEn.save));
		expect(saves).toEqual([{}]);
		await render(
			sessionEditor({
				pools: { general: [{ model: "default" }] },
				onSave: (pools) => saves.push(pools),
			}),
		);
		await click(disclosure());
		await chooseEffort("default", narratorEn.reasoning_none);
		await click(button(commonEn.save));
		expect(saves[1]).toEqual({ general: [{ model: "default", reasoningEffort: "none" }] });
	});

	test("failed or pending load cannot submit empty initial state; later data becomes editable", async () => {
		const saves: SubagentModelPools[] = [];
		const onSave = (pools: SubagentModelPools) => saves.push(pools);
		await render(sessionEditor({ pools: undefined, loaded: false, onSave }));
		expect(button(commonEn.save)?.hasAttribute("disabled")).toBe(true);
		await click(button(commonEn.save));
		expect(saves).toEqual([]);
		await render(sessionEditor({ onSave }));
		expect(button(commonEn.save)?.hasAttribute("disabled")).toBe(false);
		await click(button(commonEn.save));
		expect(saves).toEqual([stored]);
	});
});

function ConnectedSessionEditor() {
	const { data } = useNarratorCustomTraits("session");
	const update = useUpdateSubagentModelRestriction();
	const clear = useClearSubagentModelRestriction();
	const draft = useSubagentModelPoolDraft(
		data?.subagentModelRestriction?.pools,
		data !== undefined,
	);
	return (
		<SubagentModelPoolEditor
			{...draft}
			availableModels={data?.availableModels}
			loaded={data !== undefined}
			saving={update.isPending}
			clearing={clear.isPending}
			onSave={(pools) => update.mutate({ id: "session", pools })}
			onClear={() => clear.mutate("session")}
		/>
	);
}

test("session API/hook/editor round trip resynchronizes saved and cleared pools", async () => {
	let traits: NarratorCustomTraits = {
		subagentModelRestriction: { version: 1, pools: structuredClone(stored) },
		disabledTools: null,
		blockedSkills: null,
		availableModels: [],
		availableTools: [],
	};
	queryClient.setQueryData(["narrators", "session", "custom-traits"], traits);
	const writes: SubagentModelPools[] = [];
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		if (init?.method === "PUT") {
			const { pools } = JSON.parse(String(init.body));
			writes.push(structuredClone(pools));
			// Simulate the server's normalizer to prove UI state comes from the response.
			pools.explore[0].purpose = pools.explore[0].purpose.trim();
			traits = { ...traits, subagentModelRestriction: { version: 1, pools } };
		} else if (init?.method === "DELETE") {
			traits = { ...traits, subagentModelRestriction: null };
		}
		return Response.json(init?.method ? { ok: true, traits: [], customTraits: traits } : traits);
	}) as typeof fetch;
	await render(<ConnectedSessionEditor />);
	await typePurpose("  saved purpose  ");
	await click(disclosure());
	await chooseEffort("p:visible", narratorEn.reasoning_high);
	await click(disclosure());
	await click(button(commonEn.save));
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(writes[0].explore[0]).toEqual({
		model: "p:visible",
		purpose: "  saved purpose  ",
		reasoningEffort: "high",
	});
	expect(writes[0].plan).toEqual([]);
	expect(writes[0].custom).toEqual(stored.custom);
	expect(container.querySelector("textarea")?.value).toBe("saved purpose");
	await click(disclosure());
	expect(effortInput("p:visible")?.value).toBe(narratorEn.reasoning_high);
	await click(button(narratorEn["details.clearTrait"]));
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(container.querySelectorAll("textarea").length).toBe(0);
	expect(effortInput("p:visible")).toBeUndefined();
});

function GlobalEditor({
	catalog = [],
}: {
	catalog?: React.ComponentProps<typeof ModelsSection>["groupedModels"];
}) {
	const settings = useInstanceSettings();
	latestSettings = settings;
	return (
		<>
			<ModelsSection {...settings} groupedModels={catalog} navigate={() => {}} />
			<button type="button" onClick={settings.save}>
				Save settings
			</button>
		</>
	);
}

function installSettings(efforts?: SubagentModelReasoningEfforts) {
	const writes: { agent: { subagentModelReasoningEfforts?: SubagentModelReasoningEfforts } }[] = [];
	const server = {
		agent: {
			defaultModel: "p:visible",
			summaryModel: "p:visible",
			subagentAllowedModels: {
				explore: ["p:visible"],
				general: [],
				plan: [],
				review: ["p:visible"],
			},
			...(efforts === undefined ? {} : { subagentModelReasoningEfforts: efforts }),
		},
	};
	queryClient.setQueryData(["settings"], server);
	globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
		if (init?.body) {
			const body = JSON.parse(String(init.body));
			writes.push(body);
			Object.assign(server.agent, body.agent);
		}
		return Response.json(server);
	}) as typeof fetch;
	return writes;
}

async function saveGlobal() {
	await click(button("Save settings"));
	// React Query mutation success notifications are scheduled, not synchronous.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

describe("global ModelsSection + real useInstanceSettings + settings request", () => {
	test("old settings stay clean on expand/collapse and unrelated save omits the new field", async () => {
		const writes = installSettings();
		await render(<GlobalEditor />);
		expect(disclosure()?.getAttribute("aria-expanded")).toBe("false");
		expect(latestSettings?.isDirty).toBe(false);
		await click(disclosure());
		expect(effortInput("p:visible")?.value).toBe(narratorEn.poolReasoningEffort.unspecified);
		await click(disclosure());
		expect(latestSettings?.isDirty).toBe(false);
		await act(async () => latestSettings?.setMaxTurns(888));
		await saveGlobal();
		expect(writes).toHaveLength(1);
		expect(writes[0].agent).not.toHaveProperty("subagentModelReasoningEfforts");
	});

	test("loaded full map survives missing/changing catalog and unedited saves", async () => {
		const efforts: SubagentModelReasoningEfforts = {
			explore: { "p:visible": "high", "p:orphan": "max" },
			review: { "p:visible": "none" },
			search: { summary: "low" },
		};
		const writes = installSettings(efforts);
		await render(<GlobalEditor />);
		// Orphan metadata is retained, but only selected entries count as fixed policy.
		expect(disclosure()?.textContent).toContain("2 fixed");
		expect(latestSettings?.subagentModelReasoningEfforts).toEqual(efforts);
		await render(
			<GlobalEditor
				catalog={[{ group: "Other", items: [{ value: "p:other", label: "Other" }] }]}
			/>,
		);
		expect(latestSettings?.subagentModelReasoningEfforts).toEqual(efforts);
		expect(container.textContent).toContain("p:visible");
		await saveGlobal();
		expect(writes[0].agent).not.toHaveProperty("subagentModelReasoningEfforts");
	});

	test("configure and clear through collapsed save, keeping other types and map entries", async () => {
		const original: SubagentModelReasoningEfforts = {
			review: { "p:visible": "none" },
			search: { summary: "max" },
		};
		const writes = installSettings(original);
		await render(<GlobalEditor />);
		await click(disclosure());
		await chooseEffort("p:visible", narratorEn.reasoning_high);
		await click(disclosure());
		await saveGlobal();
		expect(writes[0].agent.subagentModelReasoningEfforts).toEqual({
			...original,
			explore: { "p:visible": "high" },
		});
		expect(latestSettings?.isDirty).toBe(false);
		await click(disclosure());
		await chooseEffort("p:visible", narratorEn.poolReasoningEffort.unspecified);
		await click(disclosure());
		await saveGlobal();
		expect(writes[1].agent.subagentModelReasoningEfforts).toEqual(original);
	});

	test("clearing the last configured tier sends an explicit empty map, then later saves omit it", async () => {
		const writes = installSettings({ explore: { "p:visible": "none" } });
		await render(<GlobalEditor />);
		await click(disclosure());
		await chooseEffort("p:visible", narratorEn.poolReasoningEffort.unspecified);
		await click(disclosure());
		await saveGlobal();
		expect(writes[0].agent.subagentModelReasoningEfforts).toEqual({});
		await saveGlobal();
		expect(writes[1].agent).not.toHaveProperty("subagentModelReasoningEfforts");
	});

	test("failed settings load cannot save empty initial models or a manufactured map", async () => {
		const writes: string[] = [];
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			if (init?.body) writes.push(String(init.body));
			return Response.json({ error: "unavailable" }, { status: 503 });
		}) as typeof fetch;
		await render(<GlobalEditor />);
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(latestSettings?.initialized).toBe(false);
		await saveGlobal();
		expect(writes).toEqual([]);
	});

	test("explicit model removal drops only that type's fixed value", async () => {
		const writes = installSettings({
			explore: { "p:visible": "high", "p:orphan": "max" },
			review: { "p:visible": "low" },
		});
		await render(<GlobalEditor />);
		await click(container.querySelector("[data-with-remove] button"));
		await saveGlobal();
		expect(writes[0].agent.subagentModelReasoningEfforts).toEqual({
			explore: { "p:orphan": "max" },
			review: { "p:visible": "low" },
		});
	});
});

test("new English and Chinese strings have matching keys and distinguish inherited absence from none", () => {
	expect(Object.keys(narratorZh.poolReasoningEffort).sort()).toEqual(
		Object.keys(narratorEn.poolReasoningEffort).sort(),
	);
	for (const locale of [narratorEn, narratorZh]) {
		expect(locale.poolReasoningEffort.sessionHelp).toContain("none");
		expect(locale.poolReasoningEffort.unspecified).not.toBe(locale.reasoning_none);
	}
	for (const locale of [settingsEn, settingsZh])
		expect(locale.subagentPoolReasoningEffortHelp).toContain("none");
});

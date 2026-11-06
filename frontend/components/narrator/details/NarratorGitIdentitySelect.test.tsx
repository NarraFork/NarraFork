import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import type { NarratorGitIdentityState } from "../../../hooks/useGitIdentities";
import { api } from "../../../lib/api";
import commonLocale from "../../../locales/en/common.json";
import narratorLocale from "../../../locales/en/narrator.json";
import { NarratorGitIdentitySelect } from "./NarratorGitIdentitySelect";

let root: Root | undefined;
let client: QueryClient | undefined;
let restoreDom: (() => void) | undefined;
let restoreApi: (() => void) | undefined;

const identities = [
	{
		id: "personal",
		name: "Personal",
		email: "me@example.com",
		isDefault: true,
		createdAt: "2026-01-01",
	},
	{ id: "work", name: "Work", email: "me@company.com", isDefault: false, createdAt: "2026-01-02" },
];

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	client?.clear();
	root = undefined;
	client = undefined;
	restoreApi?.();
	restoreApi = undefined;
	restoreDom?.();
	restoreDom = undefined;
});

async function mount(state: NarratorGitIdentityState) {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	const previous = new Map(
		Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	Object.assign(globalThis, globals);
	restoreDom = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	const i18n = i18next.createInstance();
	await i18n.init({
		lng: "en",
		resources: { en: { common: commonLocale, narrator: narratorLocale } },
		initImmediate: false,
	});
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(["auth", "git-identities", "narrator", "n1"], state);
	const get = spyOn(api, "getNarratorGitIdentity").mockResolvedValue(state);
	const set = spyOn(api, "setNarratorGitIdentity").mockResolvedValue({ ok: true });
	restoreApi = () => {
		get.mockRestore();
		set.mockRestore();
	};
	const container = window.document.createElement("div");
	window.document.body.append(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<QueryClientProvider client={client as QueryClient}>
				<I18nextProvider i18n={i18n}>
					<MantineProvider env="test">
						<NarratorGitIdentitySelect narratorId="n1" />
					</MantineProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		);
	});
	return {
		container,
		set,
		change: async (value: string) => {
			const select = container.querySelector("select");
			if (!select) throw new Error("Identity selector missing");
			Object.defineProperty(select, "value", { configurable: true, value });
			await act(async () => {
				select.dispatchEvent(new window.Event("change", { bubbles: true }));
				await new Promise((resolve) => setTimeout(resolve, 10));
			});
		},
	};
}

describe("session details Git identity", () => {
	it("lists the default and personal identities with email addresses", async () => {
		const { container } = await mount({ identities, selectedId: "work" });
		expect(container.textContent).toContain("Git commit identity");
		expect(container.textContent).toContain("Follow default identity (Personal)");
		expect(container.textContent).toContain("Work <me@company.com>");
		expect(container.querySelector('option[value="work"]')?.hasAttribute("selected")).toBe(true);
	});

	it("saves an explicit choice for the current session", async () => {
		const { change, set } = await mount({ identities, selectedId: null });
		await change("work");
		expect(set).toHaveBeenCalledWith("n1", "work");
	});

	it("clears the binding when following the default", async () => {
		const { change, set } = await mount({ identities, selectedId: "work" });
		await change("__follow_default__");
		expect(set).toHaveBeenCalledWith("n1", null);
	});

	it("disables an empty list and explains where to configure identities", async () => {
		const { container } = await mount({ identities: [], selectedId: null });
		expect(container.querySelector("select")?.hasAttribute("disabled")).toBe(true);
		expect(container.textContent).toContain("Settings → Profile");
	});

	it("integrates in searchable session settings and behind the display switches, not both tab menus", () => {
		const details = readFileSync(new URL("./NarratorDetailsPanel.tsx", import.meta.url), "utf8");
		expect(details).toContain("<NarratorGitIdentitySelect narratorId={narratorId} />");
		expect(details).toContain(
			'searchableText={[...sessionSearchableText, t("details.gitIdentity")]}',
		);
		// 侧边栏标签右键菜单重新提供该入口，但只在"显示设置"打开时才出现。
		const tabs = readFileSync(new URL("../../nav/RecentTabMenu.tsx", import.meta.url), "utf8");
		expect(tabs).toContain("gitIdentityNarratorId && gitIdentityVisibility.contextMenu");
		// 新建会话弹窗同样只受开关控制。
		const modal = readFileSync(new URL("../CreateNarratorModal.tsx", import.meta.url), "utf8");
		expect(modal).toContain("gitIdentityVisibility.createModal &&");
		// dockview 的标签菜单仍不提供：显示偏好只覆盖侧边栏与新建会话两处。
		const surface = readFileSync(new URL("../../dockview/SurfaceTab.tsx", import.meta.url), "utf8");
		expect(surface).not.toContain("GitIdentityMenu");
		expect(surface).not.toContain("gitIdentityNarratorId");
	});
});

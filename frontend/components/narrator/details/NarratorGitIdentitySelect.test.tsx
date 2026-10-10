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

	it("integrates in searchable session settings, not either tab menu", () => {
		const details = readFileSync(new URL("./NarratorDetailsPanel.tsx", import.meta.url), "utf8");
		expect(details).toContain("<NarratorGitIdentitySelect narratorId={narratorId} />");
		expect(details).toContain(
			'searchableText={[...sessionSearchableText, t("details.gitIdentity")]}',
		);
		for (const path of ["../../nav/RecentTabs.tsx", "../../dockview/SurfaceTab.tsx"]) {
			const source = readFileSync(new URL(path, import.meta.url), "utf8");
			expect(source).not.toContain("GitIdentityMenu");
			expect(source).not.toContain("gitIdentityNarratorId");
		}
	});
});

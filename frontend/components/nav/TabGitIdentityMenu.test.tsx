/**
 * The narrator-tab context menu's git identity entry.
 *
 * It renders inside a plain Paper + Stack menu (not a Mantine `Menu`), so the only thing
 * worth pinning down here is that the entry exists for a narrator tab, starts collapsed,
 * and opens in place — the pick itself is covered by the hook and server tests.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import commonLocale from "../../locales/en/common.json";
import { TabGitIdentityMenu } from "./TabGitIdentityMenu";

let root: Root | undefined;
let restoreDom: (() => void) | undefined;

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = undefined;
	restoreDom?.();
	restoreDom = undefined;
});

async function mount() {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
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
	await i18n.init({ lng: "en", resources: { en: { common: commonLocale } }, initImmediate: false });
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const container = window.document.createElement("div");
	window.document.body.append(container);
	root = createRoot(container);
	const closes: number[] = [];
	await act(async () => {
		root?.render(
			<QueryClientProvider client={client}>
				<I18nextProvider i18n={i18n}>
					<MantineProvider env="test">
						<TabGitIdentityMenu narratorId="n1" onClose={() => closes.push(1)} />
					</MantineProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		);
	});

	const entry = () =>
		Array.from(container.querySelectorAll("button")).find(
			(button) => button.textContent?.trim() === commonLocale.dockTabs.gitIdentity,
		);
	return {
		entry,
		closeCount: () => closes.length,
		click: async () => {
			await act(async () => {
				entry()?.dispatchEvent(new window.Event("click", { bubbles: true }));
			});
		},
	};
}

describe("tab git identity menu", () => {
	it("is present for a narrator tab and starts collapsed", async () => {
		const { entry } = await mount();
		expect(entry()).toBeDefined();
		expect(entry()?.getAttribute("aria-expanded")).toBe("false");
	});

	it("opens in place when clicked, without closing the surrounding menu", async () => {
		const { entry, closeCount, click } = await mount();
		expect(entry()?.getAttribute("aria-expanded")).toBe("false");

		await click();

		expect(entry()?.getAttribute("aria-expanded")).toBe("true");
		// The list renders through `Collapse`, whose measured height is always 0 under
		// linkedom, so the rows themselves are covered by the hook and server tests. What
		// this pins down is the toggle — and that expanding it does not dismiss the menu,
		// which would make the entry unusable.
		expect(closeCount()).toBe(0);
	});
});

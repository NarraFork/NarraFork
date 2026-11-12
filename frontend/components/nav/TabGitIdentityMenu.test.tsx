/**
 * The narrator-tab context menu's git identity entry.
 *
 * It renders inside a plain Paper + Stack menu (not a Mantine `Menu`), so the only thing
 * worth pinning down here is that the entry exists for a narrator tab, starts collapsed,
 * and opens in place — the pick itself is covered by the hook and server tests.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { MantineProvider } from "@mantine/core";
import {
	defaultScheduler,
	notifyManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import commonLocale from "../../locales/en/common.json";
import { TabGitIdentityMenu } from "./TabGitIdentityMenu";

let root: Root | undefined;
let client: QueryClient | undefined;
let restoreDom: (() => void) | undefined;
const notificationTimers = new Map<ReturnType<typeof setTimeout>, () => void>();
const animationFrames = new Map<number, ReturnType<typeof setTimeout>>();
let nextAnimationFrame = 0;

function cancelPendingAnimationFrames() {
	for (const timer of animationFrames.values()) clearTimeout(timer);
	animationFrames.clear();
}

async function cleanup() {
	try {
		// Collapse schedules nested frames without cancelling them on unmount. Stop those
		// owned by this fixture before asynchronous cleanup can restore/remove window.
		cancelPendingAnimationFrames();
		await act(async () => {
			root?.unmount();
			root = undefined;
			await client?.cancelQueries();
			client?.clear();
			// Unsubscribing does not retract already queued React store callbacks.
			// Deliver all of them while window still exists, without a timing guess.
			while (notificationTimers.size) {
				for (const [timer, callback] of [...notificationTimers]) {
					clearTimeout(timer);
					notificationTimers.delete(timer);
					callback();
				}
				await Promise.resolve();
			}
		});
	} finally {
		// Also cancel frames created while unmounting or draining store notifications.
		cancelPendingAnimationFrames();
		for (const timer of notificationTimers.keys()) clearTimeout(timer);
		notificationTimers.clear();
		notifyManager.setScheduler(defaultScheduler);
		client = undefined;
		restoreDom?.();
		restoreDom = undefined;
	}
}

afterEach(cleanup);

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
		requestAnimationFrame: (callback: FrameRequestCallback) => {
			const id = ++nextAnimationFrame;
			const timer = setTimeout(() => {
				animationFrames.delete(id);
				callback(performance.now());
			}, 0);
			animationFrames.set(id, timer);
			return id;
		},
		cancelAnimationFrame: (id: number) => {
			const timer = animationFrames.get(id);
			if (timer !== undefined) clearTimeout(timer);
			animationFrames.delete(id);
		},
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
	// Keep production's asynchronous delivery, but own its lifetime in this DOM fixture.
	notifyManager.setScheduler((callback) => {
		const timer = setTimeout(() => {
			notificationTimers.delete(timer);
			callback();
		}, 0);
		notificationTimers.set(timer, callback);
	});
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client = queryClient;
	const container = window.document.createElement("div");
	window.document.body.append(container);
	root = createRoot(container);
	const closes: number[] = [];
	await act(async () => {
		root?.render(
			<QueryClientProvider client={queryClient}>
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

	it("cancels unrun animation frames before restoring the DOM globals", async () => {
		await mount();
		let delivered = false;
		const frame = window.requestAnimationFrame(() => {
			delivered = true;
			window.requestAnimationFrame(() => {});
		});
		const timer = animationFrames.get(frame);
		expect(timer).toBeDefined();
		const cancel = spyOn(globalThis, "clearTimeout");
		try {
			await cleanup();
			expect(cancel).toHaveBeenCalledWith(timer);
			expect(animationFrames.size).toBe(0);
			expect(delivered).toBe(false);
		} finally {
			cancel.mockRestore();
		}
	});

	it("drains queued React notifications before restoring the DOM globals", async () => {
		const { click } = await mount();
		await click();
		const mountedClient = client;
		mountedClient?.setQueryData(["auth", "git-identities", "narrator", "n1"], {
			identities: [],
			selectedId: null,
		});
		expect(notificationTimers.size).toBeGreaterThan(0);
		const mountedWindow = window;
		let deliveredWithDom = false;
		notifyManager.schedule(() => {
			deliveredWithDom = globalThis.window === mountedWindow;
		});
		// Hold real store notifications past unmount deterministically. Teardown must
		// execute them, not just cancel their timers or hope that act flushes timers.
		for (const timer of notificationTimers.keys()) clearTimeout(timer);

		await cleanup();

		expect(deliveredWithDom).toBe(true);
		expect(notificationTimers.size).toBe(0);
		expect(mountedClient?.getQueryCache().getAll()).toEqual([]);
		expect(globalThis.window).not.toBe(mountedWindow);
	});
});

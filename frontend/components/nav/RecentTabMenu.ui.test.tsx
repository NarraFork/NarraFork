/**
 * Rows are one line and their details are a hover card, which touch cannot reach. These
 * tests hold the touch fallbacks: the row menu (left swipe) starts with the details, and
 * the clear button on the pinned divider does not wait for a hover.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RecentTab } from "@frontend/hooks/recent-tabs-utils";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import commonEn from "../../locales/en/common.json";
import navEn from "../../locales/en/nav.json";
import { RecentTabPinDivider, TabContextMenu, type TabContextMenuProps } from "./RecentTabMenu";

const i18n = createInstance();
await i18n.init({
	lng: "en",
	fallbackLng: "en",
	initImmediate: false,
	interpolation: { escapeValue: false },
	resources: { en: { common: commonEn, nav: navEn } },
});

const DOM_KEYS = [
	"window",
	"document",
	"navigator",
	"HTMLElement",
	"Element",
	"Node",
	"Event",
	"getComputedStyle",
	"requestAnimationFrame",
	"cancelAnimationFrame",
	"IS_REACT_ACT_ENVIRONMENT",
] as const;

let restoreDom: (() => void) | null = null;
let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
	const previous = new Map(
		DOM_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	Object.assign(window, {
		innerWidth: 1200,
		innerHeight: 800,
		matchMedia: (query: string) => ({
			matches: false,
			media: query,
			addEventListener() {},
			removeEventListener() {},
		}),
	});
	const values: Record<string, unknown> = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		getComputedStyle: () => ({ getPropertyValue: () => "" }),
		requestAnimationFrame: (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 0),
		cancelAnimationFrame: (id: number) => clearTimeout(id),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const key of DOM_KEYS) {
		Object.defineProperty(globalThis, key, {
			configurable: true,
			writable: true,
			value: values[key],
		});
	}
	restoreDom = () => {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	};
	container = window.document.createElement("div");
	window.document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root?.unmount());
	root = null;
	container = null;
	restoreDom?.();
	restoreDom = null;
});

async function render(ui: ReactNode) {
	const client = new QueryClient();
	client.setQueryData(["user-preferences"], {});
	await act(async () => {
		root?.render(
			<QueryClientProvider client={client}>
				<I18nextProvider i18n={i18n}>
					<MantineProvider env="test">{ui}</MantineProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		);
	});
}

const tab: RecentTab = {
	type: "narrator",
	id: "n1",
	title: "Investigate flaky test",
	subtitle: "/home/me/projects/narrafork/.worktrees/flaky",
	lastVisitedAt: 1,
	status: "working",
	activeTerminalCount: 2,
	activeBackgroundWorkCount: 1,
	viewerCount: 2,
	viewers: [
		{ userId: "u1", username: "alice", avatarColor: null, avatarImageId: null },
		{ userId: "u2", username: "bob", avatarColor: null, avatarImageId: null },
	],
};

function menuProps(overrides: Partial<TabContextMenuProps> = {}): TabContextMenuProps {
	const noop = () => {};
	return {
		x: 10,
		y: 10,
		onClose: noop,
		onMoveToTop: noop,
		onPin: noop,
		isPinned: false,
		onRemove: noop,
		onReveal: noop,
		canReveal: false,
		onNewNarratorHere: noop,
		canNewNarratorHere: false,
		onCopyCwd: noop,
		canCopyCwd: false,
		onOpenInWindow: noop,
		canOpenInWindow: false,
		onRename: noop,
		canRename: false,
		onArchive: noop,
		canArchive: false,
		isFirst: false,
		pinScope: "list",
		folder: null,
		onLeaveFolder: null,
		gitIdentityNarratorId: null,
		t: (key: string) => key,
		...overrides,
	};
}

describe("touch access to the details a row no longer shows", () => {
	test("the touch menu starts with the full path, counts and viewers", async () => {
		await render(<TabContextMenu {...menuProps({ detailsTab: tab })} />);
		const details = container?.ownerDocument.querySelector(
			'[data-recent-tab-details="narrator:n1"]',
		);
		expect(details).not.toBeNull();
		const text = details?.textContent ?? "";
		expect(text).toContain("/home/me/projects/narrafork/.worktrees/flaky");
		expect(text).toContain(i18n.t("common:activeTerminals", { count: 2 }));
		expect(text).toContain(i18n.t("common:activeBackgroundTasks", { count: 1 }));
		expect(text).toContain(i18n.t("common:viewersWatching", { count: 2 }));
	});

	test("the mouse menu has no details header (the hover card covers it)", async () => {
		await render(<TabContextMenu {...menuProps({ detailsTab: null })} />);
		expect(container?.ownerDocument.querySelector("[data-recent-tab-details]")).toBeNull();
	});

	test("the clear button is always shown on touch", async () => {
		await render(<RecentTabPinDivider clearable onClear={() => {}} touch t={(key) => key} />);
		expect(container?.querySelector("[data-recent-tab-clear]")).not.toBeNull();
	});

	test("with a mouse, the clear button waits for a hover; nothing to clear shows none", async () => {
		await render(
			<RecentTabPinDivider clearable onClear={() => {}} touch={false} t={(key) => key} />,
		);
		expect(container?.querySelector("[data-recent-tab-pin-divider]")).not.toBeNull();
		expect(container?.querySelector("[data-recent-tab-clear]")).toBeNull();

		await render(
			<RecentTabPinDivider clearable={false} onClear={() => {}} touch t={(key) => key} />,
		);
		expect(container?.querySelector("[data-recent-tab-clear]")).toBeNull();
	});
});

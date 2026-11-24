/**
 * "Pin to sidebar" reads whether its tab is pinned from the sidebar's loaded rows when the tab
 * is among them, and otherwise from one authoritative read of that tab: a pinned tab past the
 * loaded pages must read as pinned (so a click unpins it instead of pinning it again). Deltas
 * touching the tab and the button's own toggle refresh that read; a refused pin is reported.
 */
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { RecentTabStateResult, RecentTabsMutationResult } from "@shared/recent-tabs";
import { QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

const notify = mock((_value: unknown) => {});
const realNotifications = { ...(await import("@mantine/notifications")) };
mock.module("@mantine/notifications", () => ({
	...realNotifications,
	notifications: { ...realNotifications.notifications, show: notify },
}));
const realI18next = { ...(await import("react-i18next")) };
mock.module("react-i18next", () => ({
	...realI18next,
	useTranslation: () => ({ t: (key: string) => key }),
}));
const realMantine = { ...(await import("@mantine/core")) };
mock.module("@mantine/core", () => ({
	...realMantine,
	Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
	ActionIcon: ({
		children,
		onClick,
		disabled,
		loading,
		...rest
	}: {
		children?: ReactNode;
		onClick?: (event: { stopPropagation: () => void }) => void;
		disabled?: boolean;
		loading?: boolean;
		[key: string]: unknown;
	}) => (
		<button
			type="button"
			disabled={disabled}
			data-loading={loading ? "true" : "false"}
			data-testid={rest["data-testid"] as string}
			data-pinned={rest["data-pinned"] as string}
			onClick={(event) => onClick?.(event)}
		>
			{children}
		</button>
	),
}));

const { api } = await import("../../lib/api");
const { queryClient } = await import("../../lib/query-client");
const { applyRecentTabsDeltaAndFollowUp, RECENT_TABS_QUERY_KEY } = await import(
	"../../hooks/useRecentTabs"
);
const { PinToSidebarButton } = await import("./PinToSidebarButton");

const unchanged: RecentTabsMutationResult = {
	changed: false,
	baseRevision: 0,
	revision: 0,
	operations: [],
};

let root: Root;
let container: HTMLDivElement;
const saved = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	notify.mockClear();
	queryClient.clear();
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	for (const [key, descriptor] of saved) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	saved.clear();
	queryClient.clear();
	mock.restore();
});

async function settle() {
	for (let round = 0; round < 5; round++) {
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
	}
}

async function renderButton() {
	await act(async () =>
		root.render(
			<QueryClientProvider client={queryClient}>
				<PinToSidebarButton type="team" id="far" title="Far team" size="sm" />
			</QueryClientProvider>,
		),
	);
	await settle();
}

function button(): HTMLButtonElement {
	const node = container.querySelector<HTMLButtonElement>('[data-testid="pin-to-sidebar"]');
	if (!node) throw new Error("no pin button");
	return node;
}

async function click() {
	await act(async () => button().dispatchEvent(new window.Event("click", { bubbles: true })));
	await settle();
}

test("a pinned tab outside the loaded pages reads as pinned, and a click unpins it", async () => {
	// The sidebar has loaded some other tabs, not this one.
	queryClient.setQueryData(RECENT_TABS_QUERY_KEY, [
		{ type: "narrator", id: "near", title: "Near", lastVisitedAt: 1, pinned: true },
	]);
	const state = spyOn(api, "getRecentTabState").mockResolvedValue({
		present: true,
		pinned: true,
	});
	const upsert = spyOn(api, "upsertRecentTab").mockResolvedValue(unchanged);
	const pin = spyOn(api, "pinRecentTab").mockResolvedValue(unchanged);

	await renderButton();
	expect(state).toHaveBeenCalledTimes(1);
	expect(state.mock.calls[0]?.slice(0, 2)).toEqual(["team", "far"]);
	expect(button().getAttribute("data-pinned")).toBe("true");
	expect(button().disabled).toBe(false);

	state.mockResolvedValue({ present: true, pinned: false });
	await click();
	expect(pin).toHaveBeenCalledWith("team:far", false);
	expect(upsert).not.toHaveBeenCalled();
	// Its own unpin refreshes the read.
	expect(state).toHaveBeenCalledTimes(2);
	expect(button().getAttribute("data-pinned")).toBe("false");
});

test("a loaded row answers at once, without a read", async () => {
	queryClient.setQueryData(RECENT_TABS_QUERY_KEY, [
		{ type: "team", id: "far", title: "Far team", lastVisitedAt: 1, pinned: true },
	]);
	const state = spyOn(api, "getRecentTabState").mockResolvedValue({
		present: false,
		pinned: false,
	});
	await renderButton();
	expect(state).not.toHaveBeenCalled();
	expect(button().getAttribute("data-pinned")).toBe("true");
});

test("until the read answers the button offers nothing", async () => {
	let answer: (value: RecentTabStateResult) => void = () => {};
	spyOn(api, "getRecentTabState").mockReturnValue(
		new Promise<RecentTabStateResult>((resolve) => {
			answer = resolve;
		}),
	);
	await renderButton();
	expect(button().disabled).toBe(true);
	await act(async () => answer({ present: true, pinned: true }));
	await settle();
	expect(button().disabled).toBe(false);
	expect(button().getAttribute("data-pinned")).toBe("true");
});

test("a delta touching the tab re-reads it; one touching another tab does not", async () => {
	const state = spyOn(api, "getRecentTabState").mockResolvedValue({
		present: true,
		pinned: true,
	});
	await renderButton();
	expect(state).toHaveBeenCalledTimes(1);

	await act(async () =>
		applyRecentTabsDeltaAndFollowUp(queryClient, {
			baseRevision: 1,
			revision: 2,
			operations: [{ type: "remove", key: "narrator:elsewhere" }],
		}),
	);
	await settle();
	expect(state).toHaveBeenCalledTimes(1);

	// Unpinned from another client: the sidebar's frame touches this tab.
	state.mockResolvedValue({ present: true, pinned: false });
	await act(async () =>
		applyRecentTabsDeltaAndFollowUp(queryClient, {
			baseRevision: 2,
			revision: 3,
			operations: [
				{
					type: "upsert",
					key: "team:far",
					tab: { type: "team", id: "far", title: "Far team", lastVisitedAt: 1 },
					beforeKey: null,
					afterKey: null,
				},
			],
		}),
	);
	await settle();
	expect(state).toHaveBeenCalledTimes(2);
	expect(button().getAttribute("data-pinned")).toBe("false");
});

test("a pin the server refuses is reported, not silently dropped", async () => {
	spyOn(api, "getRecentTabState").mockResolvedValue({ present: false, pinned: false });
	const refused = Object.assign(new Error("This tab cannot be kept in the sidebar"), {
		status: 409,
		code: "RECENT_TAB_REFUSED",
	});
	const upsert = spyOn(api, "upsertRecentTab").mockRejectedValue(refused);
	await renderButton();
	expect(button().getAttribute("data-pinned")).toBe("false");

	await click();
	expect(upsert).toHaveBeenCalledTimes(1);
	expect(upsert.mock.calls[0]?.[0]).toMatchObject({ type: "team", id: "far", pin: true });
	expect(notify).toHaveBeenCalledWith({ color: "red", message: "pinToSidebarFailed" });
	expect(button().getAttribute("data-pinned")).toBe("false");
	expect(button().getAttribute("data-loading")).toBe("false");
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Drawer, MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
	DetailsPanelContentLifetime,
	useDetailsDraft,
	useDetailsPanelLifecycle,
} from "./details-panel-lifecycle";

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let renders: number;
let childRenders: number;
let effectMounts: number;
let effectCleanups: number;
let finishExit: () => void;
let changeDraft: (value: string) => void;
let resetDraft: (value: string) => void;
let changeLocal: (value: string) => void;
const originals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	const matchMedia = (media: string) => ({
		media,
		matches: false,
		onchange: null,
		dispatchEvent: () => false,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
	});
	const globals = {
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		matchMedia,
		getComputedStyle: () => ({ getPropertyValue: () => "", display: "block" }),
		requestAnimationFrame: (cb: (time: number) => void) => setTimeout(() => cb(Date.now()), 0),
		cancelAnimationFrame: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
		IS_REACT_ACT_ENVIRONMENT: true,
	};
	for (const [key, value] of Object.entries(globals)) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	window.matchMedia = matchMedia;
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	client.setQueryData(["details"], "cached");
	client.setQueryData(["details-child"], "child cached");
	renders = 0;
	childRenders = 0;
	effectMounts = 0;
	effectCleanups = 0;
});

afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	container.remove();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

function QueryChild() {
	childRenders++;
	const { data } = useQuery({ queryKey: ["details-child"], queryFn: async () => "child fetched" });
	return <span data-child>{data}</span>;
}

function HeavyDetails({ label, source }: { label: string; source: string }) {
	renders++;
	const { data } = useQuery({ queryKey: ["details"], queryFn: async () => "fetched" });
	const draft = useDetailsDraft(source);
	const [local, setLocal] = useState("initial");
	changeDraft = draft.setValue;
	resetDraft = draft.reset;
	changeLocal = setLocal;
	useEffect(() => {
		effectMounts++;
		return () => {
			effectCleanups++;
		};
	}, []);
	return (
		<div data-heavy>
			<span data-label>{label}</span>
			<span data-query>{data}</span>
			<input value={draft.value} readOnly />
			<span data-local>{local}</span>
			<QueryChild />
		</div>
	);
}

function Harness({
	opened,
	label = "first",
	source = "server",
	drawer = true,
	realDrawer = false,
}: {
	opened: boolean;
	label?: string;
	source?: string;
	drawer?: boolean;
	realDrawer?: boolean;
}) {
	const lifetime = useDetailsPanelLifecycle(opened, drawer);
	finishExit = lifetime.onExitTransitionEnd;
	const content = (
		<DetailsPanelContentLifetime opened={opened} {...lifetime}>
			<HeavyDetails label={label} source={source} />
		</DetailsPanelContentLifetime>
	);
	if (realDrawer) {
		return (
			<MantineProvider>
				<Drawer
					opened={opened}
					onClose={() => {}}
					keepMounted
					onExitTransitionEnd={lifetime.onExitTransitionEnd}
					withinPortal={false}
					trapFocus={false}
					lockScroll={false}
					returnFocus={false}
					transitionProps={{ duration: 30 }}
				>
					{content}
				</Drawer>
			</MantineProvider>
		);
	}
	return <section data-active={lifetime.active}>{content}</section>;
}

async function render(props: Parameters<typeof Harness>[0], owner = "narrator-a") {
	await act(async () => {
		root.render(
			<QueryClientProvider client={client}>
				<Harness key={owner} {...props} />
			</QueryClientProvider>,
		);
	});
}

function observers(key: string) {
	return client
		.getQueryCache()
		.find({ queryKey: [key] })
		?.getObserversCount();
}

async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 80));
	});
}

describe("details content lifetime", () => {
	test("never opened means no heavy render, effects, or query subscription", async () => {
		await render({ opened: false });
		await render({ opened: false, label: "streaming update" });
		expect(renders).toBe(0);
		expect(effectMounts).toBe(0);
		expect(observers("details")).toBe(0);
		expect(container.querySelector("[data-heavy]")).toBeNull();
	});

	test("exit preserves DOM, then disconnects both parent and nested queries; reopen is fresh", async () => {
		await render({ opened: true });
		await act(async () => {
			changeDraft("unsaved");
			changeLocal("filter and export preferences");
		});
		const input = container.querySelector("input");
		const beforeClose = renders;
		await render({ opened: false, label: "closed update" });
		expect(renders).toBe(beforeClose);
		expect(container.querySelector("[data-active]")?.getAttribute("data-active")).toBe("true");
		expect(input?.value).toBe("unsaved");
		expect(effectCleanups).toBe(0);
		await act(async () => finishExit());
		expect(effectCleanups).toBe(1);
		expect(observers("details")).toBe(0);
		expect(observers("details-child")).toBe(0);
		const sleepingRenders = renders;
		const sleepingChildRenders = childRenders;
		await act(async () => {
			client.setQueryData(["details"], "updated while closed");
			client.setQueryData(["details-child"], "child updated while closed");
			await client.invalidateQueries({ queryKey: ["details"] });
		});
		await render({ opened: false, label: "newest", source: "remote edit" });
		await settle();
		expect(renders).toBe(sleepingRenders);
		expect(childRenders).toBe(sleepingChildRenders);
		await render({ opened: true, label: "newest", source: "remote edit" });
		expect(container.querySelector("input")).toBe(input);
		expect(input?.value).toBe("unsaved");
		expect(container.querySelector("[data-local]")?.textContent).toBe(
			"filter and export preferences",
		);
		expect(container.querySelector("[data-label]")?.textContent).toBe("newest");
		expect(container.querySelector("[data-child]")?.textContent).toBe("child updated while closed");
		expect(effectMounts).toBe(2);
		expect(observers("details")).toBe(1);
		await settle();
		expect(container.querySelector("[data-query]")?.textContent).toBe("fetched");
	});

	test("reopening mid-exit ignores late completion and still accepts updated props", async () => {
		await render({ opened: true });
		await act(async () => changeDraft("draft"));
		await render({ opened: false });
		const oldExit = finishExit;
		await render({ opened: true, label: "reopened" });
		await act(async () => oldExit());
		expect(container.querySelector("[data-active]")?.getAttribute("data-active")).toBe("true");
		expect(container.querySelector("[data-label]")?.textContent).toBe("reopened");
		expect(container.querySelector("input")?.value).toBe("draft");
		expect(effectCleanups).toBe(0);
		expect(observers("details")).toBe(1);
	});

	test("sidebar/dock closes immediately and retains local state without an animation callback", async () => {
		await render({ opened: true, drawer: false });
		await act(async () => changeLocal("dock edit"));
		await render({ opened: false, drawer: false });
		expect(observers("details")).toBe(0);
		expect(effectCleanups).toBe(1);
		await render({ opened: true, drawer: false, source: "new server value" });
		expect(container.querySelector("[data-local]")?.textContent).toBe("dock edit");
		expect(container.querySelector("input")?.value).toBe("new server value");
	});

	test("saved/cancelled drafts resume server synchronization; switching owner resets drafts", async () => {
		await render({ opened: true, drawer: false });
		await act(async () => changeDraft("unsaved"));
		await act(async () => resetDraft("saved"));
		await render({ opened: false, drawer: false });
		await render({ opened: true, drawer: false, source: "later server" });
		expect(container.querySelector("input")?.value).toBe("later server");
		await act(async () => changeDraft("old narrator draft"));
		await render({ opened: false }, "narrator-b");
		expect(container.querySelector("input")).toBeNull();
		await render({ opened: true, source: "other narrator" }, "narrator-b");
		expect(container.querySelector("input")?.value).toBe("other narrator");
	});

	test("real Drawer keepMounted and exit callback suspend only after its transition", async () => {
		await render({ opened: true, realDrawer: true });
		await settle();
		await act(async () => changeDraft("real drawer draft"));
		const input = container.querySelector("input");
		await render({ opened: false, realDrawer: true });
		expect(effectCleanups).toBe(0);
		expect(container.querySelector("input")).toBe(input);
		await settle();
		expect(effectCleanups).toBe(1);
		expect(observers("details")).toBe(0);
		await render({ opened: true, realDrawer: true, label: "real reopen" });
		await settle();
		expect(container.querySelector("input")).toBe(input);
		expect(input?.value).toBe("real drawer draft");
		expect(container.querySelector("[data-label]")?.textContent).toBe("real reopen");
	});
});

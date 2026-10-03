import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IDockviewPanelProps } from "dockview-react";
import { parseHTML } from "linkedom";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { NarratorPanelProps } from "../narrator-panel-types";
import { FocusChatHost } from "./FocusChatHost";
import { NarratorDockProvider } from "./NarratorDockContext";

let mounts = 0;
let props: NarratorPanelProps;
function PanelProbe(value: NarratorPanelProps) {
	props = value;
	useEffect(() => {
		mounts++;
	}, []);
	return <textarea data-panel defaultValue="draft" />;
}
mock.module("../NarratorPanel", () => ({ NarratorPanel: PanelProbe }));
const { narratorDockComponents } = await import("./panels");
const Adapter = narratorDockComponents.chat;

let root: Root;
let client: QueryClient;
let host: HTMLElement;
let titles: string[];
const originals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	window.matchMedia = () =>
		({
			matches: false,
			addEventListener() {},
			removeEventListener() {},
		}) as unknown as MediaQueryList;
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		IS_REACT_ACT_ENVIRONMENT: true,
		ResizeObserver: class {
			observe() {}
			disconnect() {}
		},
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	mounts = 0;
	titles = [];
	client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	client.setQueryData(["narrators", "live"], { id: "live", title: "Live narrator" });
	host = document.body.appendChild(document.createElement("div"));
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	client.clear();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

const fork = () => {};
const back = () => {};
const minimize = () => {};
async function render(external: boolean, mobile = false) {
	const adapter = (
		<Adapter
			{...({
				params: { panelType: "chat", narratorId: "stale-serialized-id" },
				api: {
					id: "ndock-chat",
					title: "Chat",
					setTitle(title: string) {
						titles.push(title);
					},
				},
			} as unknown as IDockviewPanelProps)}
		/>
	);
	await act(async () => {
		root.render(
			<MantineProvider env="test" withCssVariables={false}>
				<QueryClientProvider client={client}>
					<NarratorDockProvider
						narratorId="live"
						onForkFromMessage={fork}
						highlightMessageId="deep-link"
						onBack={back}
						onMinimize={minimize}
					>
						{external ? (
							<FocusChatHost
								narratorId="live"
								isMobile={mobile}
								renderChat={(chrome) => <PanelProbe narratorId="live" {...chrome} />}
							>
								{!mobile && adapter}
							</FocusChatHost>
						) : (
							adapter
						)}
					</NarratorDockProvider>
				</QueryClientProvider>
			</MantineProvider>,
		);
	});
}

test("real dock adapter outside focus host retains its lazy Panel and page callbacks", async () => {
	await render(false);
	expect(mounts).toBe(1);
	expect(host.querySelectorAll("[data-panel]").length).toBe(1);
	expect(props.narratorId).toBe("live");
	expect(props.onForkFromMessage).toBe(fork);
	expect(props.highlightMessageId).toBe("deep-link");
	expect(props.onBack).toBe(back);
	expect(props.onMinimize).toBe(minimize);
	expect(typeof props.onHeaderPointerDown).toBe("function");
	expect(typeof props.onViewSubagentSession).toBe("function");
	expect(titles).toContain("Live narrator");
});

test("real dock adapter under focus host registers only a slot across desktop/mobile transitions", async () => {
	await render(true, false);
	const panel = host.querySelector("[data-panel]");
	const slot = host.querySelector("[data-focus-chat-slot]");
	expect(mounts).toBe(1);
	expect(typeof props.onHeaderPointerDown).toBe("function");
	expect(typeof props.onViewSubagentSession).toBe("function");
	await render(true, true);
	expect(host.querySelector("[data-panel]")).toBe(panel);
	expect(host.querySelector("[data-focus-chat-slot]")).toBeNull();
	expect(props.onHeaderPointerDown).toBeUndefined();
	expect(props.onViewSubagentSession).toBeUndefined();
	await render(true, false);
	expect(host.querySelector("[data-panel]")).toBe(panel);
	expect(host.querySelector("[data-focus-chat-slot]")).not.toBe(slot);
	expect(host.querySelectorAll("[data-panel]").length).toBe(1);
	expect(mounts).toBe(1);
	expect(titles).toContain("Live narrator");
});

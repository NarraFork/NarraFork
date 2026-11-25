import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import type { CommunicationScope } from "@shared/narrator-communication";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as router from "@tanstack/react-router";
import type { IDockviewPanelProps } from "dockview-react";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { act, type ReactNode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import enNarrator from "../../locales/en/narrator.json";
import enProjects from "../../locales/en/projects.json";
import { useNarratorPanelVisible } from "./narrator-panel-visibility";

let scopes: CommunicationScope[];
let subscriptions: number;
function TopologyProbe({
	scope,
	onOpenNarrator,
}: {
	scope: CommunicationScope;
	onOpenNarrator?: (id: string) => void;
}) {
	scopes.push(scope);
	const visible = useNarratorPanelVisible();
	useEffect(() => {
		if (!visible) return;
		subscriptions++;
		return () => {
			subscriptions--;
		};
	}, [visible]);
	return (
		<button type="button" data-topology onClick={() => onOpenNarrator?.("target")}>
			Open target
		</button>
	);
}
mock.module("./communication/CommunicationTopologyPanel", () => ({
	CommunicationTopologyPanel: TopologyProbe,
}));
mock.module("./NarratorPanel", () => ({ NarratorPanel: () => null }));
mock.module("../../hooks/useMobileDrawerHistory", () => ({ useMobileDrawerHistory: () => {} }));
const navigate = mock(() => Promise.resolve());
const navigateSpy = spyOn(router, "useNavigate").mockReturnValue(navigate);
afterAll(() => navigateSpy.mockRestore());
const { MobileToolPanelHost } = await import("./MobileToolPanelHost");
const { narratorDockComponents } = await import("./dock/panels");
const { NarratorDockProvider } = await import("./dock/NarratorDockContext");
const { workspacePanelComponents } = await import("./workspace/panels");
const { createWorkspaceDockStore, WorkspaceDockProvider } = await import(
	"./workspace/workspace-dock"
);
const { TeamTopBar } = await import("../teams/TeamTopBar");

let root: Root;
let client: QueryClient;
let i18n: ReturnType<typeof createInstance>;
const originals = new Map<string, PropertyDescriptor | undefined>();

beforeEach(async () => {
	const { window } = parseHTML("<!doctype html><html><head></head><body></body></html>");
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
	const getComputedStyle = () => ({
		getPropertyValue: () => "",
		display: "block",
		direction: "ltr",
	});
	window.matchMedia = matchMedia;
	window.getComputedStyle = getComputedStyle as unknown as typeof window.getComputedStyle;
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		HTMLElement: window.HTMLElement,
		Element: window.Element,
		Node: window.Node,
		Event: window.Event,
		getComputedStyle,
		ResizeObserver: class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
		requestAnimationFrame: (callback: FrameRequestCallback) =>
			setTimeout(() => callback(Date.now()), 0),
		cancelAnimationFrame: (handle: number) => clearTimeout(handle),
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	root = createRoot(document.body.appendChild(document.createElement("div")));
	client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	i18n = createInstance();
	await i18n.init({
		lng: "en",
		resources: { en: { narrator: enNarrator, projects: enProjects } },
		interpolation: { escapeValue: false },
	});
	scopes = [];
	subscriptions = 0;
	navigate.mockClear();
});

afterEach(async () => {
	await act(async () => root.unmount());
	expect(subscriptions).toBe(0);
	client.clear();
	for (const [key, descriptor] of originals) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	originals.clear();
});

async function render(node: ReactNode) {
	await act(async () => {
		root.render(
			<MantineProvider env="test" withCssVariables={false}>
				<QueryClientProvider client={client}>
					<I18nextProvider i18n={i18n}>{node}</I18nextProvider>
				</QueryClientProvider>
			</MantineProvider>,
		);
	});
}

async function click(selector: string) {
	const element = document.querySelector<HTMLElement>(selector);
	expect(element).not.toBeNull();
	await act(async () => element?.click());
}

function dockProps(params: Record<string, unknown>): IDockviewPanelProps {
	const listen = () => ({ dispose() {} });
	return {
		params,
		api: {
			id: "communication-host",
			title: "Communication topology",
			setTitle: mock(() => {}),
			close: mock(() => {}),
			isVisible: true,
			location: { type: "grid" },
			onDidLocationChange: listen,
			onDidVisibilityChange: listen,
		},
		containerApi: { onDidLayoutChange: listen },
	} as unknown as IDockviewPanelProps;
}

function visibilityProps(params: Record<string, unknown>) {
	const props = dockProps(params);
	const listeners = new Set<() => void>();
	const api = props.api as unknown as {
		isVisible: boolean;
		onDidVisibilityChange: (callback: () => void) => { dispose: () => void };
	};
	api.onDidVisibilityChange = (callback) => {
		listeners.add(callback);
		return {
			dispose: () => {
				listeners.delete(callback);
			},
		};
	};
	return {
		props,
		setVisible: async (visible: boolean) => {
			await act(async () => {
				api.isVisible = visible;
				for (const callback of listeners) callback();
			});
		},
	};
}

describe("communication topology hosts", () => {
	test("switching a dock tab releases only topology while the sibling composer stays mounted", async () => {
		const Adapter = narratorDockComponents.communication;
		const visibility = visibilityProps({ panelType: "communication", narratorId: "live" });
		await render(
			<NarratorDockProvider narratorId="live">
				<textarea data-persistent-composer defaultValue="keep this draft" />
				<Adapter {...visibility.props} />
			</NarratorDockProvider>,
		);
		const composer = document.querySelector("[data-persistent-composer]");
		expect(subscriptions).toBe(1);
		await visibility.setVisible(false);
		expect(subscriptions).toBe(0);
		expect(document.querySelector("[data-persistent-composer]")).toBe(composer);
		await visibility.setVisible(true);
		expect(subscriptions).toBe(1);
		expect(document.querySelector("[data-persistent-composer]")).toBe(composer);
	});

	test("workspace tool visibility uses the same dock lifecycle", async () => {
		const Adapter = workspacePanelComponents["narrator-tool"];
		const visibility = visibilityProps({
			panelType: "narrator-tool",
			toolType: "communication",
			narratorId: "workspace-narrator",
		});
		const store = createWorkspaceDockStore({ current: null });
		await render(
			<WorkspaceDockProvider store={store} workspaceId="workspace">
				<Adapter {...visibility.props} />
			</WorkspaceDockProvider>,
		);
		expect(subscriptions).toBe(1);
		await visibility.setVisible(false);
		expect(subscriptions).toBe(0);
		await visibility.setVisible(true);
		expect(subscriptions).toBe(1);
	});
	test("dock registry hosts the live narrator identity rather than the saved one", async () => {
		const Adapter = narratorDockComponents.communication;
		await render(
			<NarratorDockProvider narratorId="live">
				<Adapter {...dockProps({ panelType: "communication", narratorId: "stale" })} />
			</NarratorDockProvider>,
		);
		expect(scopes.at(-1)).toEqual({ kind: "narrator", narratorId: "live" });
		expect(subscriptions).toBe(1);
		await click("[data-topology]");
		expect(navigate).toHaveBeenCalledWith({
			to: "/narrators/$narratorId",
			params: { narratorId: "target" },
		});
	});

	test("workspace narrator-tool registry delegates to the same panel", async () => {
		const Adapter = workspacePanelComponents["narrator-tool"];
		const store = createWorkspaceDockStore({ current: null });
		await render(
			<WorkspaceDockProvider store={store} workspaceId="workspace">
				<Adapter
					{...dockProps({
						panelType: "narrator-tool",
						toolType: "communication",
						narratorId: "workspace-narrator",
					})}
				/>
			</WorkspaceDockProvider>,
		);
		expect(scopes.at(-1)).toEqual({ kind: "narrator", narratorId: "workspace-narrator" });
		expect(subscriptions).toBe(1);
	});

	test("mobile opens narrator scope, closes before navigation and releases on close", async () => {
		const close = mock(() => {});
		await render(<MobileToolPanelHost kind="communication" narratorId="mobile" onClose={close} />);
		expect(scopes.at(-1)).toEqual({ kind: "narrator", narratorId: "mobile" });
		expect(subscriptions).toBe(1);
		await click("[data-topology]");
		expect(close).toHaveBeenCalledTimes(1);
		expect(navigate).toHaveBeenCalledWith({
			to: "/narrators/$narratorId",
			params: { narratorId: "target" },
		});
		await render(<MobileToolPanelHost kind={null} narratorId="mobile" onClose={close} />);
		expect(document.querySelector("[data-topology]")).toBeNull();
		expect(subscriptions).toBe(0);
	});

	test("team onlookers open team scope and session navigation unmounts it", async () => {
		const openSession = mock(() => {});
		await render(
			<TeamTopBar
				projectId="project"
				teamId="team"
				title="Team"
				summary={undefined}
				onOpenSession={openSession}
			/>,
		);
		expect(subscriptions).toBe(0);
		await click('[data-testid="team-communication-button"]');
		expect(scopes.at(-1)).toEqual({ kind: "team", projectId: "project", teamId: "team" });
		expect(subscriptions).toBe(1);
		await click("[data-topology]");
		expect(openSession).toHaveBeenCalledWith("target");
		expect(subscriptions).toBe(0);
		expect(document.querySelector("[data-topology]")).toBeNull();
	});
});

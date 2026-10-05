import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import type { NarratorPanelProps } from "../narrator/narrator-panel-types";
import type { PluginUiSessionContext } from "../plugins/PluginUiSurfaceContext";
import { RuntimeContext, type RuntimeContextValue } from "../plugins/plugin-ui-runtime-context";
import type { PluginDockPanelParams } from "../plugins/protocol";
import type { PanelWindowDescriptor } from "./panel-window";

const i18n = i18next.createInstance();
await i18n.init({ lng: "en", resources: { en: { plugins: {} } }, initImmediate: false });
const navigate = mock(() => {});
const close = mock(() => {});
const recent = mock(() => {});
const router = await import("@tanstack/react-router");
mock.module("@tanstack/react-router", () => ({ ...router, useNavigate: () => navigate }));
const recentTabs = await import("../../hooks/useRecentTabs");
mock.module("../../hooks/useRecentTabs", () => ({ ...recentTabs, addSubagentRecentTab: recent }));
mock.module("../../lib/narrator-ws-manager", () => ({
	narratorWSManager: { connect() {}, disconnect() {} },
}));
mock.module("../StandaloneWindowLayout", () => ({ useStandaloneWindowTitle() {} }));
function ChatProbe(props: NarratorPanelProps) {
	return (
		<div data-chat style={{ height: "100%", minHeight: 0 }}>
			<button type="button" data-open onClick={props.onOpenStandalonePage}>
				open
			</button>
			<button type="button" data-close onClick={props.onClose}>
				close
			</button>
		</div>
	);
}
mock.module("../narrator/NarratorPanel", () => ({ NarratorPanel: ChatProbe }));
mock.module("../terminal/NarratorTerminal", () => ({
	NarratorTerminal: () => <div data-terminal style={{ height: "100%", minHeight: 0 }} />,
}));
// Load the real view before mounting so the first assertion is not a lazy-import race.
await import("../plugins/PluginDockPanel");
const { StandalonePanelWindow } = await import("./StandalonePanelWindow");
const { SubagentSessionPanelContent } = await import("../narrator/dock/panels");

let root: Root;
let client: QueryClient;
let container: HTMLElement;
const originals = new Map<string, PropertyDescriptor | undefined>();
const sessions: Array<{ params: PluginDockPanelParams; context: PluginUiSessionContext }> = [];
let delegate: { updateParams: (patch: Partial<PluginDockPanelParams>) => void } | undefined;
const contribution = {
	pluginId: "p1",
	contributionId: "c1",
	title: "Plugin",
	pluginName: "Plugin",
	status: "available",
};
const runtime = {
	resolveContribution: () => contribution,
	getSessionSnapshot: () => ({ status: "error", error: "test snapshot" }),
	getSessionController: () => undefined,
	ensureSession: (
		params: PluginDockPanelParams,
		_contribution: unknown,
		context: PluginUiSessionContext,
	) => {
		sessions.push({ params, context });
	},
	updateSessionParams() {},
	registerSlot: () => () => {},
	updateSlot() {},
	disposeSession() {},
	registerPanelDelegate: (_id: string, value: typeof delegate) => {
		delegate = value;
		return () => {};
	},
} as unknown as RuntimeContextValue;

beforeEach(() => {
	const { window } = parseHTML("<!doctype html><html><body></body></html>");
	Object.assign(window, {
		close,
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	});
	for (const [key, value] of Object.entries({
		window,
		document: window.document,
		navigator: window.navigator,
		Event: window.Event,
		IS_REACT_ACT_ENVIRONMENT: true,
	})) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	navigate.mockReset();
	close.mockClear();
	recent.mockClear();
	sessions.length = 0;
	delegate = undefined;
	client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
	client.setQueryData(["narrators", "n1"], {
		id: "n1",
		title: "Narrator",
		chapterId: null,
		traits: [],
	});
	client.setQueryData(["narrators", "child"], {
		id: "child",
		title: "Child",
		parentNarratorId: "n1",
		chapterId: null,
		traits: [],
	});
	client.setQueryData(["user-preferences"], { addSubagentToRecentTabs: true });
	container = document.body.appendChild(document.createElement("div"));
	root = createRoot(container);
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

async function render(content: React.ReactNode) {
	await act(async () => {
		root.render(
			<MantineProvider env="test" withCssVariables={false}>
				<QueryClientProvider client={client}>
					<I18nextProvider i18n={i18n}>
						<RuntimeContext.Provider value={runtime}>{content}</RuntimeContext.Provider>
					</I18nextProvider>
				</QueryClientProvider>
			</MantineProvider>,
		);
	});
}

const plugin: PluginDockPanelParams = {
	panelType: "plugin",
	schemaVersion: 1,
	pluginId: "p1",
	contributionId: "c1",
	panelInstanceId: "i1",
	binding: { kind: "focus-current-narrator", narratorId: "n1" },
};

describe("standalone window DOM height contract (not visual layout)", () => {
	test.each(["0px", "32px"])("bounds chat and terminal under a %s WCO strip", async (strip) => {
		container.style.setProperty("--nf-wco-strip-height", strip);
		const descriptors: PanelWindowDescriptor[] = [
			{ panelType: "chat", narratorId: "n1" },
			{ panelType: "terminal", narratorId: "n1" },
		];
		for (const descriptor of descriptors) {
			await render(<StandalonePanelWindow descriptor={descriptor} />);
			const host = container.querySelector<HTMLElement>(".nf-panel-window");
			expect(host?.style.height).toBe("calc(100% - var(--nf-wco-strip-height, 0px))");
			expect(host?.style.minHeight).toBe("0");
			expect(host?.style.overflow).toBe("hidden");
			expect(host?.querySelector<HTMLElement>(`[data-${descriptor.panelType}]`)?.style.height).toBe(
				"100%",
			);
		}
	});
});

describe("real plugin view inside standalone host", () => {
	test("receives a surface context but never passes hostContext to strict rawParams", async () => {
		const context: PluginUiSessionContext = {
			surface: "focus",
			narratorId: "n1",
			chapterId: null,
			projectId: "project1",
		};
		await render(
			<StandalonePanelWindow
				descriptor={{ ...plugin, hostContext: context } as PanelWindowDescriptor}
			/>,
		);
		expect(sessions.length).toBeGreaterThan(0);
		expect(sessions.at(-1)?.context).toEqual(context);
		expect(sessions.at(-1)?.params).toEqual(plugin);
		expect(delegate).toBeDefined();
		await act(async () => {
			delegate?.updateParams({ viewState: { draft: "changed" } });
		});
		expect(sessions.at(-1)?.params.viewState).toEqual({ draft: "changed" });
		expect(sessions.at(-1)?.context.narratorId).toBe("n1");
	});

	test("descriptor navigation resets plugin params together with its host context", async () => {
		await render(
			<StandalonePanelWindow
				descriptor={{ ...plugin, hostContext: { surface: "focus", narratorId: "n1" } }}
			/>,
		);
		expect(sessions.at(-1)?.params.panelInstanceId).toBe("i1");
		const next: PanelWindowDescriptor = {
			...plugin,
			pluginId: "p2",
			contributionId: "c2",
			panelInstanceId: "i2",
			binding: { kind: "global" },
			hostContext: { surface: "settings" },
		};
		sessions.length = 0;
		await render(<StandalonePanelWindow descriptor={next} />);
		expect(sessions.at(-1)?.params.panelInstanceId).toBe("i2");
		expect(sessions.at(-1)?.params.pluginId).toBe("p2");
		expect(sessions.at(-1)?.context).toEqual({ surface: "settings" });
	});

	const explicitContexts: Array<{
		binding: PluginDockPanelParams["binding"];
		hostContext: PluginUiSessionContext;
	}> = [
		{
			binding: { kind: "workspace", workspaceId: "w1" },
			hostContext: { surface: "workspace", workspaceId: "w1", presentation: "grid" },
		},
		{
			binding: { kind: "workspace-narrator", workspaceId: "w1", ownerNarratorId: "n1" },
			hostContext: {
				surface: "director",
				workspaceId: "w1",
				narratorId: "n1",
				presentation: "director",
			},
		},
		{ binding: { kind: "global" }, hostContext: { surface: "settings" } },
		{
			binding: { kind: "host-surface", surface: "focus" },
			hostContext: { surface: "graph", narratorId: "n1", projectId: "_project" },
		},
		{
			binding: { kind: "host-surface", surface: "provider-settings" },
			hostContext: { surface: "provider-settings" },
		},
	];
	test.each(explicitContexts)("mounts actual plugin view with explicit context: %j", async ({
		binding,
		hostContext,
	}) => {
		await render(<StandalonePanelWindow descriptor={{ ...plugin, binding, hostContext }} />);
		expect(sessions.length).toBeGreaterThan(0);
		expect(sessions.at(-1)?.context).toEqual(hostContext);
		expect(sessions.at(-1)?.params).toEqual({ ...plugin, binding });
	});

	test.each([
		{
			binding: { kind: "focus-current-narrator", narratorId: "n1" },
			context: { surface: "focus", narratorId: "n1" },
		},
		{
			binding: { kind: "workspace", workspaceId: "w1" },
			context: { surface: "workspace", workspaceId: "w1" },
		},
		{
			binding: { kind: "workspace-narrator", workspaceId: "w1", ownerNarratorId: "n1" },
			context: { surface: "workspace", workspaceId: "w1", narratorId: "n1" },
		},
		{ binding: { kind: "global" }, context: { surface: "settings" } },
	])("derives only explicit legacy binding context: %j", async ({ binding, context }) => {
		await render(
			<StandalonePanelWindow descriptor={{ ...plugin, binding } as PanelWindowDescriptor} />,
		);
		expect(sessions.length).toBeGreaterThan(0);
		expect(sessions.at(-1)?.context).toMatchObject(context);
	});

	test.each([
		{ kind: "focus-current-narrator" },
		{ kind: "host-surface", surface: "focus" },
		{ kind: "host-surface", surface: "workspace" },
	])("does not invent missing legacy host identity: %j", async (binding) => {
		await render(
			<StandalonePanelWindow descriptor={{ ...plugin, binding } as PanelWindowDescriptor} />,
		);
		expect(sessions).toHaveLength(0);
	});
});

describe("subagent navigation", () => {
	test("window navigates to chapterless child without closing, but close button still closes", async () => {
		await render(
			<StandalonePanelWindow descriptor={{ panelType: "subagent", subagentNarratorId: "child" }} />,
		);
		await act(async () => {
			container.querySelector("[data-open]")?.dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(navigate).toHaveBeenCalledWith({
			to: "/narrators/$narratorId",
			params: { narratorId: "child" },
		});
		expect(close).not.toHaveBeenCalled();
		expect(recent).toHaveBeenCalledTimes(1);
		await act(async () => {
			container.querySelector("[data-close]")?.dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(close).toHaveBeenCalledTimes(1);
	});

	test("normal dock content keeps close-before-navigation and recents", async () => {
		const order: string[] = [];
		navigate.mockImplementation(() => {
			order.push("navigate");
		});
		await render(
			<SubagentSessionPanelContent
				subagentNarratorId="child"
				compact={false}
				onClose={() => order.push("close")}
			/>,
		);
		await act(async () => {
			container.querySelector("[data-open]")?.dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(order).toEqual(["close", "navigate"]);
		expect(recent).toHaveBeenCalledTimes(1);
	});
});

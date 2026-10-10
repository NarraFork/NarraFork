import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DockviewDefaultTab, type IDockviewPanelHeaderProps } from "dockview-react";
import i18next from "i18next";
import { parseHTML } from "linkedom";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { api } from "../../lib/api";
import commonLocale from "../../locales/en/common.json";
import {
	type PluginUiSessionContext,
	PluginUiSurfaceProvider,
	usePluginUiSurface,
} from "../plugins/PluginUiSurfaceContext";
import { parsePanelWindowDescriptor } from "../window/panel-window";
import { DefaultSurfaceTab, fileTabRevealDirectory, withSurfaceTabMenu } from "./SurfaceTab";

function queryClient(platform = "windows") {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(["health"], { platform });
	client.setQueryData(["user-preferences"], { treatAsLocalAccess: false });
	return client;
}

function ChatTab(props: IDockviewPanelHeaderProps) {
	return <span data-custom-tab>{props.api.title}</span>;
}

describe("shared surface tab wrapper", () => {
	it("keeps stable identities for both default and custom renderers", () => {
		expect(withSurfaceTabMenu(DockviewDefaultTab)).toBe(DefaultSurfaceTab);
		expect(withSurfaceTabMenu(ChatTab)).toBe(withSurfaceTabMenu(ChatTab));
		expect(withSurfaceTabMenu(ChatTab)).not.toBe(DefaultSurfaceTab);
	});
	it("preserves a custom close-less tab and forwards its props", () => {
		const Tab = withSurfaceTabMenu(ChatTab);
		const props = { api: { title: "Protagonist" } } as IDockviewPanelHeaderProps;
		const i18n = i18next.createInstance();
		void i18n.init({ lng: "en", resources: { en: { common: {} } }, initImmediate: false });
		const client = queryClient();
		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<I18nextProvider i18n={i18n}>
					<Tab {...props} />
				</I18nextProvider>
			</QueryClientProvider>,
		);
		client.clear();
		expect(html).toContain("Protagonist");
		expect(html).toContain("data-custom-tab");
		expect(html).not.toContain("button");
	});
});

describe("file tab reveal directory", () => {
	it("handles Windows, macOS and Linux paths including spaces, Unicode and root files", () => {
		for (const [filePath, platform, expected] of [
			["C:\\工作目录\\file name.ts", "windows", "C:/工作目录"],
			["C:/file.ts", "windows", "C:/"],
			["/Users/me/工作目录/file name.ts", "macos", "/Users/me/工作目录"],
			["/file.ts", "macos", "/"],
			["/home/me/工作目录/file name.ts", "linux", "/home/me/工作目录"],
			["/file.ts", "linux", "/"],
			["/workspace/project#1/a.ts", "linux", "/workspace/project#1"],
			["C:\\project#1\\a.ts", "windows", "C:/project#1"],
			["/workspace/project#L12/a.ts", "macos", "/workspace/project#L12"],
			["/workspace/file#1.ts", "linux", "/workspace"],
			["/workspace/project:12/a.ts:34", "linux", "/workspace/project:12"],
			["/workspace/project\\name/a.ts", "linux", "/workspace/project\\name"],
		]) {
			expect(fileTabRevealDirectory({ panelType: "file", filePath }, platform, true)).toBe(
				expected,
			);
		}
	});

	it("excludes remote browsers, remote devices, unsupported platforms and non-file resources", () => {
		const params = { panelType: "file", filePath: "/workspace/file.ts" };
		expect(fileTabRevealDirectory(params, "macos", false)).toBeNull();
		expect(fileTabRevealDirectory(params, "unknown", true)).toBeNull();
		expect(fileTabRevealDirectory({ ...params, deviceId: "remote" }, "macos", true)).toBeNull();
		expect(fileTabRevealDirectory({ ...params, panelType: "spec" }, "macos", true)).toBeNull();
		for (const filePath of ["spec://tasks.json", "src/file.ts", "", "/bad\u0000/file.ts"]) {
			expect(fileTabRevealDirectory({ ...params, filePath }, "macos", true)).toBeNull();
		}
		expect(fileTabRevealDirectory(undefined, "macos", true)).toBeNull();
	});
});

let root: Root | undefined;
let client: QueryClient | undefined;
let restoreDom: (() => void) | undefined;
let revealSpy: ReturnType<typeof spyOn<typeof api, "fsReveal">> | undefined;
let notifySpy: ReturnType<typeof spyOn<typeof notifications, "show">> | undefined;

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = undefined;
	client?.clear();
	client = undefined;
	revealSpy?.mockRestore();
	notifySpy?.mockRestore();
	restoreDom?.();
	restoreDom = undefined;
});

async function mountTab(
	options: {
		platform?: string;
		hostname?: string;
		params?: Record<string, unknown>;
		treatAsLocalAccess?: boolean;
		hostContext?: PluginUiSessionContext;
		sessionContext?: PluginUiSessionContext;
	} = {},
) {
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
	Object.assign(window, {
		location: { hostname: options.hostname ?? "localhost" },
		matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
	});
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
	const testClient = queryClient(options.platform);
	testClient.setQueryData(["user-preferences"], {
		treatAsLocalAccess: options.treatAsLocalAccess ?? false,
	});
	client = testClient;
	const i18n = i18next.createInstance();
	await i18n.init({ lng: "en", resources: { en: { common: commonLocale } }, initImmediate: false });
	const container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	const Tab = withSurfaceTabMenu(ChatTab);
	const props = {
		api: { id: "file-one", title: "file.ts" },
		containerApi: { getPanel: () => undefined },
		params: options.params ?? { panelType: "file", filePath: "C:\\工作目录\\file name.ts" },
	} as unknown as IDockviewPanelHeaderProps;
	await act(async () => {
		root?.render(
			<QueryClientProvider client={testClient}>
				<I18nextProvider i18n={i18n}>
					<MantineProvider env="test">
						{options.hostContext ? (
							<PluginUiSurfaceProvider hostContext={options.hostContext}>
								<SessionSeed context={options.sessionContext} />
								<Tab {...props} />
							</PluginUiSurfaceProvider>
						) : (
							<Tab {...props} />
						)}
					</MantineProvider>
				</I18nextProvider>
			</QueryClientProvider>,
		);
	});
	await act(async () => {
		container
			.querySelector("[data-custom-tab]")
			?.dispatchEvent(new window.Event("contextmenu", { bubbles: true, cancelable: true }));
	});
}

function SessionSeed({ context }: { context?: PluginUiSessionContext }) {
	const surface = usePluginUiSurface();
	useEffect(() => {
		if (context) surface?.setSessionContext("i1", context);
	}, [context, surface]);
	return null;
}

function windowItem() {
	return Array.from(document.querySelectorAll("[role=menuitem]")).find(
		(item) => item.textContent?.trim() === commonLocale.dockTabs.openInWindow,
	);
}

function revealItem() {
	return Array.from(document.querySelectorAll("[role=menuitem]")).find(
		(item) => item.textContent?.trim() === commonLocale.dockTabs.revealInExplorer,
	);
}

describe("tab git identity entry removed", () => {
	it("does not offer identity selection on a narrator tab", async () => {
		await mountTab({ params: { panelType: "narrator", narratorId: "n1" } });
		const items = Array.from(document.querySelectorAll("[role=menuitem]"));
		expect(items.some((item) => item.textContent?.includes("Git commit identity"))).toBe(false);
	});
});

describe("plugin tab window context", () => {
	const plugin = {
		panelType: "plugin",
		schemaVersion: 1,
		pluginId: "p1",
		contributionId: "c1",
		panelInstanceId: "i1",
		binding: { kind: "focus-current-narrator" },
	} as const;
	it("copies actual resolved session context and fixes the current narrator binding", async () => {
		const sessionContext: PluginUiSessionContext = {
			surface: "focus",
			narratorId: "actual",
			chapterId: "chapter1",
			projectId: "project1",
		};
		await mountTab({
			params: plugin,
			hostContext: { surface: "focus", narratorId: "host" },
			sessionContext,
		});
		expect(windowItem()).toBeDefined();
		const calls: string[] = [];
		Object.defineProperty(window, "open", {
			configurable: true,
			value: (href: string) => {
				calls.push(href);
				return null;
			},
		});
		await act(async () => {
			windowItem()?.dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(calls).toHaveLength(1);
		const json = new URL(calls[0] ?? "", "https://example.test").searchParams.get("d");
		expect(parsePanelWindowDescriptor(json ?? undefined)).toEqual({
			...plugin,
			binding: { kind: "focus-current-narrator", narratorId: "actual" },
			hostContext: sessionContext,
		});
	});

	it("opens workspace plugin params after dropping panelRowId", async () => {
		await mountTab({
			params: { ...plugin, binding: { kind: "workspace", workspaceId: "w1" }, panelRowId: "row1" },
			hostContext: { surface: "workspace", workspaceId: "w1" },
		});
		expect(windowItem()).toBeDefined();
	});

	it("offers legal large plugin state", async () => {
		await mountTab({
			params: { ...plugin, binding: { kind: "global" }, viewState: { text: "x".repeat(9000) } },
			hostContext: { surface: "settings" },
		});
		expect(Boolean(windowItem())).toBe(true);
	});

	it("hides descriptors beyond the shared UTF-8 budget", async () => {
		await mountTab({ params: { panelType: "file", filePath: `/${"界".repeat(11000)}` } });
		expect(Boolean(windowItem())).toBe(false);
	});

	it("does not guess a narrator identity without a source surface or binding", async () => {
		await mountTab({ params: plugin });
		expect(Boolean(windowItem())).toBe(false);
	});
});

describe("file tab context menu", () => {
	it("opens the containing directory, closes the menu and retains close actions", async () => {
		revealSpy = spyOn(api, "fsReveal").mockResolvedValue({ ok: true });
		await mountTab();
		// openInWindow + reveal + the four close actions.
		expect(document.querySelectorAll("[role=menuitem]").length).toBe(6);
		expect(revealItem()).toBeDefined();
		await act(async () => {
			revealItem()?.dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(revealSpy).toHaveBeenCalledWith("C:/工作目录");
		expect(revealItem()).toBeUndefined();
	});

	it("shows the action on Linux and sends the containing directory", async () => {
		revealSpy = spyOn(api, "fsReveal").mockResolvedValue({ ok: true });
		await mountTab({
			platform: "linux",
			params: { panelType: "file", filePath: "/home/me/工作目录/file name.ts" },
		});
		expect(revealItem()).toBeDefined();
		await act(async () => {
			revealItem()?.dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(revealSpy).toHaveBeenCalledWith("/home/me/工作目录");
	});

	it("updates the open menu when a domain user's override is toggled", async () => {
		await mountTab({ hostname: "narrafork.example.com" });
		expect(revealItem()).toBeUndefined();
		await act(async () => {
			client?.setQueryData(["user-preferences"], { treatAsLocalAccess: true });
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(revealItem()).toBeDefined();
		await act(async () => {
			client?.setQueryData(["user-preferences"], { treatAsLocalAccess: false });
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(revealItem()).toBeUndefined();
	});

	it.each([
		{ panelType: "file", filePath: "/home/me/file.ts", deviceId: "remote" },
		{ panelType: "file", filePath: "spec://tasks.json" },
		{ panelType: "file", filePath: "src/file.ts" },
	])("opt-in does not permit remote-device, virtual or relative files: %j", async (params) => {
		await mountTab({ hostname: "narrafork.example.com", treatAsLocalAccess: true, params });
		expect(revealItem()).toBeUndefined();
	});

	it("reports reveal failures instead of silently swallowing them", async () => {
		revealSpy = spyOn(api, "fsReveal").mockRejectedValue(new Error("Directory does not exist"));
		notifySpy = spyOn(notifications, "show").mockImplementation(() => "notice");
		await mountTab();
		await act(async () => {
			revealItem()?.dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(notifySpy).toHaveBeenCalledWith({
			color: "red",
			title: commonLocale.dockTabs.revealFailed,
			message: "Directory does not exist",
		});
	});

	it.each([
		// reveal hidden; the file/chat panel still opens in a window (+1 item)…
		{ options: { hostname: "example.com" }, items: 5 },
		{ options: { platform: "unknown" }, items: 5 },
		{
			options: { params: { panelType: "file", filePath: "C:/file.ts", deviceId: "remote" } },
			items: 5,
		},
		// …except a panel whose params carry no identity (chat without narratorId).
		{ options: { params: { panelType: "chat" } }, items: 4 },
		{ options: { params: { panelType: "file", filePath: "spec://tasks.json" } }, items: 5 },
	])("hides the action when unavailable: %j", async ({ options, items }) => {
		revealSpy = spyOn(api, "fsReveal").mockResolvedValue({ ok: true });
		await mountTab(options);
		expect(revealItem()).toBeUndefined();
		expect(document.querySelectorAll("[role=menuitem]").length).toBe(items);
		expect(revealSpy).not.toHaveBeenCalled();
	});

	it("offers the panel in an external window, unless it is the mock harness", async () => {
		await mountTab();
		const openCalls: string[] = [];
		Object.defineProperty(window, "open", {
			configurable: true,
			writable: true,
			value: (href: string) => {
				openCalls.push(href);
				return null;
			},
		});
		await mountTab();
		const item = Array.from(document.querySelectorAll("[role=menuitem]")).find(
			(entry) => entry.textContent?.trim() === commonLocale.dockTabs.openInWindow,
		);
		expect(item).toBeDefined();
		await act(async () => {
			item?.dispatchEvent(new Event("click", { bubbles: true }));
		});
		expect(openCalls).toHaveLength(1);
		expect(openCalls[0]).toContain("/windows/panel?d=");
		expect(decodeURIComponent(openCalls[0] ?? "")).toContain("file name.ts");

		// The debug streaming harness is never windowable.
		await mountTab({ params: { panelType: "mock", narratorId: "n1" } });
		expect(
			Array.from(document.querySelectorAll("[role=menuitem]")).find(
				(entry) => entry.textContent?.trim() === commonLocale.dockTabs.openInWindow,
			),
		).toBeUndefined();
	});
});

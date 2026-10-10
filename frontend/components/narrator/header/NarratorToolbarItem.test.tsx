import { afterEach, describe, expect, mock, test } from "bun:test";
import { ActionIcon, Indicator, MantineProvider, Menu } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { parseHTML } from "linkedom";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import {
	PluginContributionOptions,
	PluginContributionPicker,
} from "../../plugins/PluginContributionPicker";
import { pluginContributionStore } from "../../plugins/PluginContributionStore";
import {
	type PluginUiHostSurface,
	PluginUiSurfaceProvider,
} from "../../plugins/PluginUiSurfaceContext";
import { clearPluginUiContributions } from "../../plugins/registry";
import {
	type BuildMobileToolbarActionsOptions,
	buildMobileToolbarActions,
} from "../interaction/mobile-toolbar-actions";
import { PathRulesPopover } from "../interaction/PathRulesPopover";
import { resolveNarratorStatusToolbarOverflow } from "./NarratorStatusToolbar";
import {
	buildBottomToolbarActions,
	NarratorToolbarItem,
	type NarratorToolbarItemProps,
} from "./NarratorToolbarItem";
import { NARRATOR_TOOLBAR_ITEMS } from "./narrator-toolbar-items";

afterEach(() => clearPluginUiContributions());

function renderItem(props: NarratorToolbarItemProps, surface?: PluginUiHostSurface) {
	const result: { value?: ReturnType<typeof NarratorToolbarItem> } = {};
	function Probe() {
		result.value = NarratorToolbarItem(props);
		return null;
	}
	renderToStaticMarkup(
		surface ? (
			<PluginUiSurfaceProvider
				hostContext={{ surface, narratorId: props.narratorId, workspaceId: "workspace-a" }}
			>
				<Probe />
			</PluginUiSurfaceProvider>
		) : (
			<Probe />
		),
	);
	if (!result.value) throw new Error("Toolbar item did not render");
	return result.value;
}

function makeProps(): Omit<NarratorToolbarItemProps, "def"> {
	return {
		narratorId: "narrator-a",
		controller: {
			toolbarOverlays: null,
			toolbarEntries: [],
			toolbarSurfacedDefs: [],
			toolbarTuckedDefs: [],
			toolbarBottomDefs: [],
			saveToolbarLayout: mock(() => {}),
			toolbarEntryActive: mock(() => true),
			activateToolbarEntry: mock(() => {}),
			renderToolbarInlineOptions: mock(() => <Menu.Item>option</Menu.Item>),
		},
		inlineControls: {
			executionDevicesQuery: { data: { devices: [] } },
			updateExecutionDeviceMutation: { isPending: false, mutate: mock(() => {}) },
			renderLod: 4,
			renderLodIsDefault: true,
			handleSelectLod: mock(() => {}),
			setAsDefault: mock(() => {}),
			openPluginPanel: mock(() => {}),
		},
		toolbarBadgeCounts: { backgroundTasks: 0, browserSessions: 0, userChatUnread: 0, terminals: 2 },
		t: (key) => key,
	};
}
function def(id: string) {
	const result = NARRATOR_TOOLBAR_ITEMS.find((item) => item.id === id);
	if (!result) throw new Error(id);
	return result;
}
function elementOf(
	node: ReactNode,
	type: unknown,
): ReactElement<Record<string, unknown>> | undefined {
	if (!isValidElement<{ children?: ReactNode }>(node)) return undefined;
	if (node.type === type) return node as ReactElement<Record<string, unknown>>;
	for (const child of Children.toArray(node.props.children)) {
		const found = elementOf(child, type);
		if (found) return found;
	}
}

describe("shared bottom toolbar actions", () => {
	test("live surface still filters undeclared views and unsatisfiable scopes and disables denied views", () => {
		const i18n = createInstance();
		void i18n.init({ lng: "en", resources: { en: { plugins: {} } }, initImmediate: false });
		const shared = {
			pluginId: "fixture",
			version: "1.0.0",
			hash: "a".repeat(64),
			status: "available" as const,
		};
		pluginContributionStore.applySnapshot([
			{
				...shared,
				contributionId: "workspace",
				title: "Workspace-only view",
				scope: "workspace",
				surfaces: ["workspace", "director"],
			},
			{
				...shared,
				contributionId: "focus",
				title: "Focus-only view",
				scope: "narrator",
				surfaces: ["focus", "graph"],
			},
			{
				...shared,
				contributionId: "invalid-scope",
				title: "Missing scope context",
				scope: "project",
				surfaces: ["workspace", "director", "focus", "graph"],
			},
			{
				...shared,
				contributionId: "denied",
				title: "Denied view",
				scope: "global",
				surfaces: ["workspace", "director", "focus", "graph"],
				status: "denied",
			},
		]);
		for (const surface of ["workspace", "director", "focus", "graph"] as const) {
			const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
			const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
			try {
				Object.defineProperty(globalThis, "localStorage", {
					configurable: true,
					value: { getItem: () => null },
				});
				const picker = elementOf(
					renderItem({ ...makeProps(), def: def("plugins") }, surface),
					PluginContributionPicker,
				);
				const markup = renderToStaticMarkup(
					<MantineProvider>
						<QueryClientProvider client={client}>
							<I18nextProvider i18n={i18n}>
								<Menu>
									<PluginContributionOptions
										surface={picker?.props.surface as PluginUiHostSurface}
										onPick={() => {}}
									/>
								</Menu>
							</I18nextProvider>
						</QueryClientProvider>
					</MantineProvider>,
				);
				const { document } = parseHTML(markup);
				const rows = Array.from(document.querySelectorAll('[role="menuitem"]'));
				const labels = rows.map((row) => row.textContent ?? "");
				const workspaceFamily = surface === "workspace" || surface === "director";
				expect(labels.some((label) => label.includes("Workspace-only view"))).toBe(workspaceFamily);
				expect(labels.some((label) => label.includes("Focus-only view"))).toBe(!workspaceFamily);
				expect(labels.some((label) => label.includes("Missing scope context"))).toBe(false);
				const denied = rows.find((row) => row.textContent?.includes("Denied view"));
				expect(denied).toBeDefined();
				expect(denied?.hasAttribute("disabled") || denied?.hasAttribute("data-disabled")).toBe(
					true,
				);
			} finally {
				client.clear();
				if (storage) Object.defineProperty(globalThis, "localStorage", storage);
				else Reflect.deleteProperty(globalThis, "localStorage");
			}
		}
	});

	test("plugin picker follows the live host surface and defaults to focus without a provider", () => {
		const props = { ...makeProps(), def: def("plugins") };
		for (const surface of ["workspace", "director", "focus", "graph"] as const) {
			const picker = elementOf(renderItem(props, surface), PluginContributionPicker);
			expect(picker?.props.surface).toBe(surface);
			expect(picker?.props.onPick).toBe(props.inlineControls.openPluginPanel);
		}
		expect(elementOf(renderItem(props), PluginContributionPicker)?.props.surface).toBe("focus");
	});

	test("service-only toolbar remains visible without processing pulse and mixed work pulses", () => {
		const props = makeProps();
		props.toolbarBadgeCounts = {
			...props.toolbarBadgeCounts,
			backgroundTasks: 2,
			backgroundWork: 0,
			backgroundServices: 2,
		};
		props.t = (key, opts) =>
			key === "backgroundTasks.activeKinds"
				? `${opts?.work} tasks, ${opts?.services} services`
				: key;
		const service = renderItem({ ...props, def: def("tasks") });
		expect(elementOf(service, Indicator)?.props.processing).toBeFalse();
		expect(elementOf(service, Indicator)?.props.label).toBe("2");
		expect(elementOf(service, ActionIcon)?.props["aria-label"]).toContain("0 tasks, 2 services");
		props.toolbarBadgeCounts.backgroundWork = 1;
		const mixed = renderItem({ ...props, def: def("tasks") });
		expect(elementOf(mixed, Indicator)?.props.processing).toBeTrue();
	});

	test("preserves saved order and delegates both presentations to one controller", () => {
		const props = makeProps();
		const actions = buildBottomToolbarActions({
			...props,
			defs: [def("git"), def("terminal"), def("path-rules")],
		});
		expect(actions.map((action) => action.key)).toEqual(["git", "terminal", "path-rules"]);
		for (const mode of ["inline", "menu"] as const) {
			const element = actions[0].render(mode) as ReactElement<NarratorToolbarItemProps>;
			expect(element.props.controller).toBe(props.controller);
			const rendered = renderItem(element.props);
			const button = elementOf(rendered, mode === "inline" ? ActionIcon : Menu.Item);
			expect(button).toBeDefined();
			(button?.props.onClick as () => void)();
		}
		expect(props.controller.activateToolbarEntry).toHaveBeenCalledTimes(2);
		expect(props.controller.activateToolbarEntry).toHaveBeenLastCalledWith("git");
	});
	test("keeps active styling, badges and path-rule identity on both surfaces", () => {
		const props = makeProps();
		const terminal = renderItem({ ...props, def: def("terminal") });
		expect(elementOf(terminal, ActionIcon)?.props.variant).toBe("light");
		expect(elementOf(terminal, Indicator)?.props.label).toBe("2");
		const path = renderItem({ ...props, def: def("path-rules") });
		expect(path.type).toBe(PathRulesPopover);
		expect(path.props.narratorId).toBe("narrator-a");
		expect(path.props.triggerMode).toBe("icon");
		const menu = renderItem({ ...props, def: def("path-rules"), mode: "menu" });
		(elementOf(menu, Menu.Item)?.props.onClick as () => void)();
		expect(props.controller.activateToolbarEntry).toHaveBeenLastCalledWith("path-rules");
	});
	test("narrow bottom rows collapse the last saved tools first", () => {
		const actions = buildBottomToolbarActions({
			...makeProps(),
			defs: [def("git"), def("terminal"), def("path-rules")],
		});
		const hidden = resolveNarratorStatusToolbarOverflow({
			budgetWidth: 102,
			leadingWidth: 40,
			actions: actions.map((action) => ({
				key: action.key,
				width: 28,
				collapsePriority: action.collapsePriority,
			})),
		});
		expect(hidden).toEqual(["terminal", "path-rules"]);
	});

	test("self-contained menu entries reuse the controller options", () => {
		const props = makeProps();
		for (const id of ["device", "lodlevel", "plugins"]) {
			renderItem({ ...props, def: def(id), mode: "menu" });
			expect(props.controller.renderToolbarInlineOptions).toHaveBeenLastCalledWith(
				id,
				expect.any(Function),
			);
		}
	});
	test("mobile fixed controls precede dynamic tools without adding legacy copies", () => {
		const props = makeProps();
		const bottomActions = buildBottomToolbarActions({
			...props,
			defs: [def("git"), def("terminal")],
		});
		const options = {
			narratorId: props.narratorId,
			t: props.t,
			hasPlanTrait: true,
			relaxedPlanEnabled: false,
			relaxedPlanForced: false,
			relaxedPlanMutation: { isPending: false },
			isAskInPassing: true,
			chapterId: null,
			promoteMutation: { isPending: false },
			handlePromote: () => {},
			bottomActions,
		} as BuildMobileToolbarActionsOptions;
		const actions = buildMobileToolbarActions(options);
		expect(actions.map((action) => action.key)).toEqual([
			"relaxed-plan",
			"promote",
			"git",
			"terminal",
		]);
		expect(
			buildMobileToolbarActions({ ...options, bottomActions: [] }).map((action) => action.key),
		).toEqual(["relaxed-plan", "promote"]);
		const hidden = resolveNarratorStatusToolbarOverflow({
			budgetWidth: 80,
			leadingWidth: 60,
			actions: actions.map((action) => ({
				key: action.key,
				width: 28,
				collapsePriority: action.collapsePriority,
			})),
		});
		expect(hidden).toContain("git");
		expect(hidden).toContain("terminal");
	});
});

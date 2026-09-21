import { describe, expect, mock, test } from "bun:test";
import { ActionIcon, Indicator, Menu } from "@mantine/core";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
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
			const rendered = NarratorToolbarItem(element.props);
			const button = elementOf(rendered, mode === "inline" ? ActionIcon : Menu.Item);
			expect(button).toBeDefined();
			(button?.props.onClick as () => void)();
		}
		expect(props.controller.activateToolbarEntry).toHaveBeenCalledTimes(2);
		expect(props.controller.activateToolbarEntry).toHaveBeenLastCalledWith("git");
	});
	test("keeps active styling, badges and path-rule identity on both surfaces", () => {
		const props = makeProps();
		const terminal = NarratorToolbarItem({ ...props, def: def("terminal") });
		expect(elementOf(terminal, ActionIcon)?.props.variant).toBe("light");
		expect(elementOf(terminal, Indicator)?.props.label).toBe("2");
		const path = NarratorToolbarItem({ ...props, def: def("path-rules") });
		expect(path.type).toBe(PathRulesPopover);
		expect(path.props.narratorId).toBe("narrator-a");
		expect(path.props.triggerMode).toBe("icon");
		const menu = NarratorToolbarItem({ ...props, def: def("path-rules"), mode: "menu" });
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
			NarratorToolbarItem({ ...props, def: def(id), mode: "menu" });
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

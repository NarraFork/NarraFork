import type { DockviewApi, IDockviewPanel } from "dockview-react";

export type TabCloseAction = "all" | "left" | "right" | "auxiliary";

/** Workspace has no unique protagonist: conservatively retain every narrator member. */
export function getTabCloseTargets(
	api: DockviewApi,
	panelId: string,
	action: TabCloseAction,
): IDockviewPanel[] {
	const current = api.getPanel(panelId);
	if (!current) return [];
	const siblings = current.group.panels;
	const index = siblings.indexOf(current);
	const candidates =
		action === "left"
			? index < 0
				? []
				: siblings.slice(0, index)
			: action === "right"
				? index < 0
					? []
					: siblings.slice(index + 1)
				: api.panels;
	return candidates.filter((panel) => {
		const component = panel.api.component;
		// Chat is deliberately close-less, including via directional commands.
		if (component === "chat") return false;
		if (action === "left" || action === "right") return true;
		if (component === "narrator") return false;
		return action !== "auxiliary" || component !== "subagent";
	});
}

export function closeSurfaceTabs(api: DockviewApi, panelId: string, action: TabCloseAction) {
	// Snapshot before closing: closing a panel may remove/reorder its group.
	for (const panel of getTabCloseTargets(api, panelId, action)) {
		if (api.getPanel(panel.id) === panel) panel.api.close();
	}
}

import type { DockviewApi, IDockviewPanel } from "dockview-react";

/** Reuse a primary session without moving focus/scroll through DOM ancestors. */
export function focusMessagePanel(
	api: DockviewApi,
	panel: IDockviewPanel,
	messageId: string | undefined,
	scrollToMessage: (messageId: string) => void,
): void {
	if (!panel.api.isActive) panel.api.setActive();
	if (!messageId) return;
	// Activation restores the hidden tab's viewport. Let React/layout commit before
	// the virtual list measures it; never focus a DOM node or use scrollIntoView.
	requestAnimationFrame(() => {
		if (api.getPanel(panel.id) !== panel || !panel.api.isVisible) return;
		scrollToMessage(messageId);
	});
}

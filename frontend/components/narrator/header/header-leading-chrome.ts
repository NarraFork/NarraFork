/**
 * The header's leading slot hosts at most one chrome button (back / standalone
 * link). Workspace previews stay lightweight and never show it; a host-provided
 * `onMinimize` owns the slot instead. Both the layout budget (`showBack`) and the
 * render branch must read this same predicate or the width arithmetic lies.
 */
export interface HeaderLeadingChromeInput {
	isWorkspacePreview: boolean;
	onMinimize?: (() => void) | null;
	onBack?: (() => void) | null;
}

export function showHeaderLeadingChrome(input: HeaderLeadingChromeInput): boolean {
	return !input.isWorkspacePreview && !input.onMinimize;
}

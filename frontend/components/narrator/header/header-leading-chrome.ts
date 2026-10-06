/**
 * The header's leading slot hosts at most one chrome button (back / standalone
 * link). Two constraints meet here:
 *
 * - Chapter-bound narrators surrender the slot: the ChapterBar below the
 *   header already owns chapter navigation, so the leading button was dropped
 *   to give the title and tool row their width back.
 * - A host-provided `onBack` always wins. Hosts pass it only when there IS
 *   somewhere to go back to — the subagent page returns to its parent
 *   narrator, a workspace-origin view returns to the workspace. Subagents
 *   inherit the parent's `chapterId` server-side, so gating on `chapterId`
 *   alone silently swallows their only way back (fatal on mobile, where no
 *   dock tabs exist). Both the layout budget (`showBack`) and the render
 *   branch must read this same predicate or the width arithmetic lies.
 */
export interface HeaderLeadingChromeInput {
	isWorkspacePreview: boolean;
	onMinimize?: (() => void) | null;
	chapterId?: string | null;
	onBack?: (() => void) | null;
}

export function showHeaderLeadingChrome(input: HeaderLeadingChromeInput): boolean {
	if (input.isWorkspacePreview || input.onMinimize) return false;
	return !input.chapterId || !!input.onBack;
}

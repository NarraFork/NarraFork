/**
 * The plugin-written team-SOP section of `spec://behavior_fence`.
 *
 * A plugin (the narrator-team plugin) keeps its SOP inside a narrator's behavior fence between two
 * HTML comment markers, so the person's own constraints around it survive its updates. Three
 * readers need the same split:
 *
 *   - the plugin command itself (`setSpecBehaviorFenceForPlugin`), which replaces its section;
 *   - an outline session's import (`outline/behavior-page.ts`), which moves everything but the
 *     SOP into the behavior page and leaves only the SOP in the old fence (the plugin's channel
 *     until its block commands exist, outline plan PR 12);
 *   - the outline behavior view, which shows the SOP after the page.
 */

/** The plugin the markers name: whose SOP an outline session's old fence holds (PR 12a moves it). */
export const TEAM_SOP_PLUGIN_ID = "com.whisent.narrator-team";

/** Marker that scopes plugin-written team-SOP sections inside spec://behavior_fence. */
export const TEAM_SOP_MARKER = `team-sop:${TEAM_SOP_PLUGIN_ID}`;

export const TEAM_SOP_OPEN = `<!-- ${TEAM_SOP_MARKER} -->`;
export const TEAM_SOP_CLOSE = `<!-- /${TEAM_SOP_MARKER} -->`;

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const SECTION_SOURCE = `${escapeRegExp(TEAM_SOP_OPEN)}([\\s\\S]*?)${escapeRegExp(TEAM_SOP_CLOSE)}`;

/** The first SOP section with the whitespace around it: what the plugin command replaces. */
const FIRST_SECTION_RE = new RegExp(`\\s*${SECTION_SOURCE}\\s*`);

/** The fence without its (first) SOP section, trimmed: what the plugin command keeps. */
export function fenceWithoutFirstPluginSop(fence: string): string {
	return fence.replace(FIRST_SECTION_RE, "").trim();
}

export interface SplitBehaviorFence {
	/** Everything that is not a plugin's SOP (the person's or the agent's rules), trimmed. */
	own: string;
	/** The SOP sections as stored, markers included, separated by a blank line. */
	sopSections: string;
	/** The SOP bodies without markers, trimmed, separated by a blank line: what a reader shows. */
	sop: string;
}

/** Split a fence into its own text and its plugin SOP sections (every one of them). */
export function splitBehaviorFence(fence: string): SplitBehaviorFence {
	const sections: string[] = [];
	const bodies: string[] = [];
	const own = fence
		.replace(new RegExp(SECTION_SOURCE, "g"), (section: string, body: string) => {
			sections.push(section);
			const trimmed = body.trim();
			if (trimmed) bodies.push(trimmed);
			return "\n\n";
		})
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	return { own, sopSections: sections.join("\n\n"), sop: bodies.join("\n\n") };
}

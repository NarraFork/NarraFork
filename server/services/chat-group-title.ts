/**
 * Pure helpers for chat-group display titles.
 *
 * Kept in a dependency-free module (no db / event-bus imports) so unit tests can
 * exercise the logic without triggering database initialization or the instance
 * lock.
 */

/**
 * Build a human-readable group title from the mentioned handles, e.g.
 * "@alice", "@alice, @bob", or "@alice, @bob +2" for many. Pure + testable.
 */
export function buildGroupTitle(handles: string[]): string {
	const cleaned = handles.map((h) => h.trim()).filter(Boolean);
	if (cleaned.length === 0) return "Group chat";
	const shown = cleaned.slice(0, 3).map((h) => `@${h}`);
	const extra = cleaned.length - shown.length;
	return extra > 0 ? `${shown.join(", ")} +${extra}` : shown.join(", ");
}

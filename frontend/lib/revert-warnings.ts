/**
 * Rendering for the server's structured rollback advisories.
 *
 * The server reports codes and counts instead of sentences, so the wording lives
 * here and follows the user's language. Kept out of the components because the same
 * advisory appears in the rollback dialog, the delete-preview tab, and a toast, and
 * three copies of the phrasing would drift.
 */
import type { RevertWarning } from "./api/narrators";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Cap on how many sample paths are named before the list is elided. */
const MAX_SAMPLE_FILES = 5;

function formatSamples(t: Translate, samplePaths: string[]): string {
	if (samplePaths.length === 0) return "";
	const shown = samplePaths.slice(0, MAX_SAMPLE_FILES);
	const hidden = samplePaths.length - shown.length;
	const files = shown.join(", ");
	return hidden > 0
		? ` ${t("revertWarnFilesMore", { files, count: hidden })}`
		: ` ${t("revertWarnFiles", { files })}`;
}

/** One advisory as a sentence in the active language. */
export function formatRevertWarning(t: Translate, warning: RevertWarning): string {
	if (warning.code === "SUBAGENT_CHANGES_REVERTED") {
		return (
			t("revertWarnSubagentReverted", { count: warning.changeCount }) +
			formatSamples(t, warning.sampleFilePaths)
		);
	}

	// Only the non-zero categories are named, so the sentence never claims
	// "0 external changes".
	const parts: string[] = [];
	if (warning.otherActorCount > 0) {
		parts.push(t("revertWarnPartOtherNarrators", { count: warning.otherActorCount }));
	}
	if (warning.externalCount > 0) {
		parts.push(t("revertWarnPartExternal", { count: warning.externalCount }));
	}
	if (warning.unserializedCount > 0) {
		parts.push(t("revertWarnPartShell", { count: warning.unserializedCount }));
	}
	// Named first among the categories a reader cares about? No — but it must be named
	// at all: this is the user's OWN saved work, the one category they can neither
	// reproduce from a transcript nor blame on an agent.
	if ((warning.humanCount ?? 0) > 0) {
		parts.push(t("revertWarnPartHuman", { count: warning.humanCount }));
	}
	if (parts.length === 0) return "";
	return (
		t("revertWarnWorkspaceDiscards", { parts: parts.join(t("revertWarnPartSeparator")) }) +
		formatSamples(t, warning.sampleFilePaths)
	);
}

/** Every advisory joined into one paragraph, or null when there is nothing to say. */
export function formatRevertWarnings(
	t: Translate,
	warnings: RevertWarning[] | undefined,
): string | null {
	if (!warnings?.length) return null;
	const text = warnings
		.map((warning) => formatRevertWarning(t, warning))
		.filter(Boolean)
		.join(" ");
	return text || null;
}

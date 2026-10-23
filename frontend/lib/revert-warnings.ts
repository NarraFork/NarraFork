/**
 * Rendering for the server's structured rollback advisories.
 *
 * The server reports codes and counts instead of sentences, so the wording lives
 * here and follows the user's language. Kept out of the components because the same
 * advisory appears in the rollback dialog, the delete-preview tab, and a toast, and
 * three copies of the phrasing would drift.
 */
import type { PartialRevertResult } from "@shared/partial-revert";
import type { RevertWarning } from "./api/narrators";

/** Render known outcomes separately; unknown ranges are never described as restored. */
export function formatPartialRevert(t: Translate, coverage?: PartialRevertResult): string | null {
	if (!coverage) return null;
	const sections = [
		t("partialRevert.restored", { count: coverage.restoredFiles.length }),
		t("partialRevert.conflicts", { count: coverage.conflicts.length }),
		...coverage.conflicts.slice(0, 100).map(({ path, reason }) => `${path}: ${reason}`),
		t("partialRevert.unknown", { count: coverage.unknownCoverage.length }),
		...coverage.unknownCoverage
			.slice(0, 100)
			.map(
				(range) =>
					`${[range.deviceId, range.root, range.activityId, range.operationId, range.toolCallId].filter(Boolean).join(" / ")}: ${range.reason}`,
			),
	];
	if (coverage.conflicts.length > 100 || coverage.unknownCoverage.length > 100)
		sections.push(t("partialRevert.truncated"));
	return sections.join("\n");
}

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
	if (warning.code === "WORKSPACE_SCOPE_EVIDENCE_UNCERTAIN") {
		const parts = [t("revertWarnEvidenceUncertain")];
		if (warning.legacyCount > 0) {
			parts.push(t("revertWarnLegacyEvidence", { count: warning.legacyCount }));
		}
		if (warning.unknownCount > 0) {
			parts.push(t("revertWarnUnknownEvidence", { count: warning.unknownCount }));
		}
		if (!warning.warningScanComplete) parts.push(t("revertWarnScanIncomplete"));
		if (warning.countsLowerBound) parts.push(t("revertWarnCountsLowerBound"));
		return parts.join(" ") + formatSamples(t, warning.sampleFilePaths);
	}
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

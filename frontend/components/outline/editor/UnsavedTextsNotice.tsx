/**
 * The notice of a page's unsaved text (`unsaved-texts.ts`): typing of this tab that did not
 * reach the page, whichever session, panel or editor it came from. Every surface of the page
 * shows it from the moment it mounts — the live editor, and the read-only view in its place —
 * with copy and dismiss per text, and, for text whose block is no longer on the page, adding it
 * back as a new block when the page is live and writable here. Adding back that may have reached
 * the page already (the session closed before it answered) says so before it is offered again;
 * texts of the page that the tab's limits pushed out are counted (until dismissed).
 */
import { Alert, Button, Group, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { copyTextToClipboard } from "../../../lib/clipboard";
import type { LiveClient } from "./live-client";
import {
	dismissUnsavedDropped,
	dropUnsavedText,
	onUnsavedTexts,
	UNSAVED_LIMITS,
	type UnsavedReason,
	unsavedDroppedOf,
	unsavedTextsOf,
	unsavedTextsVersion,
} from "./unsaved-texts";
import "./editor.css";

const REASON_KEY: Record<UnsavedReason, string> = {
	refused: "editor.unsavedRefused",
	read_only: "editor.unsavedReadOnly",
	not_sent: "editor.unsavedNotSent",
	moved_away: "editor.unsavedMovedAway",
};

export function UnsavedTextsNotice({
	pageId,
	client,
}: {
	pageId: string;
	/** The page's live session here, if any (restoring needs it live and writable). */
	client?: LiveClient | null;
}) {
	const { t } = useTranslation("outline");
	useSyncExternalStore(onUnsavedTexts, unsavedTextsVersion, unsavedTextsVersion);
	const entries = unsavedTextsOf(pageId);
	const dropped = unsavedDroppedOf(pageId);
	if (entries.length === 0 && dropped === 0) return null;
	const canRestore = !!client && client.pageId === pageId && client.ready && client.editable;
	return (
		<Alert
			color="red"
			variant="light"
			py={6}
			mb="xs"
			className="nf-outline-unsaved-notice"
			data-testid="outline-unsaved-notice"
		>
			{dropped > 0 && (
				<Group gap="xs" wrap="wrap" mb={4} data-testid="outline-unsaved-dropped">
					<Text size="sm">
						{t("editor.unsavedDropped", {
							count: dropped,
							entries: UNSAVED_LIMITS.entries,
							kb: UNSAVED_LIMITS.bytes / 1024,
						})}
					</Text>
					<Button size="compact-xs" variant="subtle" onClick={() => dismissUnsavedDropped(pageId)}>
						{t("editor.dismiss")}
					</Button>
				</Group>
			)}
			{entries.length > 0 && (
				<Text size="sm" mb={4}>
					{t("editor.unsavedTitle", { count: entries.length })}
				</Text>
			)}
			{entries.map((entry) => (
				<div
					key={entry.id}
					className="nf-outline-unsaved-entry"
					data-testid="outline-unsaved-entry"
					data-reason={entry.reason}
				>
					<Text size="xs" c="dimmed">
						{t(REASON_KEY[entry.reason])}
					</Text>
					{entry.adding === "unknown" && (
						<Text size="xs" c="orange" fw={500} data-testid="outline-unsaved-maybe-added">
							{t("editor.unsavedMaybeAdded")}
						</Text>
					)}
					<pre className="nf-outline-unsaved" data-testid="outline-unsaved-text">
						{entry.text}
					</pre>
					<Group gap="xs" wrap="wrap" mt={4}>
						<Button
							size="compact-xs"
							variant="light"
							onClick={() => {
								void copyTextToClipboard(entry.text).then(
									() => notifications.show({ message: t("editor.unsavedCopied") }),
									() => undefined,
								);
							}}
						>
							{t("editor.copyUnsaved")}
						</Button>
						{entry.restore && canRestore && (
							<Button
								size="compact-xs"
								variant="light"
								data-testid="outline-unsaved-restore"
								// On its way: wait for the page's answer (not a second block).
								disabled={entry.adding === "sending"}
								onClick={() => {
									// The entry stays until the page acknowledges the new block.
									if (!client?.restoreUnsaved(entry))
										notifications.show({
											color: "yellow",
											message: t("editor.restoreNotPossible"),
										});
								}}
							>
								{t(
									entry.adding === "sending"
										? "editor.unsavedAdding"
										: entry.adding === "unknown"
											? "editor.restoreUnsavedAgain"
											: "editor.restoreUnsaved",
								)}
							</Button>
						)}
						<Button size="compact-xs" variant="subtle" onClick={() => dropUnsavedText(entry.id)}>
							{t("editor.dismiss")}
						</Button>
					</Group>
				</div>
			))}
		</Alert>
	);
}

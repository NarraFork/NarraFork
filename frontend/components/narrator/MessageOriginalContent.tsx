/**
 * MessageOriginalContent.tsx — "edited" marker + original-text reveal, shared by
 * BOTH message render paths.
 *
 * An assistant message whose text was manually edited carries `editedAt` plus the
 * captured `originalContentJson`. The classic renderer shows a small badge above
 * the message (EditedBadge); the pretext vlist has no per-block chrome budget, so
 * it exposes the same affordance through its row context menu and mounts a single
 * shell-level modal instead (OriginalContentModal).
 *
 * Deliberately placed OUTSIDE vlist/ so both paths can import it: the isolation
 * guard forbids non-vlist files from statically importing vlist/, not the reverse
 * (same reasoning as TraceRowInteraction.tsx).
 */

import { Badge, Button, Group, Modal, Paper, Stack, Text, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconArrowBackUp, IconPencil } from "@tabler/icons-react";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { formatLocaleDateTime } from "../../lib/intl-format";

/** Join every text block of a captured original content payload. */
export function collectOriginalText(originalContentJson?: unknown[] | null): string {
	if (!Array.isArray(originalContentJson)) return "";
	return originalContentJson
		.filter((b): b is { type?: string; text?: string } => !!b && typeof b === "object")
		.filter((b) => b.type === "text")
		.map((b) => b.text ?? "")
		.join("\n\n");
}

export interface OriginalContentModalProps {
	opened: boolean;
	onClose: () => void;
	/** Captured pre-edit contentJson; only its text blocks are shown. */
	originalContentJson?: unknown[] | null;
	editedAt: string;
	/** Absent → the restore button is hidden (read-only reveal). */
	onRestore?: () => void;
}

/**
 * Modal revealing an edited message's original (unedited) text, with an optional
 * "restore original" action. Kept standalone so the vlist shell can mount exactly
 * one instance for the whole list.
 */
export function OriginalContentModal({
	opened,
	onClose,
	originalContentJson,
	editedAt,
	onRestore,
}: OriginalContentModalProps) {
	const { t } = useTranslation("narrator");
	const originalText = useMemo(
		() => collectOriginalText(originalContentJson),
		[originalContentJson],
	);
	const editedTime = useMemo(() => formatLocaleDateTime(editedAt) || editedAt, [editedAt]);

	const handleRestore = useCallback(() => {
		if (!onRestore) return;
		onRestore();
		onClose();
	}, [onRestore, onClose]);

	return (
		<Modal opened={opened} onClose={onClose} title={t("originalContentTitle")} size="lg" centered>
			<Stack gap="xs">
				<Text size="xs" c="dimmed">
					{t("editedAtLabel", { time: editedTime })}
				</Text>
				<Paper p="sm" radius="md" withBorder>
					<Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
						{originalText}
					</Text>
				</Paper>
				{onRestore && (
					<Group justify="flex-end">
						<Button
							size="xs"
							variant="light"
							leftSection={<IconArrowBackUp size={14} />}
							onClick={handleRestore}
						>
							{t("restoreOriginal")}
						</Button>
					</Group>
				)}
			</Stack>
		</Modal>
	);
}

/**
 * Small "edited" badge shown above an assistant message whose text was manually
 * edited. Clicking it opens the original-text modal. The edited text is persisted
 * and used for later history; only this edit marker and original-text metadata
 * stay outside the AI provider payload.
 */
export function EditedBadge({
	originalContentJson,
	editedAt,
	onRestore,
}: {
	originalContentJson?: unknown[] | null;
	editedAt: string;
	onRestore?: () => void;
}) {
	const { t } = useTranslation("narrator");
	const [opened, { open, close }] = useDisclosure(false);
	const originalText = useMemo(
		() => collectOriginalText(originalContentJson),
		[originalContentJson],
	);
	const editedTime = useMemo(() => formatLocaleDateTime(editedAt) || editedAt, [editedAt]);
	const canViewOriginal = originalText.trim().length > 0;

	return (
		<>
			<Tooltip label={canViewOriginal ? t("viewOriginal") : editedTime} withArrow>
				<Badge
					size="xs"
					variant="light"
					color="gray"
					leftSection={<IconPencil size={10} />}
					style={{ cursor: canViewOriginal ? "pointer" : "default", textTransform: "none" }}
					onClick={canViewOriginal ? open : undefined}
				>
					{t("messageEdited")}
				</Badge>
			</Tooltip>
			<OriginalContentModal
				opened={opened}
				onClose={close}
				originalContentJson={originalContentJson}
				editedAt={editedAt}
				onRestore={onRestore}
			/>
		</>
	);
}

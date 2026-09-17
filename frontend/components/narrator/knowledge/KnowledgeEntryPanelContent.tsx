/**
 * Knowledge entry panel content — view + edit a single entry's body.
 *
 * Supports both global entries (shared base) and personal entries. Permission
 * rules:
 * - Global: `isAdmin || isOwner` → direct edit via `useAddKnowledgeRevision`.
 * - Personal: always editable by the owner via `useUpdatePersonalEntryContent`.
 *
 * Does NOT replicate the full tab structure of the standalone route. Only shows
 * the content body with a "open in full page" action.
 *
 * ⚠️ The body field differs per scope (`currentContent` on a global entry vs
 * `content` on a personal one) — see `knowledge-entry-fields.ts`, which owns
 * that discrimination. Reading `content` for both is what made every global
 * entry render as "(empty)".
 *
 * Dirty state is tracked to prevent silent data loss when the panel is closed
 * or the entry changes. The save-race pattern from SpecPanel is replicated:
 * `editVersionRef` ensures a save that completes while the user kept editing
 * does not incorrectly clear dirty.
 */

import { useConfirmDialog } from "@frontend/components/common/confirm-dialog-context";
import {
	ActionIcon,
	Box,
	Button,
	Center,
	Group,
	Loader,
	ScrollArea,
	Text,
	Textarea,
	Tooltip,
} from "@mantine/core";
import { IconExternalLink } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../../hooks/useAuth";
import {
	useAddKnowledgeRevision,
	useKnowledgeEntry,
	usePersonalEntry,
	useUpdatePersonalEntryContent,
} from "../../../hooks/useKnowledge";
import { MarkdownContent } from "../markdown/MarkdownContent";
import type { KnowledgeEntryScope } from "../panels/panel-kind";
import {
	canEditKnowledgeEntry,
	knowledgeEntryContent,
	knowledgeEntryTitle,
} from "./knowledge-entry-fields";

export interface KnowledgeEntryPanelContentProps {
	entryId: string;
	scope: KnowledgeEntryScope;
	onClose: () => void;
}

export function KnowledgeEntryPanelContent({
	entryId,
	scope,
	onClose: _onClose,
}: KnowledgeEntryPanelContentProps) {
	const { t } = useTranslation("knowledge");
	const navigate = useNavigate();
	const confirm = useConfirmDialog();

	// ── Data fetching (only ONE query fires based on scope) ──
	const globalEntry = useKnowledgeEntry(scope === "global" ? entryId : undefined);
	const personalEntry = usePersonalEntry(scope === "personal" ? entryId : undefined);

	const isLoading = scope === "global" ? globalEntry.isLoading : personalEntry.isLoading;
	const entryData = scope === "global" ? globalEntry.data : personalEntry.data;

	// ── Permission check ──
	const { data: user } = useCurrentUser();
	const canEdit = canEditKnowledgeEntry(scope, entryData, user);

	// ── Edit state ──
	const [editing, setEditing] = useState(false);
	const [editContent, setEditContent] = useState("");
	const [dirty, setDirty] = useState(false);
	const editVersionRef = useRef(0);

	// ── Mutations ──
	const addRevision = useAddKnowledgeRevision();
	const updatePersonal = useUpdatePersonalEntryContent();
	const isSaving = addRevision.isPending || updatePersonal.isPending;

	// Sync content from server when not dirty
	const serverContent = knowledgeEntryContent(scope, entryData);
	useEffect(() => {
		if (!dirty && serverContent != null) {
			setEditContent(serverContent);
		}
	}, [serverContent, dirty]);

	const handleStartEdit = useCallback(() => {
		setEditContent(serverContent ?? "");
		setEditing(true);
		setDirty(false);
		editVersionRef.current = 0;
	}, [serverContent]);

	const handleChange = useCallback((value: string) => {
		setEditContent(value);
		setDirty(true);
		editVersionRef.current += 1;
	}, []);

	const handleSave = useCallback(async () => {
		const savedVersion = editVersionRef.current;
		if (scope === "global") {
			await addRevision.mutateAsync({ entryId, content: editContent });
		} else {
			await updatePersonal.mutateAsync({ id: entryId, content: editContent });
		}
		// Only clear dirty if no new edits landed since save started
		if (editVersionRef.current === savedVersion) {
			setDirty(false);
			setEditing(false);
		}
	}, [scope, entryId, editContent, addRevision, updatePersonal]);

	const handleCancel = useCallback(async () => {
		if (dirty) {
			const ok = await confirm({
				title: t("panel.unsavedTitle"),
				message: t("panel.unsavedMessage"),
				confirmLabel: t("panel.discardConfirm"),
				cancelLabel: t("panel.keepEditing"),
				confirmColor: "red",
			});
			if (!ok) return;
		}
		setEditing(false);
		setDirty(false);
		setEditContent(serverContent ?? "");
	}, [dirty, confirm, t, serverContent]);

	const openStandalone = useCallback(() => {
		if (scope === "global") {
			navigate({ to: "/knowledge/$entryId", params: { entryId } });
		} else {
			navigate({
				to: "/knowledge/personal/$personalEntryId",
				params: { personalEntryId: entryId },
			});
		}
	}, [navigate, entryId, scope]);

	// ── Loading / Error ──
	if (isLoading) {
		return (
			<Center h="100%">
				<Loader size="sm" />
			</Center>
		);
	}
	if (!entryData) {
		return (
			<Center h="100%">
				<Text size="sm" c="dimmed">
					{t("panel.notFound")}
				</Text>
			</Center>
		);
	}

	const title = knowledgeEntryTitle(scope, entryData) ?? t("panel.title");

	return (
		<Box style={{ height: "100%", display: "flex", flexDirection: "column", overflow: "hidden" }}>
			{/* Toolbar */}
			<Group px="sm" py={4} gap="xs" justify="space-between" style={{ flexShrink: 0 }}>
				<Text size="sm" fw={600} truncate style={{ flex: 1 }}>
					{title}
				</Text>
				<Group gap={4}>
					{canEdit && !editing && (
						<Button size="compact-xs" variant="light" onClick={handleStartEdit}>
							{t("edit")}
						</Button>
					)}
					{editing && (
						<>
							<Button
								size="compact-xs"
								variant="filled"
								loading={isSaving}
								onClick={handleSave}
								disabled={!dirty}
							>
								{t("save")}
							</Button>
							<Button size="compact-xs" variant="subtle" onClick={handleCancel}>
								{t("cancel")}
							</Button>
						</>
					)}
					<Tooltip label={t("panel.openFull")}>
						<ActionIcon size="sm" variant="subtle" onClick={openStandalone}>
							<IconExternalLink size={14} />
						</ActionIcon>
					</Tooltip>
				</Group>
			</Group>

			{/* Content area */}
			<Box style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
				{editing ? (
					<Textarea
						value={editContent}
						onChange={(e) => handleChange(e.currentTarget.value)}
						autosize={false}
						styles={{
							root: { height: "100%" },
							wrapper: { height: "100%" },
							input: { height: "100%", fontFamily: "monospace", fontSize: 13 },
						}}
					/>
				) : (
					<ScrollArea h="100%" px="sm" py="xs">
						{serverContent ? (
							<MarkdownContent text={serverContent} />
						) : (
							<Text size="sm" c="dimmed" fs="italic">
								{t("noContent")}
							</Text>
						)}
					</ScrollArea>
				)}
			</Box>
		</Box>
	);
}

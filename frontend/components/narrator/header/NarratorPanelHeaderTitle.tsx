import { ActionIcon, Group, Text, TextInput } from "@mantine/core";
import { IconPencil, IconSparkles } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { HEADER_TITLE_SLOT_ATTR } from "./narrator-header-toolbar-capacity";
import { useTitleEditing } from "./use-title-editing";

export interface NarratorPanelHeaderTitleProps {
	narratorId: string;
	/** Current narrator (read for the existing title); may be undefined while loading. */
	narrator: { title?: string | null } | undefined;
	/** When a host (e.g. a chapter node) already renders the title + edit controls. */
	hostOwnsTitle: boolean;
	isWorkspacePreview: boolean;
}

/**
 * The header's title slot: inline-editable title + edit/generate buttons. Owns
 * its own `useTitleEditing` hook rather than receiving its nine outputs as props,
 * since none of them are read anywhere outside this slot.
 *
 * `HEADER_TITLE_SLOT_ATTR` marks the wrapping Group so the toolbar capacity
 * measurement budgets the slot by policy (see narrator-header-toolbar-capacity).
 */
export function NarratorPanelHeaderTitle({
	narratorId,
	narrator,
	hostOwnsTitle,
	isWorkspacePreview,
}: NarratorPanelHeaderTitleProps) {
	const { t } = useTranslation("narrator");
	const {
		editingTitle,
		titleValue,
		setTitleValue,
		generatingTitle,
		titleInputRef,
		startEditingTitle,
		saveTitle,
		handleGenerateTitle,
		handleTitleKeyDown,
	} = useTitleEditing({ narratorId, narrator, t });
	const displayTitle = narrator?.title || t("untitled");

	return (
		<Group
			{...{ [HEADER_TITLE_SLOT_ATTR]: "" }}
			gap={4}
			style={{ flex: 1, minWidth: 0 }}
			wrap="nowrap"
		>
			{hostOwnsTitle ? null : editingTitle && !isWorkspacePreview ? (
				<TextInput
					ref={titleInputRef}
					value={titleValue}
					onChange={(e) => setTitleValue(e.currentTarget.value)}
					onKeyDown={handleTitleKeyDown}
					onBlur={saveTitle}
					size="xs"
					style={{ flex: 1, maxWidth: 500 }}
				/>
			) : (
				<Text
					size="sm"
					fw={500}
					onDoubleClick={isWorkspacePreview ? undefined : startEditingTitle}
					style={{
						cursor: isWorkspacePreview ? "default" : "pointer",
						overflow: "hidden",
						textOverflow: "ellipsis",
						whiteSpace: "nowrap",
						maxWidth: 500,
					}}
					title={displayTitle}
				>
					{displayTitle}
				</Text>
			)}
			{!isWorkspacePreview && !hostOwnsTitle && (
				<>
					<ActionIcon size="xs" variant="subtle" onClick={startEditingTitle} title={t("editTitle")}>
						<IconPencil size={12} />
					</ActionIcon>
					<ActionIcon
						size="xs"
						variant="subtle"
						onClick={handleGenerateTitle}
						loading={generatingTitle}
						title={t("generateTitle")}
					>
						<IconSparkles size={12} />
					</ActionIcon>
				</>
			)}
		</Group>
	);
}

import { ActionIcon, Text, TextInput } from "@mantine/core";
import { IconPencil, IconSparkles } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { HEADER_TITLE_SLOT_ATTR } from "./narrator-header-toolbar-capacity";
import { useTitleEditing } from "./use-title-editing";

export interface NarratorPanelHeaderTitleProps {
	narratorId: string;
	narrator: { title?: string | null } | undefined;
	hostOwnsTitle: boolean;
	isWorkspacePreview: boolean;
	/**
	 * COMPLETE title width from pretext (`headerTitleLayoutWidth(fullTitle)`).
	 * The title box is FIXED to this value — tools are fitted around it in
	 * `resolveHeaderLayoutAfterTitle`, never the reverse.
	 */
	titleFullWidth: number;
}

/**
 * Title box with a FIXED pretext-measured width. `flex: 0 0 auto` — buttons
 * cannot shrink it via flex. Ellipsis applies when the host floored
 * `titleFullWidth` below the true text width (pathological narrow row).
 */
export function NarratorPanelHeaderTitle({
	narratorId,
	narrator,
	hostOwnsTitle,
	isWorkspacePreview,
	titleFullWidth,
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
	const ownsTitleChrome = hostOwnsTitle || isWorkspacePreview;
	const boxWidth = ownsTitleChrome ? 0 : titleFullWidth;

	return (
		<div
			{...{ [HEADER_TITLE_SLOT_ATTR]: "" }}
			data-header-title-width={boxWidth}
			style={{
				display: "flex",
				alignItems: "center",
				gap: 4,
				flexWrap: "nowrap",
				// Shrink-to-fit: total = fixed title box + action icons. Tools never
				// flex this down — they are omitted by resolveHeaderLayoutAfterTitle.
				flex: "0 0 auto",
			}}
		>
			{hostOwnsTitle ? null : editingTitle && !isWorkspacePreview ? (
				<TextInput
					ref={titleInputRef}
					value={titleValue}
					onChange={(e) => setTitleValue(e.currentTarget.value)}
					onKeyDown={handleTitleKeyDown}
					onBlur={saveTitle}
					size="xs"
					style={{ flex: "0 0 auto", width: Math.max(boxWidth, 120) }}
				/>
			) : (
				<Text
					size="sm"
					fw={500}
					onDoubleClick={isWorkspacePreview ? undefined : startEditingTitle}
					style={{
						// FIXED full-title width from pretext — not flex:auto.
						flex: "0 0 auto",
						width: boxWidth,
						maxWidth: boxWidth,
						overflow: "hidden",
						textOverflow: "ellipsis",
						whiteSpace: "nowrap",
						cursor: isWorkspacePreview ? "default" : "pointer",
					}}
					title={displayTitle}
				>
					{displayTitle}
				</Text>
			)}
			{!isWorkspacePreview && !hostOwnsTitle && (
				<>
					<ActionIcon
						size="xs"
						variant="subtle"
						onClick={startEditingTitle}
						title={t("editTitle")}
						style={{ flex: "0 0 auto" }}
					>
						<IconPencil size={12} />
					</ActionIcon>
					<ActionIcon
						size="xs"
						variant="subtle"
						onClick={handleGenerateTitle}
						loading={generatingTitle}
						title={t("generateTitle")}
						style={{ flex: "0 0 auto" }}
					>
						<IconSparkles size={12} />
					</ActionIcon>
				</>
			)}
		</div>
	);
}

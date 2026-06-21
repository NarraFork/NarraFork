import { Box, Collapse, Divider, Menu, UnstyledButton } from "@mantine/core";
import { IconArrowsMinimize, IconChevronDown, IconEraser, IconPencil } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

interface CompactMenuSubProps {
	/** Triggered by clicking the left part — runs the compact action directly. */
	onCompact?: () => void;
	/** Triggered by the "clear to here" sub-item (insert an empty compact marker). */
	onClearContext?: () => void;
	/** Triggered by the "manual summarize" sub-item (create a compact marker + edit it). */
	onManualSummarize?: () => void;
	/** Called after any action runs (e.g. to close the swipe/context menu). */
	onClose?: () => void;
	/** When true, the whole entry is disabled (used by the pixi prop-based menu). */
	disabled?: boolean;
}

const ROW_HOVER_BG = "var(--mantine-color-default-hover)";

/**
 * "Compact to here" menu entry rendered as a split control:
 * - Clicking the left part (icon + label) runs the compact action directly.
 * - Clicking the right part (chevron, after a vertical divider) toggles an inline,
 *   in-place expansion with "Clear to here" and "Manual summarize" sub-items.
 *
 * Mantine v7 has no `Menu.Sub`, and nesting a `Menu`/Popover inside a dropdown is
 * unreliable here (the outer menu intercepts the trigger). So instead of a flyout
 * submenu, the second level expands inline below the row. This works identically in
 * both the right-click `Menu` and the portal-rendered swipe menu.
 */
export function CompactMenuSub({
	onCompact,
	onClearContext,
	onManualSummarize,
	onClose,
	disabled,
}: CompactMenuSubProps) {
	const { t } = useTranslation("narrator");
	const [hoverLeft, setHoverLeft] = useState(false);
	const [hoverRight, setHoverRight] = useState(false);
	const [expanded, setExpanded] = useState(false);

	const runCompact = () => {
		onCompact?.();
		onClose?.();
	};
	const runClearContext = () => {
		onClearContext?.();
		onClose?.();
	};
	const runManualSummarize = () => {
		onManualSummarize?.();
		onClose?.();
	};

	return (
		<Box style={{ opacity: disabled ? 0.5 : 1, pointerEvents: disabled ? "none" : undefined }}>
			<Box style={{ display: "flex", alignItems: "stretch" }}>
				<UnstyledButton
					onClick={runCompact}
					onMouseEnter={() => setHoverLeft(true)}
					onMouseLeave={() => setHoverLeft(false)}
					disabled={disabled}
					style={{
						flex: 1,
						display: "flex",
						alignItems: "center",
						gap: 8,
						padding: "var(--mantine-spacing-xs) var(--mantine-spacing-sm)",
						fontSize: "var(--mantine-font-size-sm)",
						borderRadius: "var(--mantine-radius-sm)",
						background: hoverLeft ? ROW_HOVER_BG : undefined,
					}}
				>
					<IconArrowsMinimize size={14} />
					<span>{t("contextMenu_compactBefore")}</span>
				</UnstyledButton>

				<Divider orientation="vertical" my={4} />

				<UnstyledButton
					onClick={() => setExpanded((o) => !o)}
					onMouseEnter={() => setHoverRight(true)}
					onMouseLeave={() => setHoverRight(false)}
					disabled={disabled}
					aria-label={t("contextMenu_clearContextBefore")}
					aria-expanded={expanded}
					style={{
						display: "flex",
						alignItems: "center",
						justifyContent: "center",
						padding: "0 var(--mantine-spacing-xs)",
						borderRadius: "var(--mantine-radius-sm)",
						background: hoverRight || expanded ? ROW_HOVER_BG : undefined,
					}}
				>
					<IconChevronDown
						size={14}
						style={{
							transform: expanded ? "rotate(180deg)" : undefined,
							transition: "transform 150ms ease",
						}}
					/>
				</UnstyledButton>
			</Box>

			<Collapse in={expanded}>
				<Box pl="md">
					<Menu.Item leftSection={<IconPencil size={14} />} onClick={runManualSummarize}>
						{t("contextMenu_manualSummarize")}
					</Menu.Item>
					<Menu.Item leftSection={<IconEraser size={14} />} onClick={runClearContext}>
						{t("contextMenu_clearContextBefore")}
					</Menu.Item>
				</Box>
			</Collapse>
		</Box>
	);
}

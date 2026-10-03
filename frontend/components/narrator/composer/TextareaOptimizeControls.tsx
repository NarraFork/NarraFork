import type { OptimizeStyle } from "@frontend/hooks/usePromptOptimize";
import { ActionIcon, Group, Menu, NumberInput, Text, Tooltip } from "@mantine/core";
import {
	IconArrowsMaximize,
	IconCheck,
	IconMessageCircle,
	IconSparkles,
	IconX,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

/**
 * Geometry of this control cluster, in px, so a caller can reserve exactly the room it takes.
 *
 * A `rightSection` is NOT measured by Mantine: `rightSectionWidth` goes through its `rem()`
 * helper into `--input-right-section-width`, and the input uses that variable as its
 * `padding-inline-end`. A NUMBER becomes a length (`calc(3.5rem * var(--mantine-scale))` for 56);
 * a string is passed through unchanged, so the literal `"auto"` made the padding declaration
 * invalid — the browser drops it, the input keeps its default inline padding, while `.section`'s
 * own `width: auto` still grows to fit the buttons. The two then disagree and the buttons sit on
 * top of the last characters of the text. Reserving the real width keeps them in agreement.
 */
const ACTION_ICON_SM_PX = 22; // Mantine `--ai-size-sm`; both buttons below use size="sm".
const CONTROLS_GAP_PX = 4; // The Group's `gap`.
const SECTION_PADDING_END_PX = 8; // Right inset, applied by the Group's own `pr` below.

/**
 * The width a `Textarea` must reserve for these controls.
 *
 * `hasExpand` has to mirror whether `onExpand` is passed — the expand button is conditional, so
 * a caller that omits it (the fullscreen editor) needs a narrower strip.
 *
 * The inset lives on the Group rather than in the caller's `section` styles so this number is
 * exactly the component's own outer width; a caller that also padded the section would shift
 * the buttons relative to the strip it reserved.
 */
export function textareaOptimizeControlsWidth(hasExpand: boolean): number {
	return (
		ACTION_ICON_SM_PX * (hasExpand ? 2 : 1) +
		CONTROLS_GAP_PX * (hasExpand ? 1 : 0) +
		SECTION_PADDING_END_PX
	);
}

export interface TextareaOptimizeControlsProps {
	disabled?: boolean;
	loading?: boolean;
	withContext: boolean;
	onToggleContext: () => void;
	onOptimize: (style: OptimizeStyle) => void;
	onCancelOptimize: () => void;
	onExpand?: () => void;
	/** Number of context messages (for display in hint), default 10 */
	contextMessageCount?: number;
	/** Allow user to change context message count in dropdown */
	onContextMessageCountChange?: (count: number) => void;
}

export function TextareaOptimizeControls(props: TextareaOptimizeControlsProps) {
	const { t } = useTranslation("narrator");
	const contextCount = props.contextMessageCount ?? 10;

	return (
		<Group gap={4} wrap="nowrap" pr={8} style={{ pointerEvents: "auto" }}>
			{props.loading ? (
				<Tooltip label={t("optimizeCancel")} position="top">
					<ActionIcon
						size="sm"
						variant="subtle"
						color="red"
						aria-label={t("optimizeCancel")}
						onClick={props.onCancelOptimize}
					>
						<IconX size={16} />
					</ActionIcon>
				</Tooltip>
			) : (
				<Menu position="top-end" withArrow withinPortal offset={{ mainAxis: 8, crossAxis: 8 }}>
					<Menu.Target>
						<Tooltip label={t("optimizePrompt")} position="top">
							<ActionIcon
								size="sm"
								variant="subtle"
								color="gray"
								disabled={props.disabled || props.loading}
								loading={props.loading}
							>
								<IconSparkles size={16} />
							</ActionIcon>
						</Tooltip>
					</Menu.Target>
					<Menu.Dropdown>
						<Menu.Label>{t("optimizeStyleLabel")}</Menu.Label>
						<Menu.Item onClick={() => props.onOptimize("clarify")}>
							{t("optimizeStyleClarify")}
						</Menu.Item>
						<Menu.Item onClick={() => props.onOptimize("concise")}>
							{t("optimizeStyleConcise")}
						</Menu.Item>
						<Menu.Item onClick={() => props.onOptimize("structured")}>
							{t("optimizeStyleStructured")}
						</Menu.Item>
						<Menu.Item onClick={() => props.onOptimize("translate_en")}>
							{t("optimizeStyleTranslateEn")}
						</Menu.Item>
						<Menu.Divider />
						<Menu.Item
							leftSection={<IconMessageCircle size={16} />}
							rightSection={props.withContext ? <IconCheck size={16} /> : null}
							onClick={props.onToggleContext}
						>
							{t("optimizeWithContext")}
						</Menu.Item>
						{props.onContextMessageCountChange && (
							<Menu.Item closeMenuOnClick={false}>
								<NumberInput
									label={t("optimizeContextMessageCount")}
									description={t("optimizeContextMessageCountHint")}
									value={contextCount}
									onChange={(v) => {
										if (typeof v === "number" && props.onContextMessageCountChange) {
											props.onContextMessageCountChange(v);
										}
									}}
									min={1}
									max={50}
									step={1}
									size="xs"
									styles={{
										root: { width: "100%" },
									}}
									onMouseDown={(e) => {
										// Prevent Menu's mousedown handler from interfering with input focus
										e.stopPropagation();
									}}
									onClick={(e) => {
										// Also prevent click propagation
										e.stopPropagation();
									}}
								/>
							</Menu.Item>
						)}
						<Text size="xs" c="dimmed" px="sm" py={4} style={{ maxWidth: 280 }}>
							{props.withContext
								? t("optimizeWithContextHintEnabled", { count: contextCount })
								: t("optimizeWithContextHint")}
						</Text>
					</Menu.Dropdown>
				</Menu>
			)}

			{props.onExpand && (
				<Tooltip label={t("expandComposer")} position="top">
					<ActionIcon size="sm" variant="subtle" color="gray" onClick={props.onExpand}>
						<IconArrowsMaximize size={16} />
					</ActionIcon>
				</Tooltip>
			)}
		</Group>
	);
}

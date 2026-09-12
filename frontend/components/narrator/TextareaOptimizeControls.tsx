import type { OptimizeStyle } from "@frontend/hooks/usePromptOptimize";
import { ActionIcon, Group, Menu, NumberInput, Text, Tooltip } from "@mantine/core";
import {
	IconArrowsMaximize,
	IconCheck,
	IconMessageCircle,
	IconSparkles,
} from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

export interface TextareaOptimizeControlsProps {
	disabled?: boolean;
	loading?: boolean;
	withContext: boolean;
	onToggleContext: () => void;
	onOptimize: (style: OptimizeStyle) => void;
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
		<Group gap={4} wrap="nowrap" style={{ pointerEvents: "auto" }}>
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

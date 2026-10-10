import { ActionIcon, Group, NumberInput, Text, Tooltip } from "@mantine/core";
import { IconEye, IconEyeOff, IconPlayerPlay } from "@tabler/icons-react";
import React from "react";
import { useTranslation } from "react-i18next";

export interface ModelRowProps {
	modelValue: string;
	modelLabel: string;
	isHidden: boolean;
	onToggleHidden: () => void;
	contextWindow?: number;
	onContextWindowChange: (size: number | null) => void;
	onTestModel?: () => void;
	/** Set to false to hide the context window input (e.g. Codex). */
	showContextWindow?: boolean;
}

/** Below this the save layer rejects the value outright. */
export const CONTEXT_WINDOW_MIN = 256;
/** Below this (but still saveable) the UI shows a non-blocking warning. */
export const CONTEXT_WINDOW_WARN_BELOW = 4_096;

export const ModelRow = React.memo(function ModelRow({
	modelValue,
	modelLabel,
	isHidden,
	onToggleHidden,
	contextWindow,
	onContextWindowChange,
	onTestModel,
	showContextWindow = true,
}: ModelRowProps) {
	const { t } = useTranslation("settings");
	const showSmallWindowWarning =
		typeof contextWindow === "number" &&
		contextWindow >= CONTEXT_WINDOW_MIN &&
		contextWindow < CONTEXT_WINDOW_WARN_BELOW;

	return (
		<Group gap="xs" wrap="wrap" style={isHidden ? { opacity: 0.5 } : undefined}>
			<Text size="xs" ff="monospace" truncate style={{ flex: 1, minWidth: 120 }}>
				{modelValue}
			</Text>
			<Text size="xs" c="dimmed" truncate style={{ flex: 1, minWidth: 120 }}>
				{modelLabel}
			</Text>
			{showContextWindow && (
				<Tooltip
					label={showSmallWindowWarning ? t("contextWindowTooSmallWarning") : ""}
					disabled={!showSmallWindowWarning}
				>
					<NumberInput
						placeholder={t("contextWindowPlaceholder")}
						value={contextWindow || ""}
						onChange={(v) => onContextWindowChange(typeof v === "number" ? v : null)}
						min={CONTEXT_WINDOW_MIN}
						step={1000}
						suffix={` ${t("contextWindowSuffix")}`}
						w={180}
						size="xs"
						error={showSmallWindowWarning}
					/>
				</Tooltip>
			)}
			{onTestModel && (
				<Tooltip label={t("modelTestBtn")}>
					<ActionIcon variant="subtle" color="teal" onClick={onTestModel}>
						<IconPlayerPlay size={16} />
					</ActionIcon>
				</Tooltip>
			)}
			<ActionIcon variant="subtle" color={isHidden ? "gray" : "blue"} onClick={onToggleHidden}>
				{isHidden ? <IconEyeOff size={16} /> : <IconEye size={16} />}
			</ActionIcon>
		</Group>
	);
});

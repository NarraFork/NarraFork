import { Button, Menu, Stack, Text } from "@mantine/core";
import {
	IconCheck,
	IconClock,
	IconDotsVertical,
	IconPlayerPlay,
	IconPlayerTrackNext,
	IconTool,
} from "@tabler/icons-react";

import { useState } from "react";
import { useInputMenu } from "../../../hooks/useInputMenu";

export type QueueMode = "turn" | "tool" | "interrupt";

const QUEUE_MODES: QueueMode[] = ["turn", "tool", "interrupt"];

const QUEUE_MODE_ICONS: Record<string, React.ReactNode> = {
	turn: <IconClock size={14} />,
	tool: <IconTool size={14} />,
	interrupt: <IconPlayerTrackNext size={14} />,
};

const COMPACT_QUEUE_MODES: Array<{ mode: QueueMode; labelKey: string; descKey: string }> = [
	{
		mode: "turn",
		labelKey: "compactQueueMode_wait",
		descKey: "compactQueueMode_wait_desc",
	},
	{
		mode: "interrupt",
		labelKey: "compactQueueMode_now",
		descKey: "compactQueueMode_now_desc",
	},
];

interface QueueModeMenuItemProps {
	mode: QueueMode;
	selected: boolean;
	action: "configure" | "trigger";
	labelKey?: string;
	descriptionKey: string;
	onClick: () => void;
	t: (key: string) => string;
}

function QueueModeMenuItem({
	mode,
	selected,
	action,
	labelKey,
	descriptionKey,
	onClick,
	t,
}: QueueModeMenuItemProps) {
	return (
		<Menu.Item
			leftSection={QUEUE_MODE_ICONS[mode]}
			closeMenuOnClick
			onClick={onClick}
			rightSection={
				action === "trigger" ? (
					<IconPlayerPlay size={14} />
				) : (
					<IconCheck size={14} style={{ visibility: selected ? "visible" : "hidden" }} />
				)
			}
			fw={action === "configure" && selected ? 600 : 400}
		>
			<Stack gap={0}>
				<Text size="sm">{t(labelKey ?? `queueMode_${mode}`)}</Text>
				<Text size="xs" c="dimmed">
					{t(descriptionKey)}
				</Text>
			</Stack>
		</Menu.Item>
	);
}

interface SendOptionsMenuContentProps {
	enterQueueMode: QueueMode;
	ctrlEnterQueueMode: QueueMode;
	hasInput: boolean;
	compacting?: boolean;
	onSelectEnterMode: (mode: QueueMode) => void;
	onSelectCtrlEnterMode: (mode: QueueMode) => void;
	onSendWithMode: (mode: QueueMode) => void;
	t: (key: string) => string;
}

function SendOptionsMenuContent({
	enterQueueMode,
	ctrlEnterQueueMode,
	hasInput,
	compacting,
	onSelectEnterMode,
	onSelectCtrlEnterMode,
	onSendWithMode,
	t,
}: SendOptionsMenuContentProps) {
	const [configureKeys, setConfigureKeys] = useState(false);
	if (compacting && hasInput) {
		return (
			<>
				<Menu.Label>{t("compactQueueSection")}</Menu.Label>
				{COMPACT_QUEUE_MODES.map(({ mode, labelKey, descKey }) => (
					<QueueModeMenuItem
						key={mode}
						mode={mode}
						selected={false}
						action="trigger"
						labelKey={labelKey}
						descriptionKey={descKey}
						onClick={() => onSendWithMode(mode)}
						t={t}
					/>
				))}
			</>
		);
	}
	if (!configureKeys) {
		return (
			<>
				<Menu.Label>{t("sendCurrentInputSection")}</Menu.Label>
				{QUEUE_MODES.map((mode) => (
					<QueueModeMenuItem
						key={mode}
						mode={mode}
						selected={false}
						action="trigger"
						descriptionKey={`queueMode_${mode}_desc`}
						onClick={() => onSendWithMode(mode)}
						t={t}
					/>
				))}
				<Menu.Divider />
				<Menu.Item closeMenuOnClick={false} onClick={() => setConfigureKeys(true)}>
					{t("sendKeySettings")}
				</Menu.Item>
			</>
		);
	}
	return (
		<>
			<Menu.Item closeMenuOnClick={false} onClick={() => setConfigureKeys(false)}>
				{t("sendCurrentInputSection")}
			</Menu.Item>
			<Menu.Label>{t("enterKeySection")}</Menu.Label>
			{QUEUE_MODES.map((mode) => (
				<QueueModeMenuItem
					key={mode}
					mode={mode}
					selected={enterQueueMode === mode}
					action="configure"
					descriptionKey={`queueMode_${mode}_desc`}
					onClick={() => onSelectEnterMode(mode)}
					t={t}
				/>
			))}
			<Menu.Divider />
			<Menu.Label>{t("ctrlEnterKeySection")}</Menu.Label>
			{QUEUE_MODES.map((mode) => (
				<QueueModeMenuItem
					key={mode}
					mode={mode}
					selected={ctrlEnterQueueMode === mode}
					action="configure"
					descriptionKey={`queueMode_${mode}_desc`}
					onClick={() => onSelectCtrlEnterMode(mode)}
					t={t}
				/>
			))}
			<Menu.Divider />
			<Menu.Item disabled>{t("shiftEnterNewlineHint")}</Menu.Item>
		</>
	);
}

export interface SendOptionsSplitButtonProps {
	primaryButton: React.ReactNode;
	enterQueueMode: QueueMode;
	ctrlEnterQueueMode: QueueMode;
	hasInput: boolean;
	compacting?: boolean;
	color?: string;
	variant?: string;
	onSelectEnterMode: (mode: QueueMode) => void;
	onSelectCtrlEnterMode: (mode: QueueMode) => void;
	onSendWithMode: (mode: QueueMode) => void;
	t: (key: string) => string;
}

export function SendOptionsSplitButton({
	primaryButton,
	enterQueueMode,
	ctrlEnterQueueMode,
	hasInput,
	compacting,
	color,
	variant,
	onSelectEnterMode,
	onSelectCtrlEnterMode,
	onSendWithMode,
	t,
}: SendOptionsSplitButtonProps) {
	const inputMenu = useInputMenu();
	return (
		<Button.Group>
			<Menu {...inputMenu.menuProps} position="top-end" withinPortal>
				<Menu.Target>
					<Button
						{...inputMenu.targetProps}
						color={color}
						variant={variant}
						px={6}
						aria-label={t("sendOptions")}
						onContextMenu={(e) => e.preventDefault()}
					>
						<IconDotsVertical size={16} />
					</Button>
				</Menu.Target>
				<Menu.Dropdown style={{ maxHeight: "60vh", overflowY: "auto", maxWidth: 300 }}>
					<SendOptionsMenuContent
						enterQueueMode={enterQueueMode}
						ctrlEnterQueueMode={ctrlEnterQueueMode}
						hasInput={hasInput}
						compacting={compacting}
						onSelectEnterMode={onSelectEnterMode}
						onSelectCtrlEnterMode={onSelectCtrlEnterMode}
						onSendWithMode={onSendWithMode}
						t={t}
					/>
				</Menu.Dropdown>
			</Menu>
			{primaryButton}
		</Button.Group>
	);
}

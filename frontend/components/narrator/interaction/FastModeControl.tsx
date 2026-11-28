import {
	ActionIcon,
	Group,
	Popover,
	SegmentedControl,
	Stack,
	Switch,
	Text,
	Tooltip,
} from "@mantine/core";
import { IconBolt } from "@tabler/icons-react";
import type React from "react";
import type { FastModeOverride } from "./fast-mode-state";
import type { Mutate } from "./mutate";

export interface FastModeControlProps {
	/** Popover placement — desktop uses top-end, the mobile toolbar bottom-end. */
	position: "top-end" | "bottom-end";
	/** Explicit session choice; inherit follows its upstream source. */
	fastModeOverride: FastModeOverride;
	/** The viewing user's editable default, only displayed for primary sessions. */
	fastModeDefault: boolean;
	/** Server-resolved state — drives the icon colour and shortcut. */
	fastModeEnabled: boolean;
	sourceUnavailable: boolean;
	isSubagent: boolean;
	/**
	 * Coarse-pointer / mobile viewports open the settings by long-press instead of
	 * hover, so hover handlers are suppressed when true.
	 */
	fastModeUsesTapSettings: boolean;
	settingsOpened: boolean;
	setSettingsOpened: (opened: boolean) => void;
	openSettings: () => void;
	closeSettings: () => void;
	scheduleSettingsClose: () => void;
	startLongPress: (event: React.PointerEvent) => void;
	clearLongPressTimer: () => void;
	/** True immediately after a long-press fired, so the ensuing click is ignored. */
	longPressFiredRef: React.MutableRefObject<boolean>;
	narratorId: string;
	fastModeMutation: Mutate<{ id: string; fastModeOverride: FastModeOverride }>;
	updateUserPrefs: Mutate<{ fastModeDefault: boolean }>;
	/** narrator translation fn (namespace "narrator"). */
	t: (key: string, opts?: Record<string, unknown>) => string;
}

/**
 * Fast-mode toggle button + its settings popover (session override segmented
 * control + primary-session user-default switch). State/handlers are injected
 * so behaviour is identical across the desktop and
 * mobile status-bar mounts.
 */
export function FastModeControl(props: FastModeControlProps) {
	const {
		position,
		fastModeOverride,
		fastModeDefault,
		fastModeEnabled,
		sourceUnavailable,
		isSubagent,
		fastModeUsesTapSettings,
		settingsOpened,
		setSettingsOpened,
		openSettings,
		closeSettings,
		scheduleSettingsClose,
		startLongPress,
		clearLongPressTimer,
		longPressFiredRef,
		narratorId,
		fastModeMutation,
		updateUserPrefs,
		t,
	} = props;

	return (
		<Popover
			opened={settingsOpened}
			onChange={setSettingsOpened}
			onClose={closeSettings}
			position={position}
			width={fastModeUsesTapSettings ? 280 : 320}
			shadow="md"
			withinPortal
		>
			<Popover.Target>
				<Group
					gap={4}
					wrap="nowrap"
					onMouseEnter={fastModeUsesTapSettings ? undefined : openSettings}
					onMouseLeave={fastModeUsesTapSettings ? undefined : scheduleSettingsClose}
					style={{ flexShrink: 0 }}
				>
					<Tooltip
						label={
							fastModeOverride === "inherit"
								? sourceUnavailable
									? t("fast_mode_source_unavailable")
									: t(isSubagent ? "fast_mode_primary_tooltip" : "fast_mode_inherit_tooltip", {
											state: fastModeEnabled ? t("fast_mode_on") : t("fast_mode_off"),
										})
								: t("fast_mode_tooltip")
						}
						position={position.startsWith("top") ? "top" : "bottom"}
						disabled={settingsOpened}
					>
						<ActionIcon
							variant="subtle"
							color={fastModeEnabled ? "yellow" : "gray"}
							size="sm"
							aria-label={t("fast_mode")}
							onPointerDown={startLongPress}
							onPointerUp={clearLongPressTimer}
							onPointerCancel={clearLongPressTimer}
							onPointerLeave={clearLongPressTimer}
							onContextMenu={(event) => event.preventDefault()}
							onClick={(event) => {
								if (longPressFiredRef.current) {
									event.preventDefault();
									event.stopPropagation();
									longPressFiredRef.current = false;
									return;
								}
								// Clicking pins only this session; the popover restores inheritance.
								fastModeMutation.mutate({
									id: narratorId,
									fastModeOverride: fastModeEnabled ? "off" : "on",
								});
							}}
						>
							<IconBolt size={16} />
						</ActionIcon>
					</Tooltip>
				</Group>
			</Popover.Target>
			<Popover.Dropdown
				onMouseEnter={fastModeUsesTapSettings ? undefined : openSettings}
				onMouseLeave={fastModeUsesTapSettings ? undefined : scheduleSettingsClose}
			>
				<Stack gap={8}>
					<Text size="sm" fw={600}>
						{t("fast_mode")}
					</Text>
					<SegmentedControl
						size="xs"
						fullWidth
						value={fastModeOverride}
						onChange={(value) =>
							fastModeMutation.mutate({
								id: narratorId,
								fastModeOverride: value as FastModeOverride,
							})
						}
						data={[
							{
								value: "inherit",
								label: t(isSubagent ? "fast_mode_session_primary" : "fast_mode_session_inherit"),
							},
							{ value: "on", label: t("fast_mode_on") },
							{ value: "off", label: t("fast_mode_off") },
						]}
					/>
					<Text size="xs" c={sourceUnavailable ? "orange" : "dimmed"}>
						{sourceUnavailable
							? t("fast_mode_source_unavailable")
							: t(isSubagent ? "fast_mode_primary_desc" : "fast_mode_session_desc")}
					</Text>
					{!isSubagent && (
						<>
							<Switch
								size="sm"
								checked={fastModeDefault}
								onChange={(event) =>
									updateUserPrefs.mutate({ fastModeDefault: event.currentTarget.checked })
								}
								label={t("fast_mode_default_switch")}
							/>
							<Text size="xs" c="dimmed">
								{fastModeDefault ? t("fast_mode_default_on_desc") : t("fast_mode_default_off_desc")}
							</Text>
						</>
					)}
					<Text size="xs" c="dimmed">
						{fastModeUsesTapSettings ? t("fast_mode_mobile_hint") : t("fast_mode_desktop_hint")}
					</Text>
				</Stack>
			</Popover.Dropdown>
		</Popover>
	);
}

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

type FastModeOverride = "inherit" | "on" | "off";

export interface FastModeControlProps {
	/** Popover placement — desktop uses top-end, the mobile toolbar bottom-end. */
	position: "top-end" | "bottom-end";
	/** Session-level override; "inherit" follows the user default. */
	fastModeOverride: FastModeOverride;
	/** The user-level default fast-mode state (what "inherit" resolves to). */
	fastModeDefault: boolean;
	/** Effective state after resolving inherit — drives the icon colour. */
	fastModeEnabled: boolean;
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
	// biome-ignore lint/suspicious/noExplicitAny: mutation object passthrough from useUpdateFastMode.
	fastModeMutation: any;
	// biome-ignore lint/suspicious/noExplicitAny: mutation object passthrough from useUpdateUserPreferences.
	updateUserPrefs: any;
	/** narrator translation fn (namespace "narrator"). */
	t: (key: string, opts?: Record<string, unknown>) => string;
}

/**
 * Fast-mode toggle button + its settings popover (session override segmented
 * control + user-default switch). Extracted verbatim from NarratorPanel; all
 * state/handlers are injected so behaviour is identical across the desktop and
 * mobile status-bar mounts.
 */
export function FastModeControl(props: FastModeControlProps) {
	const {
		position,
		fastModeOverride,
		fastModeDefault,
		fastModeEnabled,
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
								? t("fast_mode_inherit_tooltip", {
										state: fastModeDefault ? t("fast_mode_on") : t("fast_mode_off"),
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
								// Clicking pins this session against its current effective
								// state; the popover restores "follow default".
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
								label: t("fast_mode_session_inherit", {
									state: fastModeDefault ? t("fast_mode_on") : t("fast_mode_off"),
								}),
							},
							{ value: "on", label: t("fast_mode_on") },
							{ value: "off", label: t("fast_mode_off") },
						]}
					/>
					<Text size="xs" c="dimmed">
						{t("fast_mode_session_desc")}
					</Text>
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
					<Text size="xs" c="dimmed">
						{fastModeUsesTapSettings ? t("fast_mode_mobile_hint") : t("fast_mode_desktop_hint")}
					</Text>
				</Stack>
			</Popover.Dropdown>
		</Popover>
	);
}

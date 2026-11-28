import type React from "react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { FastModeControl } from "./FastModeControl";
import { type FastModeOverride, fastModePresentation } from "./fast-mode-state";
import type { Mutate } from "./mutate";

export interface UseFastModeControlOptions {
	narratorId: string;
	/** Session choice: inherit follows the primary for children, execution user's default otherwise. */
	narratorFastModeOverride: FastModeOverride | null | undefined;
	effectiveFastMode: boolean | undefined;
	fastModeSource: string | undefined;
	isSubagent: boolean;
	/** The viewing user's editable preference, never used to resolve this session. */
	fastModeDefault: boolean;
	/** Coarse-pointer / mobile viewports open settings by long-press, not hover. */
	fastModeUsesTapSettings: boolean;
	fastModeMutation: Mutate<{ id: string; fastModeOverride: "inherit" | "on" | "off" }>;
	updateUserPrefs: Mutate<{ fastModeDefault: boolean }>;
	/** narrator translation fn (namespace "narrator"). */
	t: (key: string, opts?: Record<string, unknown>) => string;
}

export interface UseFastModeControlResult {
	/** Renders the fast-mode toggle + settings popover at the given placement. */
	renderFastModeControl: (position: "top-end" | "bottom-end") => ReactNode;
}

/**
 * Fast-mode toggle state machine: the settings popover open state, its
 * hover-close debounce timer, and the coarse-pointer long-press timer that opens
 * the popover on touch. Returns a `renderFastModeControl(position)` that mounts
 * {@link FastModeControl} with all state/handlers wired — used by both the desktop
 * and mobile status-bar placements.
 *
 * Kept lifted (called from the panel): the rendered control is threaded into the
 * status-bar control-menu object the panel builds; the state is shared by both
 * placements through this single instance.
 */
export function useFastModeControl(options: UseFastModeControlOptions): UseFastModeControlResult {
	const {
		narratorId,
		narratorFastModeOverride,
		effectiveFastMode,
		fastModeSource,
		isSubagent,
		fastModeDefault,
		fastModeUsesTapSettings,
		fastModeMutation,
		updateUserPrefs,
		t,
	} = options;

	const {
		override: fastModeOverride,
		enabled: fastModeEnabled,
		sourceUnavailable,
	} = fastModePresentation({
		fastModeOverride: narratorFastModeOverride,
		effectiveFastMode,
		fastModeSource,
	});

	const [fastModeSettingsOpened, setFastModeSettingsOpened] = useState(false);
	const fastModeSettingsCloseTimerRef = useRef<number | null>(null);
	const fastModeLongPressTimerRef = useRef<number | null>(null);
	const fastModeLongPressFiredRef = useRef(false);

	const clearFastModeSettingsCloseTimer = useCallback(() => {
		if (fastModeSettingsCloseTimerRef.current != null) {
			window.clearTimeout(fastModeSettingsCloseTimerRef.current);
			fastModeSettingsCloseTimerRef.current = null;
		}
	}, []);

	const clearFastModeLongPressTimer = useCallback(() => {
		if (fastModeLongPressTimerRef.current != null) {
			window.clearTimeout(fastModeLongPressTimerRef.current);
			fastModeLongPressTimerRef.current = null;
		}
	}, []);

	const openFastModeSettings = useCallback(() => {
		clearFastModeSettingsCloseTimer();
		setFastModeSettingsOpened(true);
	}, [clearFastModeSettingsCloseTimer]);

	const closeFastModeSettings = useCallback(() => {
		clearFastModeSettingsCloseTimer();
		setFastModeSettingsOpened(false);
	}, [clearFastModeSettingsCloseTimer]);

	const scheduleFastModeSettingsClose = useCallback(() => {
		if (fastModeUsesTapSettings) return;
		clearFastModeSettingsCloseTimer();
		fastModeSettingsCloseTimerRef.current = window.setTimeout(() => {
			setFastModeSettingsOpened(false);
			fastModeSettingsCloseTimerRef.current = null;
		}, 180);
	}, [clearFastModeSettingsCloseTimer, fastModeUsesTapSettings]);

	const startFastModeLongPress = useCallback(
		(event: React.PointerEvent) => {
			fastModeLongPressFiredRef.current = false;
			if (!fastModeUsesTapSettings || event.pointerType === "mouse") return;
			clearFastModeLongPressTimer();
			fastModeLongPressTimerRef.current = window.setTimeout(() => {
				fastModeLongPressFiredRef.current = true;
				fastModeLongPressTimerRef.current = null;
				openFastModeSettings();
			}, 550);
		},
		[clearFastModeLongPressTimer, fastModeUsesTapSettings, openFastModeSettings],
	);

	useEffect(() => {
		return () => {
			clearFastModeSettingsCloseTimer();
			clearFastModeLongPressTimer();
		};
	}, [clearFastModeLongPressTimer, clearFastModeSettingsCloseTimer]);

	const renderFastModeControl = useCallback(
		(position: "top-end" | "bottom-end") => (
			<FastModeControl
				position={position}
				fastModeOverride={fastModeOverride}
				fastModeDefault={fastModeDefault}
				fastModeEnabled={fastModeEnabled}
				sourceUnavailable={sourceUnavailable}
				isSubagent={isSubagent}
				fastModeUsesTapSettings={fastModeUsesTapSettings}
				settingsOpened={fastModeSettingsOpened}
				setSettingsOpened={setFastModeSettingsOpened}
				openSettings={openFastModeSettings}
				closeSettings={closeFastModeSettings}
				scheduleSettingsClose={scheduleFastModeSettingsClose}
				startLongPress={startFastModeLongPress}
				clearLongPressTimer={clearFastModeLongPressTimer}
				longPressFiredRef={fastModeLongPressFiredRef}
				narratorId={narratorId}
				fastModeMutation={fastModeMutation}
				updateUserPrefs={updateUserPrefs}
				t={t}
			/>
		),
		[
			fastModeOverride,
			fastModeDefault,
			fastModeEnabled,
			sourceUnavailable,
			isSubagent,
			fastModeUsesTapSettings,
			fastModeSettingsOpened,
			openFastModeSettings,
			closeFastModeSettings,
			scheduleFastModeSettingsClose,
			startFastModeLongPress,
			clearFastModeLongPressTimer,
			narratorId,
			fastModeMutation,
			updateUserPrefs,
			t,
		],
	);

	return { renderFastModeControl };
}

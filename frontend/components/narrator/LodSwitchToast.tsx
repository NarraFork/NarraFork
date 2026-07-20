import { Box, Group, Text } from "@mantine/core";
import {
	IconBaselineDensityLarge,
	IconBaselineDensityMedium,
	IconBaselineDensitySmall,
} from "@tabler/icons-react";
import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MIN_RENDER_LOD, type RenderLod } from "./RenderLodCtx";

/** How long the indicator stays fully visible before fading out. */
const HOLD_MS = 750;
/** Stable keys for the fixed notch scale (avoids array-index keys). */
const NOTCH_IDS = ["n1", "n2", "n3", "n4", "n5", "n6"] as const;

/**
 * LodSwitchToast — a brief, name-free visual confirmation shown when the
 * render LOD changes. Renders a density icon plus a 6-notch scale with the
 * current notch highlighted; the internal level number is never displayed.
 *
 * The fade is driven by React state (not a one-shot CSS `forwards` animation),
 * and the toast remounts per change (`key={display.lod}-${display.seq}`), so
 * it replays reliably on every change — including rapid consecutive switches
 * to the same level.
 */
export const LodSwitchToast = memo(function LodSwitchToast({
	lod,
	isDefault = true,
	onSetAsDefault,
}: {
	lod: RenderLod;
	/** Whether `lod` is already the saved default — hides the action when true. */
	isDefault?: boolean;
	/** Called when the user clicks the toast to save the current level as default. */
	onSetAsDefault?: () => void;
}) {
	const { t } = useTranslation("narrator");
	// `display` is null until the first actual level CHANGE (mount is silent).
	const [display, setDisplay] = useState<{ lod: RenderLod; seq: number } | null>(null);
	const [fading, setFading] = useState(false);
	const prevLodRef = useRef(lod);
	const seqRef = useRef(0);
	const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (prevLodRef.current === lod) return;
		prevLodRef.current = lod;
		// Actual change: (re)show immediately, then hold → fade → unmount.
		seqRef.current += 1;
		setDisplay({ lod, seq: seqRef.current });
		setFading(false);
		if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
		if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
		holdTimerRef.current = setTimeout(() => setFading(true), HOLD_MS);
		hideTimerRef.current = setTimeout(() => setDisplay(null), HOLD_MS + 200);
		return () => {
			if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
			if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
		};
	}, [lod]);

	if (display === null) return null;

	const { lod: shownLod, seq } = display;
	const DensityIcon =
		shownLod >= 5
			? IconBaselineDensitySmall
			: shownLod >= 3
				? IconBaselineDensityMedium
				: IconBaselineDensityLarge;
	// Map level (1..6) to "filled" notches: more detail = more filled notches.
	const filled = shownLod - MIN_RENDER_LOD + 1;
	// The toast is clickable only when there's an action to take (a non-default
	// level the user can save) and a handler is wired.
	const clickable = !isDefault && !!onSetAsDefault;

	return (
		<Box
			key={`${shownLod}-${seq}`}
			role={clickable ? "button" : "status"}
			aria-label={clickable ? t("lodSetAsDefault") : t("lodDensity")}
			title={clickable ? t("lodSetAsDefault") : undefined}
			onClick={clickable ? onSetAsDefault : undefined}
			style={{
				position: "absolute",
				top: "50%",
				left: "50%",
				transform: "translate(-50%, -50%)",
				// Above the message list content (chunk rows, overlays) so it is never
				// occluded mid-switch.
				zIndex: 100,
				pointerEvents: clickable ? "auto" : "none",
				cursor: clickable ? "pointer" : "default",
				background: "var(--mantine-color-dark-7)",
				border: `1px solid ${
					clickable ? "var(--mantine-color-indigo-6)" : "var(--mantine-color-default-border)"
				}`,
				borderRadius: "var(--mantine-radius-md)",
				padding: "10px 14px",
				boxShadow: "var(--mantine-shadow-md)",
				opacity: fading ? 0 : 1,
				transition: "opacity 180ms ease",
				animation: "lod-toast-pop 160ms ease",
			}}
		>
			<Group gap={10} align="center" wrap="nowrap">
				<DensityIcon size={20} style={{ color: "var(--mantine-color-indigo-4)" }} />
				<Group gap={4} wrap="nowrap">
					{NOTCH_IDS.map((notchId, i) => {
						const active = i < filled;
						return (
							<Box
								key={notchId}
								style={{
									width: 6,
									height: 16,
									borderRadius: 2,
									background: active
										? "var(--mantine-color-indigo-5)"
										: "var(--mantine-color-dark-4)",
								}}
							/>
						);
					})}
				</Group>
				<Text size="xs" c={clickable ? "indigo.3" : "dimmed"} style={{ whiteSpace: "nowrap" }}>
					{clickable ? t("lodSetAsDefault") : t("lodDensity")}
				</Text>
			</Group>
		</Box>
	);
});

// Keyframes for the brief pop-in on each (re)mount.
if (typeof document !== "undefined") {
	const id = "lod-toast-style";
	if (!document.getElementById(id)) {
		const style = document.createElement("style");
		style.id = id;
		style.textContent = `
@keyframes lod-toast-pop {
  0% { opacity: 0; transform: translate(-50%, -50%) scale(0.92); }
  100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
}
@media (prefers-reduced-motion: reduce) {
  .lod-toast-pop { animation: none; }
}
`;
		document.head.appendChild(style);
	}
}

import { ActionIcon, Box, Group, Stack, Text, UnstyledButton } from "@mantine/core";
import {
	IconBaselineDensityLarge,
	IconBaselineDensityMedium,
	IconBaselineDensitySmall,
	IconMinus,
	IconPlus,
} from "@tabler/icons-react";
import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	isLodStepDisabled,
	LOD_LEVELS,
	resolveLodFilledNotches,
	resolveLodIndicatorVisibility,
	resolveLodStepTarget,
} from "./lod-indicator";
import type { RenderLod } from "./RenderLodCtx";

/** How long the indicator stays fully visible before fading out. */
const HOLD_MS = 750;

/**
 * LodSwitchToast — the render-LOD indicator.
 *
 * ONE appearance, always: a density icon, a 6-notch gauge where every notch is
 * its own click target, and −/+ steppers on either side. Notched wheels report a
 * huge delta per detent, so alt+wheel alone made the middle levels hard to land
 * on and was unreachable without a wheel; the click targets fix that, and they
 * are present whether the indicator appeared from a gesture or from holding Alt.
 * Earlier this widget swapped between a read-only gauge and a picker depending on
 * how it was summoned, which read as two different widgets.
 *
 * Only longevity varies. It holds open while Alt is down over the panel OR while
 * the pointer is inside the indicator, and otherwise fades shortly after a level
 * change. Hovering counts because adjusting the level is rarely one click: the
 * pointer is still on the control after the first pick, and fading there would
 * pull the widget away mid-adjustment.
 *
 * The fade is driven by React state (not a one-shot CSS `forwards` animation) so
 * it replays reliably on every change, including rapid consecutive switches to the
 * same level.
 */
export const LodSwitchToast = memo(function LodSwitchToast({
	lod,
	isDefault = true,
	onSetAsDefault,
	onSelectLod,
	pinned = false,
}: {
	lod: RenderLod;
	/** Whether `lod` is already the saved default — hides the action when true. */
	isDefault?: boolean;
	/** Called when the user asks to save the current level as the default. */
	onSetAsDefault?: () => void;
	/** Called with an explicit level when the user picks one. */
	onSelectLod?: (next: RenderLod) => void;
	/** Keep the indicator on screen instead of letting it fade (Alt held). */
	pinned?: boolean;
}) {
	const { t } = useTranslation("narrator");
	// Counts level changes and is null until the first actual CHANGE, so mounting
	// is silent. A monotonic counter rather than the level itself: two consecutive
	// changes landing on the same level must still re-arm the hide schedule.
	const [changeSeq, setChangeSeq] = useState<number | null>(null);
	const [fading, setFading] = useState(false);
	const [hovered, setHovered] = useState(false);
	const prevLodRef = useRef(lod);

	// A level change makes the indicator appear (or restarts its life). This effect
	// deliberately does NOT arm the fade timers — doing that here is what made a
	// click while Alt was held close the widget the user was still working with.
	useEffect(() => {
		if (prevLodRef.current === lod) return;
		prevLodRef.current = lod;
		setChangeSeq((prev) => (prev ?? 0) + 1);
		setFading(false);
	}, [lod]);

	const { visible, fades } = resolveLodIndicatorVisibility({
		pinned,
		hovered,
		gestureVisible: changeSeq !== null,
	});

	// Single owner of the hide schedule. It re-runs when the indicator's life
	// restarts (`changeSeq`) or the hold-open condition changes, so releasing Alt or
	// moving the pointer away starts the fade, while a level change during hold-open
	// schedules nothing at all.
	useEffect(() => {
		if (!fades || changeSeq === null) {
			setFading(false);
			return;
		}
		const holdTimer = setTimeout(() => setFading(true), HOLD_MS);
		const hideTimer = setTimeout(() => setChangeSeq(null), HOLD_MS + 200);
		return () => {
			clearTimeout(holdTimer);
			clearTimeout(hideTimer);
		};
	}, [fades, changeSeq]);

	// A hover state can outlive its element (the node is removed from under a
	// stationary pointer, which fires no mouseleave) and would then hold the NEXT
	// appearance open forever. Drop it whenever the indicator is off screen.
	useEffect(() => {
		if (!visible) setHovered(false);
	}, [visible]);

	// Leaving the page (alt+tab, minimise, switching desktops) moves the pointer
	// out of the document without ever firing mouseleave, because the pointer does
	// not physically move. `hovered` would then stay latched and — together with
	// `pinned` being reset on blur — leave the indicator parked on screen with
	// nothing left to dismiss it. Treat losing the window as leaving the widget.
	useEffect(() => {
		const drop = () => setHovered(false);
		window.addEventListener("blur", drop);
		document.addEventListener("visibilitychange", drop);
		return () => {
			window.removeEventListener("blur", drop);
			document.removeEventListener("visibilitychange", drop);
		};
	}, []);

	if (!visible) return null;

	// Always the live level: the gauge doubles as the control the user is steering,
	// so showing a stale snapshot next to working steppers would contradict itself.
	const shownLod = lod;
	const DensityIcon =
		shownLod >= 5
			? IconBaselineDensitySmall
			: shownLod >= 3
				? IconBaselineDensityMedium
				: IconBaselineDensityLarge;
	const filled = resolveLodFilledNotches(shownLod);
	// "Set as default" appears only when there's something to save (a non-default
	// level) and a handler is wired.
	const canSetDefault = !isDefault && !!onSetAsDefault;

	const step = (dir: 1 | -1) => onSelectLod?.(resolveLodStepTarget(shownLod, dir));

	return (
		<Box
			// No `key` that varies with the level: remounting per change would drop the
			// hover/press the user is in the middle of, and a freshly inserted node
			// under a stationary cursor receives no mouseenter — the hold-open hover
			// would be lost the instant the level changed. The pop therefore plays on
			// appearance only, which is also calmer for a control that stays put.
			data-testid="lod-indicator"
			data-lod-pinned={pinned ? "true" : "false"}
			data-lod-holding={fades ? "false" : "true"}
			role="status"
			aria-label={t("lodDensity")}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			style={{
				position: "absolute",
				top: "50%",
				left: "50%",
				transform: "translate(-50%, -50%)",
				// Above the message list content (chunk rows, overlays) so it is never
				// occluded mid-switch.
				zIndex: 100,
				// Clickable while it is actually visible, inert the moment it starts
				// fading: an invisible overlay parked over the middle of the message
				// list would otherwise swallow clicks meant for the messages.
				pointerEvents: fading ? "none" : "auto",
				background: "var(--mantine-color-dark-7)",
				border: "1px solid var(--mantine-color-indigo-6)",
				borderRadius: "var(--mantine-radius-md)",
				padding: "10px 14px",
				boxShadow: "var(--mantine-shadow-md)",
				opacity: fading ? 0 : 1,
				transition: "opacity 180ms ease",
				// Unconditional, so it plays once when the indicator appears. Gating it
				// on `fades` would replay the pop every time the pointer left the
				// widget, since toggling the property restarts the animation.
				animation: "lod-toast-pop 160ms ease",
			}}
		>
			<Stack gap={8} align="center">
				<Group gap={10} align="center" wrap="nowrap">
					<ActionIcon
						variant="subtle"
						color="gray"
						size="sm"
						data-testid="lod-step-down"
						aria-label={t("lodLessDetail")}
						title={t("lodLessDetail")}
						disabled={isLodStepDisabled(shownLod, -1)}
						onClick={() => step(-1)}
					>
						<IconMinus size={14} />
					</ActionIcon>
					<DensityIcon size={20} style={{ color: "var(--mantine-color-indigo-4)" }} />
					<Group gap={4} wrap="nowrap">
						{LOD_LEVELS.map((level, i) => {
							const active = i < filled;
							const background = active
								? "var(--mantine-color-indigo-5)"
								: "var(--mantine-color-dark-4)";
							// Each notch is its own target. The hit area is padded well beyond
							// the 6px bar so it stays clickable on touch too, while the bar
							// itself keeps the compact gauge look.
							return (
								<UnstyledButton
									key={level}
									data-testid="lod-notch"
									data-lod-level={level}
									aria-label={t("lodSelectLevel", { level })}
									aria-current={level === shownLod ? "true" : undefined}
									title={t("lodSelectLevel", { level })}
									onClick={() => onSelectLod?.(level)}
									style={{
										display: "flex",
										alignItems: "center",
										justifyContent: "center",
										width: 14,
										height: 26,
										borderRadius: 3,
										cursor: "pointer",
									}}
								>
									<Box
										style={{
											width: 6,
											height: level === shownLod ? 22 : 16,
											borderRadius: 2,
											background,
											outline:
												level === shownLod ? "1px solid var(--mantine-color-indigo-3)" : undefined,
											transition: "height 100ms ease",
										}}
									/>
								</UnstyledButton>
							);
						})}
					</Group>
					<ActionIcon
						variant="subtle"
						color="gray"
						size="sm"
						data-testid="lod-step-up"
						aria-label={t("lodMoreDetail")}
						title={t("lodMoreDetail")}
						disabled={isLodStepDisabled(shownLod, 1)}
						onClick={() => step(1)}
					>
						<IconPlus size={14} />
					</ActionIcon>
				</Group>
				{/* The caption line sits BELOW the gauge rather than beside it. Beside
				    the notches it grew the row sideways, which moved the steppers away
				    from where the pointer already was and made the gauge — the row the
				    eye actually tracks — no longer centered on the indicator. */}
				{canSetDefault ? (
					<UnstyledButton
						data-testid="lod-set-default"
						onClick={onSetAsDefault}
						aria-label={t("lodSetAsDefault")}
						title={t("lodSetAsDefault")}
						style={{ cursor: "pointer" }}
					>
						<Text size="xs" c="indigo.3" style={{ whiteSpace: "nowrap" }}>
							{t("lodSetAsDefault")}
						</Text>
					</UnstyledButton>
				) : (
					<Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
						{t("lodDensity")}
					</Text>
				)}
			</Stack>
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

/**
 * VListTouchScrollTopButton.tsx — a touch surface's way back to a body's head.
 *
 * The desktop affordance lives inside the hover action bar
 * (`VListContentViewActions`): once a capped body's head has scrolled past the
 * viewport top, the bar floats and gains a "read from the start" button. A touch
 * pointer cannot hover, so the bar never mounts there — and with it went the
 * ONLY one-tap route back to the head of a long body (the alternative is
 * dragging the scroller back up by hand).
 *
 * On a touch surface this button takes over that one job, standing alone:
 * painted whenever the bar WOULD be floating (head gone, enough of the body
 * left to be reading), one size up from the bar's buttons for a finger. It is
 * portaled to `<body>` and `position: fixed` for the same reason the floating
 * bar is — the row's `overflow:hidden` would clip it, and scroll-invariant
 * coordinates keep it from jittering.
 *
 * FLICKER CONTROL
 *
 * A fast fling walks bodies through their floating window in a few frames each;
 * a strictly state-driven button strobes with them. Two dampers instead:
 *
 *   - the host keeps the button MOUNTED for a short linger after the float
 *     state leaves "floating" (`visible: false`), so a boundary crossing fades
 *     out instead of blinking off, and a re-entry within the linger reuses the
 *     same element — no unmount/remount flash;
 *   - the button itself fades: in from opacity 0 on its first painted frame
 *     (a mount at full opacity would still read as a blink), out while the
 *     linger runs down.
 *
 * Height neutrality: fixed and portaled, it occupies no measured pixel and
 * cannot move the row it decorates (CONTRACT §0).
 */

import { Z } from "@frontend/lib/z-index";
import { ActionIcon, Tooltip } from "@mantine/core";
import { IconArrowBarToUp } from "@tabler/icons-react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { MESSAGE_SELECTION_IGNORE_ATTR } from "../message/MessageSelectionCtx";

/** One size up from the bar's `xs` buttons — this is a finger target. */
const BUTTON_SIZE = "md" as const;
const ICON_SIZE = 14;

/**
 * Fade duration (ms) for both directions. Short enough that a genuine state
 * change still reads as immediate, long enough that a fast scroll's boundary
 * crossings blend instead of strobing.
 */
const FADE_MS = 180;

/**
 * The mount fade-in keyframe (declared in `styles/vlist-touch-scroll-top.css` —
 * inline styles cannot declare @keyframes). Applied as a CONSTANT: it runs
 * exactly once when the element mounts (the host only mounts the button with
 * `visible: true`), and since the property value never changes afterwards it
 * can never restart — fade-out and linger re-entries are handled by the
 * `opacity` transition alone.
 */
const MOUNT_ANIMATION = `nf-vlist-touch-scroll-top-in ${FADE_MS}ms ease`;

function buttonStyle(top: number, right: number, shown: boolean): CSSProperties {
	return {
		position: "fixed",
		top,
		right,
		zIndex: Z.popover,
		opacity: shown ? 1 : 0,
		transition: `opacity ${FADE_MS}ms ease`,
		animation: MOUNT_ANIMATION,
	};
}

export interface VListTouchScrollTopButtonProps {
	/**
	 * Viewport coordinates, from the same float geometry the bar uses. The host
	 * FREEZES them while the button lingers faded-out: the parked/hidden float
	 * states carry placeholder zeros, which would teleport the button to the
	 * viewport's top-left corner mid-fade.
	 */
	top: number;
	right: number;
	onScrollToTop: () => void;
	/**
	 * False while the host keeps the button mounted for its fade-out linger.
	 * The button stays clickable in that window — the action is still valid
	 * (scrolling back to a body that just left the fold is the point), and a
	 * pass-through tap would otherwise arm the body's double-tap shortcut.
	 */
	visible: boolean;
}

export function VListTouchScrollTopButton({
	top,
	right,
	onScrollToTop,
	visible,
}: VListTouchScrollTopButtonProps) {
	const { t } = useTranslation("narrator");
	return createPortal(
		<Tooltip label={t("readFromStart")} withArrow position="left">
			<ActionIcon
				size={BUTTON_SIZE}
				variant="filled"
				color="gray"
				onClick={(event) => {
					// Portaled, so the tap still bubbles through the REACT tree to the body
					// host, which counts two taps as "open fullscreen". Scrolling back twice
					// in a row must not throw the reader into the modal.
					event.stopPropagation();
					onScrollToTop();
				}}
				aria-label={t("readFromStart")}
				style={buttonStyle(top, right, visible)}
				data-vlist-touch-scroll-top
				data-vlist-touch-scroll-top-shown={visible ? "true" : "false"}
				{...{ [MESSAGE_SELECTION_IGNORE_ATTR]: "" }}
			>
				<IconArrowBarToUp size={ICON_SIZE} />
			</ActionIcon>
		</Tooltip>,
		document.body,
	);
}

/**
 * VListCodeCopyButton.tsx — the copy affordance for ONE fenced code panel in the
 * pretext vlist.
 *
 * The chunked path gets this from `MarkdownCodeBlock`: a small filled ActionIcon
 * pinned to the code panel's top-right corner, revealed on hover. The exact vlist
 * painted its code panels as bare absolutely-positioned line stacks, so a fenced
 * block could only be copied by hand-selecting it — or by copying the WHOLE row
 * from the row menu, which drags in all the surrounding prose.
 *
 * Height neutrality (CONTRACT.md §0 iron law 2): this is an absolute overlay
 * INSIDE the panel box the measure layer already reserved, so it occupies no
 * measured pixel and cannot move anything. The overlay is always mounted but
 * visually hidden (`visibility: hidden` + `tabIndex: -1`) until the panel is
 * hovered or focused — this avoids a "phantom tab stop" while keeping the
 * button reachable by keyboard when the panel receives focus. The i18n lookup
 * still only happens when the component mounts (once per visible panel).
 *
 * Living in vlist/ root rather than render/ keeps the pure render copies free of
 * app imports (i18n, the selection contract) while the render layer only decides
 * WHERE the overlay goes — the same split `RenderToolCall` ↔ `VListContentViewHost`
 * already uses.
 */

import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import { ActionIcon, CopyButton, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { type CSSProperties, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRenderInteractive } from "../lod/RenderLodCtx";
import { MESSAGE_SELECTION_IGNORE_ATTR } from "../message/MessageSelectionCtx";
import { type CodeCopyPlacement, VIEW_ACTION_BAR_GAP } from "./vlist-content-view-float";

const ICON_SIZE = 12;
/** Larger glyph for the touch variant, matching its larger button. */
const TOUCH_ICON_SIZE = 14;

/**
 * A pointer that cannot hover. The whole reveal-on-hover contract below is
 * unreachable on such a device, so the overlay stays painted instead.
 *
 * Same query NarratorPanel uses for its own touch branch; `hover: none` alone
 * would miss a coarse pointer that still reports hover support, and
 * `pointer: coarse` alone would miss a hoverless fine pointer (a TV remote).
 */
const TOUCH_POINTER_MEDIA_QUERY = "(hover: none), (pointer: coarse)";

/**
 * Read one media query, synchronously on the first render.
 *
 * Deliberately NOT Mantine's `useMediaQuery`: several vlist suites replace the
 * whole `@mantine/hooks` module with a stub that hardcodes `useMediaQuery: () =>
 * false`, and `mock.module` leaks across files under `bun test`. Depending on it
 * here would make this component's touch branch untestable — and, worse, silently
 * dead in whichever suites happen to run after such a mock. The subscription is
 * six lines, so owning it costs less than the coupling.
 *
 * The first value is read during render (not in an effect) because a phone reader
 * would otherwise watch the button appear one frame late.
 */
function useMatchMedia(query: string): boolean {
	const [matches, setMatches] = useState(() => {
		if (typeof window === "undefined") return false;
		return window.matchMedia?.(query).matches === true;
	});
	useEffect(() => {
		const list = window.matchMedia?.(query);
		if (!list) return;
		setMatches(list.matches);
		const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
		// `addListener` is the Safari < 14 spelling; both are optional on the stubs
		// the test suites install, hence the guards.
		list.addEventListener?.("change", onChange);
		return () => list.removeEventListener?.("change", onChange);
	}, [query]);
	return matches;
}

/**
 * Whether this panel must paint a permanently visible, finger-sized copy button,
 * and whether the row's action bar can be in its way.
 *
 * Both answers come from media queries rather than from the render tree because
 * neither fact is a property of the markdown: `VListContentViewHost` mounts its
 * hover bar only on a non-mobile VIEWPORT, and only a hoverable POINTER can
 * reveal anything. The two are read separately because they answer different
 * questions — a narrow desktop window has no bar but still hovers.
 */
function useTouchCopyMode(): { alwaysVisible: boolean; barCanCover: boolean } {
	const touchPointer = useMatchMedia(TOUCH_POINTER_MEDIA_QUERY);
	const mobileViewport = useMatchMedia(MOBILE_VIEWPORT_MEDIA_QUERY);
	return {
		// Reveal-on-hover is unreachable → paint it and leave it painted.
		alwaysVisible: touchPointer,
		// `VListContentViewHost` mounts its bar only on a non-mobile viewport, so on a
		// mobile one the panel's top corner is free — and the `hidden` outcome would
		// delete the only copy affordance a phone reader has. A desktop-width touch
		// screen keeps the dodges: there the bar really can appear (browsers emulate
		// `mouseenter` on tap) and would cover the button.
		barCanCover: !mobileViewport,
	};
}

/**
 * The panel's top-right corner, matching MarkdownContent.module.css `.codeCopy`.
 *
 * `zIndex: 1` sits deliberately BELOW `VListContentViewActions` (which uses 2): a
 * code block at the very top of a row shares that corner with the row-level view
 * bar, and the row bar — the one offering fullscreen / wrap / whole-body copy —
 * must stay on top, the same ordering the chunked path has.
 */
const overlayStyle: CSSProperties = {
	position: "absolute",
	top: VIEW_ACTION_BAR_GAP,
	right: VIEW_ACTION_BAR_GAP,
	zIndex: 1,
};

/**
 * The panel's BOTTOM-right corner, used when the row's hover bar has claimed the
 * top one (this panel leads the body).
 *
 * Vertical rather than horizontal displacement: parking the button beside the row
 * bar put five grey icons in one strip, two of them copy glyphs with different
 * scopes — visually noisy and genuinely ambiguous about what would be copied.
 * The opposite corner keeps the button unmistakably attached to this panel.
 */
const bottomOverlayStyle: CSSProperties = {
	position: "absolute",
	bottom: VIEW_ACTION_BAR_GAP,
	right: VIEW_ACTION_BAR_GAP,
	zIndex: 1,
};

export interface VListCodeCopyButtonProps {
	/** The panel's source text — exactly what a reader expects on the clipboard. */
	value: string;
	/**
	 * When `true`, the overlay is visually hidden and removed from the tab order.
	 * This allows the button to stay mounted (so focus-within logic works at the
	 * container level) while remaining invisible and unreachable until the panel
	 * is hovered or focused.
	 *
	 * Ignored on a hoverless pointer: nothing there can ever clear the flag, so
	 * honouring it would leave the button permanently invisible.
	 */
	hidden?: boolean;
	/**
	 * Which corner of the panel to occupy. `hidden` (too short a panel with the
	 * row bar on its top corner) renders nothing at all — see
	 * `resolveCodeCopyPlacement`. Defaults to the conventional top-right.
	 *
	 * Both non-default outcomes only exist to dodge the row's hover action bar, so
	 * both are ignored where that bar cannot appear (touch / mobile viewport).
	 */
	placement?: CodeCopyPlacement;
}

/**
 * Copy one code panel's source. Renders nothing on a read-only surface (preview
 * panes set `interactive: false`) or for an empty panel.
 *
 * TOUCH SURFACES
 * The hover contract above has no equivalent on a phone: there is no hover, and
 * the row's action bar (which carried the fallback whole-body copy button) is not
 * mounted on a mobile viewport either. A fenced block was therefore uncopyable
 * except by hand-selection. On such a surface the button is painted permanently,
 * at the conventional top-right corner and one size up for a finger.
 */
export function VListCodeCopyButton({
	value,
	hidden,
	placement = "top-right",
}: VListCodeCopyButtonProps) {
	const { t } = useTranslation("common");
	const interactive = useRenderInteractive();
	const { alwaysVisible, barCanCover } = useTouchCopyMode();
	if (!interactive || value.length === 0) return null;
	// Without the row bar in the picture, both dodges are pointless: `bottom-right`
	// would park the button away from the panel's head for no reason, and `hidden`
	// would delete the ONLY copy affordance a touch reader has.
	const effectivePlacement: CodeCopyPlacement = barCanCover ? placement : "top-right";
	// Nowhere clear of the row bar to paint: the bar's own copy button covers this
	// corner, so a per-panel button here would just be an unclickable duplicate.
	if (effectivePlacement === "hidden") return null;
	const isHidden = hidden === true && !alwaysVisible;

	return (
		// Marked selection-ignore so a Ctrl/Cmd-click aimed at the button cannot
		// double as a block-selection toggle (same contract as the row view bar).
		<div
			style={{
				...(effectivePlacement === "bottom-right" ? bottomOverlayStyle : overlayStyle),
				visibility: isHidden ? "hidden" : "visible",
				opacity: isHidden ? 0 : 1,
				transition: "opacity 0.15s, visibility 0.15s",
			}}
			data-vlist-code-copy
			data-vlist-code-copy-placement={effectivePlacement}
			// Present so a test (and a reader inspecting the DOM) can tell the touch
			// variant from the hover one without re-deriving the media queries.
			{...(alwaysVisible ? { "data-vlist-code-copy-touch": "" } : {})}
			// The exact text this overlay will put on the clipboard. Present so a test
			// can assert WHAT gets copied without reaching into Mantine's clipboard
			// hook (which other suites replace with a module mock) or stubbing
			// `navigator.clipboard`. Length only, never the text itself, would not
			// catch the failure mode worth guarding: copying the whole markdown body
			// instead of just this panel.
			data-vlist-code-copy-value={value}
			{...{ [MESSAGE_SELECTION_IGNORE_ATTR]: "" }}
		>
			<CopyButton value={value} timeout={2000}>
				{({ copied, copy }) => (
					<Tooltip label={copied ? t("copied") : t("copy")} withArrow position="left">
						<ActionIcon
							size={alwaysVisible ? "md" : "xs"}
							variant="filled"
							color={copied ? "teal" : "gray"}
							onClick={(event) => {
								// The tap must not also read as a tap on the BODY: its host counts two
								// body taps as "open fullscreen" (VListContentViewHost), so copying
								// twice in a row would have thrown the reader into the modal.
								event.stopPropagation();
								copy();
							}}
							aria-label={copied ? t("copied") : t("copy")}
							tabIndex={isHidden ? -1 : 0}
						>
							{copied ? (
								<IconCheck size={alwaysVisible ? TOUCH_ICON_SIZE : ICON_SIZE} />
							) : (
								<IconCopy size={alwaysVisible ? TOUCH_ICON_SIZE : ICON_SIZE} />
							)}
						</ActionIcon>
					</Tooltip>
				)}
			</CopyButton>
		</div>
	);
}

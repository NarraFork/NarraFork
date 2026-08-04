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

import { ActionIcon, CopyButton, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { MESSAGE_SELECTION_IGNORE_ATTR } from "../MessageSelectionCtx";
import { useRenderInteractive } from "../RenderLodCtx";
import { type CodeCopyPlacement, VIEW_ACTION_BAR_GAP } from "./vlist-content-view-float";

const ICON_SIZE = 12;

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
	 */
	hidden?: boolean;
	/**
	 * Which corner of the panel to occupy. `hidden` (too short a panel with the
	 * row bar on its top corner) renders nothing at all — see
	 * `resolveCodeCopyPlacement`. Defaults to the conventional top-right.
	 */
	placement?: CodeCopyPlacement;
}

/**
 * Copy one code panel's source. Renders nothing on a read-only surface (preview
 * panes set `interactive: false`) or for an empty panel.
 */
export function VListCodeCopyButton({
	value,
	hidden,
	placement = "top-right",
}: VListCodeCopyButtonProps) {
	const { t } = useTranslation("common");
	const interactive = useRenderInteractive();
	if (!interactive || value.length === 0) return null;
	// Nowhere clear of the row bar to paint: the bar's own copy button covers this
	// corner, so a per-panel button here would just be an unclickable duplicate.
	if (placement === "hidden") return null;

	return (
		// Marked selection-ignore so a Ctrl/Cmd-click aimed at the button cannot
		// double as a block-selection toggle (same contract as the row view bar).
		<div
			style={{
				...(placement === "bottom-right" ? bottomOverlayStyle : overlayStyle),
				visibility: hidden ? "hidden" : "visible",
				opacity: hidden ? 0 : 1,
				transition: "opacity 0.15s, visibility 0.15s",
			}}
			data-vlist-code-copy
			data-vlist-code-copy-placement={placement}
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
							size="xs"
							variant="filled"
							color={copied ? "teal" : "gray"}
							onClick={copy}
							aria-label={copied ? t("copied") : t("copy")}
							tabIndex={hidden ? -1 : 0}
						>
							{copied ? <IconCheck size={ICON_SIZE} /> : <IconCopy size={ICON_SIZE} />}
						</ActionIcon>
					</Tooltip>
				)}
			</CopyButton>
		</div>
	);
}

/**
 * VListContentViewModal.tsx — the vlist's fullscreen content viewer.
 *
 * One instance for the WHOLE list (the shell owns it; rows only report which
 * target to open), mounted only while a target is open. That is the same pattern
 * `OriginalContentModal` and the cancel-compaction dialog use here, and the
 * reason a scrolling list does not pay for a modal per row — unlike the chunked
 * path, where every `ContentViewer` carries its own.
 *
 * Behaviour parity with ContentViewer's fullscreen modal:
 *  - `Modal fullScreen` with the shared safe-area styles;
 *  - toolbar: source/rendered (markdown), wrap, copy, landscape (mobile);
 *  - the body is clamped to VIEW_MODAL_MAX_CHARS with the same notice appended;
 *  - the browser Back button closes the modal instead of navigating;
 *  - the list behind it stops painting while it is open — via `visibility`, NOT
 *    `content-visibility`, because the latter collapses the very measurements the
 *    exact layout is built from (see the effect below).
 */

import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import {
	SAFE_AREA_FULLSCREEN_MODAL_CONTENT_STYLE,
	SAFE_AREA_FULLSCREEN_MODAL_HEADER_STYLE,
	safeAreaFullscreenModalBodyStyle,
} from "@frontend/lib/safe-area";
import { ActionIcon, CopyButton, Modal, Tooltip } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import {
	IconCode,
	IconCopy,
	IconDeviceMobileRotated,
	IconMarkdown,
	IconTextWrap,
	IconTextWrapDisabled,
} from "@tabler/icons-react";
import { useRouter } from "@tanstack/react-router";
import { type CSSProperties, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { APP_HISTORY_SENTINEL, pushHistorySentinel } from "../../../lib/history-state";
import { clampViewText, isMarkdownTarget, VListViewBody } from "./vlist-content-view-body";
import type { VListViewTarget } from "./vlist-content-view-target";

/** The vlist scroll viewport, suppressed while the modal covers it. */
const LIST_VIEWPORT_SELECTOR = "[data-pretext-exact-message-list]";

const toolbarStyle: CSSProperties = {
	display: "flex",
	justifyContent: "flex-end",
	gap: 8,
	paddingBottom: 8,
};

export interface VListContentViewModalProps {
	target: VListViewTarget;
	wordWrap: boolean;
	showSource: boolean;
	onToggleWrap: () => void;
	onToggleSource: () => void;
	onClose: () => void;
}

export function VListContentViewModal({
	target,
	wordWrap,
	showSource,
	onToggleWrap,
	onToggleSource,
	onClose,
}: VListContentViewModalProps) {
	const { t } = useTranslation("common");
	const router = useRouter({ warn: false });
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const bodyRef = useRef<HTMLDivElement>(null);
	const isMarkdown = isMarkdownTarget(target);

	const clamped = clampViewText(target.text);
	// The body can be incomplete for two independent reasons: the payload itself
	// was a server-side prefix (`target.truncated`), or this modal clamped it to
	// stay responsive. Either way the reader gets the same notice the chunked
	// modal appends, so a partial body is never presented as the whole thing.
	const incomplete = clamped.clamped || target.truncated === true;
	const bodyText = incomplete ? `${clamped.text}\n\n${t("contentViewerTruncated")}` : clamped.text;

	// Browser-native landscape: fullscreen the modal shell + lock the orientation.
	const toggleLandscape = useCallback(async () => {
		try {
			const el = bodyRef.current?.closest(".mantine-Modal-content") as HTMLElement | null;
			if (!el) return;
			if (document.fullscreenElement) {
				await document.exitFullscreen();
				screen.orientation?.unlock?.();
			} else {
				await el.requestFullscreen();
				// biome-ignore lint/suspicious/noExplicitAny: orientation lock is not in lib.dom
				await (screen.orientation as any)?.lock?.("landscape").catch(() => {});
			}
		} catch {
			// Fullscreen API unsupported or denied — nothing to recover.
		}
	}, []);

	// Release the orientation lock when the modal unmounts.
	useEffect(() => {
		return () => {
			if (document.fullscreenElement) {
				document.exitFullscreen().catch(() => {});
				screen.orientation?.unlock?.();
			}
		};
	}, []);

	// Back button closes the viewer rather than leaving the narrator.
	useEffect(() => {
		if (!router) return;
		return pushHistorySentinel(
			router.history,
			APP_HISTORY_SENTINEL.contentViewerFullscreen,
			onClose,
		).dispose;
	}, [onClose, router]);

	/**
	 * Stop the list behind the modal from PAINTING, without disturbing its layout.
	 *
	 * `content-visibility: hidden` (what ContentViewer uses on the chunked list) is
	 * wrong here. It makes the viewport skip layout for its whole subtree, so the
	 * element's `clientHeight` / `clientWidth` collapse to 0. The shell observes
	 * exactly those two values with a ResizeObserver and feeds them into the
	 * document build options as `viewportHeight` / `contentWidth` — so opening the
	 * modal rebuilt the entire document at width ~0, and closing it rebuilt again at
	 * the restored width. That double re-measure is the "the list reloaded when I
	 * closed fullscreen" report.
	 *
	 * The chunked path can afford the layout skip because its row heights come from
	 * real DOM layout that simply re-runs. The exact vlist derives its whole
	 * geometry from these two numbers, so they must stay truthful.
	 *
	 * `visibility: hidden` gets the intended benefit — the browser skips painting
	 * the subtree — while keeping the box model intact, so no observer fires and no
	 * rebuild happens.
	 */
	useEffect(() => {
		const viewport = document.querySelector(LIST_VIEWPORT_SELECTOR);
		if (!(viewport instanceof HTMLElement)) return;
		const prev = viewport.style.visibility;
		viewport.style.visibility = "hidden";
		return () => {
			viewport.style.visibility = prev;
		};
	}, []);

	return (
		<Modal
			opened
			onClose={onClose}
			title={target.title}
			fullScreen
			styles={{
				content: SAFE_AREA_FULLSCREEN_MODAL_CONTENT_STYLE,
				header: SAFE_AREA_FULLSCREEN_MODAL_HEADER_STYLE,
				body: {
					overflow: "auto",
					padding: isMobile ? 8 : undefined,
					display: "flex",
					flexDirection: "column",
					...safeAreaFullscreenModalBodyStyle(isMobile ? 8 : undefined),
				},
			}}
		>
			<div ref={bodyRef} style={toolbarStyle}>
				{isMarkdown ? (
					<Tooltip label={showSource ? t("rendered") : t("source")} withArrow position="top">
						<ActionIcon
							size={isMobile ? "lg" : "xs"}
							variant="filled"
							color={showSource ? "indigo" : "gray"}
							onClick={onToggleSource}
							aria-label={showSource ? t("rendered") : t("source")}
						>
							{showSource ? (
								<IconMarkdown size={isMobile ? 18 : 12} />
							) : (
								<IconCode size={isMobile ? 18 : 12} />
							)}
						</ActionIcon>
					</Tooltip>
				) : null}
				<Tooltip label={wordWrap ? t("noWrap") : t("wordWrap")} withArrow position="top">
					<ActionIcon
						size={isMobile ? "lg" : "xs"}
						variant="filled"
						color={wordWrap ? "indigo" : "gray"}
						onClick={onToggleWrap}
						aria-label={wordWrap ? t("noWrap") : t("wordWrap")}
					>
						{wordWrap ? (
							<IconTextWrap size={isMobile ? 18 : 12} />
						) : (
							<IconTextWrapDisabled size={isMobile ? 18 : 12} />
						)}
					</ActionIcon>
				</Tooltip>
				{/* Copy always writes the FULL text, never the clamped preview. */}
				<CopyButton value={target.text}>
					{({ copied, copy }) => (
						<Tooltip label={copied ? t("copied") : t("copy")} withArrow position="top">
							<ActionIcon
								size={isMobile ? "lg" : "xs"}
								variant="filled"
								color={copied ? "teal" : "gray"}
								onClick={copy}
								aria-label={copied ? t("copied") : t("copy")}
							>
								<IconCopy size={isMobile ? 18 : 12} />
							</ActionIcon>
						</Tooltip>
					)}
				</CopyButton>
				{isMobile ? (
					<Tooltip label={t("landscape")} withArrow position="top">
						<ActionIcon
							size="lg"
							variant="filled"
							color="gray"
							onClick={toggleLandscape}
							aria-label={t("landscape")}
						>
							<IconDeviceMobileRotated size={18} />
						</ActionIcon>
					</Tooltip>
				) : null}
			</div>

			<VListViewBody
				target={target}
				wordWrap={wordWrap}
				showSource={showSource}
				text={bodyText}
				style={{ fontSize: isMobile ? 11 : 12 }}
			/>
		</Modal>
	);
}

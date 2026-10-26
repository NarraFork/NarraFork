import { Z } from "@frontend/lib/z-index";
import { Loader } from "@mantine/core";
import {
	IconArrowBarToRight,
	IconArrowUp,
	IconMessageQuestion,
	IconQuote,
	IconX,
} from "@tabler/icons-react";
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import classes from "./QuoteSelectionButton.module.css";
import {
	type QuoteButtonBox,
	type QuoteButtonPlacement,
	type QuoteButtonSelection,
	quoteButtonPosition,
} from "./quote-button-position";
import { NARRATOR_PANEL_SELECTOR } from "./quote-selection";
import type { QuoteCandidate } from "./use-quote-candidate";

export interface QuoteSelectionButtonProps {
	candidate: QuoteCandidate | null;
	/** The composer shell: positions the touch placement and finds the owning panel/document. */
	anchor: HTMLElement | null;
	placement: QuoteButtonPlacement;
	onAccept(candidate: QuoteCandidate): void;
	onDismiss(candidate: QuoteCandidate): void;
	showShortcut?: boolean;
	disabled?: boolean;
	/** Offers 顺便提问; absent where the selection cannot fork (no source message, no session). */
	onAskStart?: (candidate: QuoteCandidate) => void;
	/**
	 * Controlled ask mode: the toolbar becomes a question input for this candidate.
	 * Escape/outside press cancels back to the live selection's actions; ✕ dismisses both.
	 */
	asking?: boolean;
	askBusy?: boolean;
	onAskSubmit?: (question: string) => void;
	onAskCancel?: () => void;
}

const ASK_HIGHLIGHT = "nf-ask-selection";

type HighlightWindow = Window & {
	CSS?: { highlights?: { set(name: string, value: unknown): void; delete(name: string): void } };
	Highlight?: new (...ranges: Range[]) => unknown;
};

/**
 * Typing the question moves focus out of the message list, which drops the native
 * selection highlight; paint the excerpt with a CSS custom highlight instead.
 */
function highlightAskedRange(doc: Document, range: Range): (() => void) | undefined {
	const view = doc.defaultView as HighlightWindow | null;
	const highlights = view?.CSS?.highlights;
	if (!highlights || !view?.Highlight) return undefined;
	if (!doc.getElementById(`${ASK_HIGHLIGHT}-style`)) {
		const style = doc.createElement("style");
		style.id = `${ASK_HIGHLIGHT}-style`;
		style.textContent = `::highlight(${ASK_HIGHLIGHT}){background-color:var(--mantine-primary-color-light);color:inherit}`;
		doc.head.append(style);
	}
	highlights.set(ASK_HIGHLIGHT, new view.Highlight(range));
	return () => highlights.delete(ASK_HIGHLIGHT);
}

function box(rect: DOMRect): QuoteButtonBox {
	return { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom };
}

function selectionGeometry(candidate: QuoteCandidate): QuoteButtonSelection | null {
	if (candidate.kind !== "text" || !candidate.range) return null;
	const rects = [...candidate.range.getClientRects()].filter(
		(rect) => rect.width > 0 || rect.height > 0,
	);
	const backward = !!candidate.backward;
	const end = backward ? rects[0] : rects.at(-1);
	if (!end) return null;
	return { union: box(candidate.range.getBoundingClientRect()), end: box(end), backward };
}

/**
 * Floating selection toolbar: 引用 (and 顺便提问 where the session can fork). It is
 * portalled and fixed-positioned so selecting text never resizes the composer (which
 * would move the text under the pointer), and it sits outside the selected lines.
 *
 * The iOS/Android selection menus cannot be extended or reliably suppressed from a web
 * page and own the space above the selection, so on touch the toolbar goes below it,
 * past the selection handles (see quoteButtonPosition).
 */
export function QuoteSelectionButton({
	candidate,
	anchor,
	placement,
	onAccept,
	onDismiss,
	showShortcut = true,
	disabled = false,
	onAskStart,
	asking = false,
	askBusy = false,
	onAskSubmit,
	onAskCancel,
}: QuoteSelectionButtonProps) {
	const { t } = useTranslation("narrator");
	const ref = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
	const [question, setQuestion] = useState("");

	useLayoutEffect(() => {
		const element = ref.current;
		const view = anchor?.ownerDocument.defaultView;
		if (!candidate || !anchor || !element || !view) {
			setPosition(null);
			return;
		}
		const update = () => {
			const composer = anchor.getBoundingClientRect();
			// A hidden pane (e.g. inactive tab) has no box; neither does its toolbar.
			if (composer.width === 0 && composer.height === 0) {
				setPosition(null);
				return;
			}
			const viewport = { width: view.innerWidth, height: view.innerHeight };
			const panel = anchor.closest(NARRATOR_PANEL_SELECTOR)?.getBoundingClientRect();
			const next = quoteButtonPosition({
				placement,
				selection: selectionGeometry(candidate),
				bounds: panel
					? box(panel)
					: { top: 0, left: 0, right: viewport.width, bottom: viewport.height },
				composer: box(composer),
				viewport,
				size: { width: element.offsetWidth, height: element.offsetHeight },
			});
			setPosition((current) =>
				current && next && current.top === next.top && current.left === next.left ? current : next,
			);
		};
		update();
		let frame = 0;
		const schedule = () => {
			if (frame) return;
			frame = view.requestAnimationFrame(() => {
				frame = 0;
				update();
			});
		};
		const doc = anchor.ownerDocument;
		const visual = view.visualViewport;
		const resize = new view.ResizeObserver(schedule);
		resize.observe(anchor);
		resize.observe(element);
		doc.addEventListener("scroll", schedule, { capture: true, passive: true });
		view.addEventListener("resize", schedule);
		visual?.addEventListener("resize", schedule);
		visual?.addEventListener("scroll", schedule);
		return () => {
			if (frame) view.cancelAnimationFrame(frame);
			resize.disconnect();
			doc.removeEventListener("scroll", schedule, true);
			view.removeEventListener("resize", schedule);
			visual?.removeEventListener("resize", schedule);
			visual?.removeEventListener("scroll", schedule);
		};
	}, [candidate, anchor, placement]);

	const askedRange = asking && candidate?.kind === "text" ? candidate.range : undefined;
	useEffect(() => {
		const doc = anchor?.ownerDocument;
		if (!askedRange || !doc) return;
		return highlightAskedRange(doc, askedRange);
	}, [askedRange, anchor]);

	useEffect(() => {
		if (!asking) {
			setQuestion("");
			return;
		}
		inputRef.current?.focus({ preventScroll: true });
		const doc = anchor?.ownerDocument;
		if (!doc || askBusy) return;
		// Pressing anywhere else abandons the question, like any other popover.
		const outside = (event: PointerEvent) => {
			if (!ref.current?.contains(event.target as Node)) onAskCancel?.();
		};
		doc.addEventListener("pointerdown", outside, true);
		return () => doc.removeEventListener("pointerdown", outside, true);
	}, [asking, askBusy, anchor, onAskCancel]);

	if (!candidate || !anchor) return null;
	const keyboardShortcut = showShortcut && candidate.kind === "text";
	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (!askBusy) onAskSubmit?.(question.trim());
	};
	return createPortal(
		<div
			ref={ref}
			className={classes.root}
			data-quote-candidate
			data-placement={placement}
			data-mode={asking ? "ask" : "actions"}
			role="toolbar"
			aria-label={t("quote.add", { defaultValue: "Quote" })}
			style={{
				zIndex: Z.popover,
				top: position?.top ?? 0,
				left: position?.left ?? 0,
				visibility: position ? undefined : "hidden",
			}}
			// Keep the source selection (and focus) alive while a toolbar button is pressed.
			onPointerDown={(event) => {
				if (event.target !== inputRef.current) event.preventDefault();
			}}
		>
			{asking ? (
				<form className={classes.askForm} onSubmit={submit}>
					<IconMessageQuestion size={14} aria-hidden="true" className={classes.askIcon} />
					<input
						ref={inputRef}
						className={classes.askInput}
						value={question}
						disabled={askBusy}
						placeholder={t("quote.askPlaceholder")}
						aria-label={t("contextMenu_askInPassing")}
						onChange={(event) => setQuestion(event.currentTarget.value)}
						onKeyDown={(event) => {
							if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
							event.preventDefault();
							event.stopPropagation();
							if (!askBusy) onAskCancel?.();
						}}
					/>
					<button
						type="submit"
						className={classes.iconAction}
						aria-label={t("askInPassing_confirm")}
						title={t("askInPassing_confirm")}
						disabled={askBusy}
						data-quote-ask-submit
					>
						{askBusy ? <Loader size={12} /> : <IconArrowUp size={14} />}
					</button>
				</form>
			) : (
				<>
					<button
						type="button"
						className={classes.action}
						aria-keyshortcuts={keyboardShortcut ? "Tab" : undefined}
						disabled={disabled}
						title={candidate.kind === "text" ? candidate.quote.text : candidate.label}
						onClick={() => onAccept(candidate)}
						data-quote-accept
					>
						{keyboardShortcut ? (
							<kbd
								className={classes.shortcut}
								aria-label={t("quote.tabKey")}
								title={t("quote.tabKey")}
							>
								<IconArrowBarToRight size={12} aria-hidden="true" />
								<span>Tab</span>
							</kbd>
						) : null}
						<IconQuote size={14} aria-hidden="true" data-quote-action />
						<span>{t("quote.add", { defaultValue: "Quote" })}</span>
					</button>
					{onAskStart ? (
						<button
							type="button"
							className={classes.action}
							onClick={() => onAskStart(candidate)}
							data-quote-ask
						>
							<IconMessageQuestion size={14} aria-hidden="true" />
							<span>{t("contextMenu_askInPassing")}</span>
						</button>
					) : null}
				</>
			)}
			<button
				type="button"
				className={classes.iconAction}
				aria-label={t("quote.dismiss", { defaultValue: "Dismiss" })}
				disabled={askBusy}
				onClick={() => {
					if (asking) onAskCancel?.();
					onDismiss(candidate);
				}}
				data-quote-dismiss
			>
				<IconX size={12} />
			</button>
		</div>,
		anchor.ownerDocument.body,
	);
}

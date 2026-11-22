import type { Editor } from "@tiptap/core";
import { type RefObject, useLayoutEffect, useRef } from "react";

const HYSTERESIS = 8;
const MIN_INPUT_WIDTH = 64;

/** Geometry belongs to this input only, never to its message-list parent. */
export function useComposerLayout({
	editor,
	adaptive,
	rootRef,
	leadingRef,
	trailingRef,
}: {
	editor: Editor | null;
	adaptive: boolean;
	rootRef: RefObject<HTMLDivElement | null>;
	leadingRef: RefObject<HTMLDivElement | null>;
	trailingRef: RefObject<HTMLDivElement | null>;
}) {
	const scheduleRef = useRef<(() => void) | null>(null);
	useLayoutEffect(() => {
		const root = rootRef.current;
		const view = root?.ownerDocument.defaultView;
		if (!adaptive || !editor || !root || !view?.requestAnimationFrame || !view.ResizeObserver)
			return;
		const editable = editor.view.dom;
		const scroll = root.querySelector<HTMLElement>("[data-composer-scroll]");
		if (!scroll) return;
		let frame: number | null = null;
		let disposed = false;
		let initialized = false;
		let observedWidth = -1;
		let expanded = false;
		const setVariable = (key: string, value: number) => {
			const next = `${value}px`;
			if (root.style.getPropertyValue(key) !== next) root.style.setProperty(key, next);
		};
		const measure = () => {
			frame = null;
			if (disposed || editor.isDestroyed || root.clientWidth === 0) return;
			const leading = leadingRef.current?.getBoundingClientRect();
			const trailing = trailingRef.current?.getBoundingClientRect();
			const leadingSpace = leading?.width ? leading.width + 8 : 0;
			const trailingSpace = trailing?.width ? trailing.width + 8 : 0;
			setVariable("--composer-leading-space", leadingSpace);
			setVariable("--composer-trailing-space", trailingSpace);
			root.dataset.layout ??= "compact";
			const style = view.getComputedStyle(editable);
			const lineHeight = Number.parseFloat(style.lineHeight) || 24;
			const verticalPadding =
				Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
			const singleHeight = lineHeight + verticalPadding;
			const controlsHeight = Math.max(leading?.height ?? 0, trailing?.height ?? 0);
			// Adaptive CSS pins the controls 8px above the bottom border; reserve the
			// same 8px above them so single-line gaps around the buttons are symmetric.
			const compactHeight = Math.max(singleHeight, controlsHeight + 16) + 2;
			const available = root.clientWidth - 24 - leadingSpace - trailingSpace;
			const empty =
				editor.state.doc.childCount === 1 && editor.state.doc.firstChild?.content.size === 0;
			const oneLine = empty || editable.scrollHeight <= Math.ceil(singleHeight) + 1;
			let nextExpanded = !empty && (available < MIN_INPUT_WIDTH || !oneLine);
			if (!empty && expanded && oneLine && available >= MIN_INPUT_WIDTH) {
				// Only measure an inline range when the visible document already fits one line.
				// Large documents take the scrollHeight fast path, not a full text measurement.
				const paragraph = editable.firstElementChild;
				const range = root.ownerDocument.createRange();
				if (paragraph) range.selectNodeContents(paragraph);
				const width = paragraph ? range.getBoundingClientRect().width : 0;
				nextExpanded = width > available - HYSTERESIS;
			}
			if (nextExpanded !== expanded) {
				expanded = nextExpanded;
				root.dataset.layout = expanded ? "expanded" : "compact";
			}
			const naturalHeight = editable.scrollHeight;
			setVariable("--composer-content-height", expanded ? naturalHeight : compactHeight - 2);
			// Let CSS resolve dvh/min()/custom limits, including a keyboard-shortened viewport.
			const contentHeight = scroll.getBoundingClientRect().height;
			const toolbarHeight =
				root.querySelector<HTMLElement>("[data-composer-controls]")?.getBoundingClientRect()
					.height ?? controlsHeight;
			const height = expanded ? contentHeight + toolbarHeight + 14 : compactHeight;
			setVariable(
				"--composer-text-offset",
				expanded ? 0 : Math.max(0, (compactHeight - 2 - singleHeight) / 2),
			);
			const nextHeight = `${Math.ceil(height)}px`;
			// Numeric CSS height transitions retarget from the current interpolated height.
			// No timeout/finished callback can commit an obsolete expanded/collapsed state.
			if (root.style.height !== nextHeight) root.style.height = nextHeight;
			if (!initialized) {
				root.getBoundingClientRect();
				root.dataset.layoutReady = "true";
				initialized = true;
			}
		};
		const schedule = () => {
			if (!disposed && frame === null) frame = view.requestAnimationFrame(measure);
		};
		scheduleRef.current = schedule;
		const observer = new view.ResizeObserver((entries) => {
			if (
				entries.some((entry) => {
					if (entry.target !== root) return true;
					if (Math.abs(entry.contentRect.width - observedWidth) < 0.25) return false;
					observedWidth = entry.contentRect.width;
					return true;
				})
			)
				schedule();
		});
		observer.observe(root);
		observer.observe(editable);
		observer.observe(scroll);
		if (leadingRef.current) observer.observe(leadingRef.current);
		if (trailingRef.current) observer.observe(trailingRef.current);
		const onTransaction = () => schedule();
		editor.on("transaction", onTransaction);
		view.addEventListener("resize", schedule);
		measure();
		return () => {
			disposed = true;
			if (frame !== null) view.cancelAnimationFrame(frame);
			observer.disconnect();
			editor.off("transaction", onTransaction);
			view.removeEventListener("resize", schedule);
			scheduleRef.current = null;
			delete root.dataset.layout;
			delete root.dataset.layoutReady;
			root.style.removeProperty("height");
			for (const key of [
				"--composer-leading-space",
				"--composer-trailing-space",
				"--composer-content-height",
				"--composer-text-offset",
			])
				root.style.removeProperty(key);
		};
	}, [adaptive, editor, rootRef, leadingRef, trailingRef]);
	// Controlled loads and resource/candidate renders need measuring too; calls coalesce per frame.
	useLayoutEffect(() => scheduleRef.current?.());
}

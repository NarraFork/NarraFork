import type { MenuProps } from "@mantine/core";
import { type MouseEvent, type PointerEvent, useState } from "react";

/** Pointer-opened composer menus must not dismiss the editor's virtual keyboard. */
export function useInputMenu() {
	const [preserveFocus, setPreserveFocus] = useState(false);
	const preserveInputFocus = (event: MouseEvent<HTMLElement> | PointerEvent<HTMLElement>) => {
		const active = event.currentTarget.ownerDocument.activeElement;
		const editing = !!active?.matches(
			'textarea, input:not([type="button"]):not([type="submit"]), [contenteditable="true"]',
		);
		setPreserveFocus(editing);
		if (editing) event.preventDefault();
	};

	return {
		menuProps: {
			trapFocus: !preserveFocus,
			returnFocus: !preserveFocus,
			// Keyboard/browser chrome changes can invalidate the initial placement.
			preventPositionChangeWhenVisible: false,
			middlewares: { flip: true, shift: { crossAxis: true }, size: true },
		} satisfies Partial<MenuProps>,
		targetProps: {
			onPointerDown: preserveInputFocus,
			onMouseDown: preserveInputFocus,
			// Retain normal focus management when opened with Enter/Space/ArrowDown.
			onKeyDown: () => setPreserveFocus(false),
		},
	};
}

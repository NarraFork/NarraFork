/**
 * The permission form's button row, with keyboard-driven focus (shared by the plain permission
 * form and an outline plan's approval, `OutlinePlanApproval`).
 *
 * Two things point at "the button Enter presses": the ⏎ highlight (`focusIndex`, which the
 * panel's Enter shortcut runs, `usePermissionFocusNav`) and the browser's own focus. They are kept
 * on the same button, so what Enter does is what the reader sees:
 *   - keyboard focus entering the row (Tab, Shift+Tab) lands on the highlighted button;
 *   - focus moving inside the row (Tab between its buttons) moves the highlight with it;
 *   - the arrow keys move the highlight (the panel's shortcut), and the focus follows it while it
 *     is in the row.
 * Enter on a focused button of the active row runs the highlighted decision (the panel's handler
 * prevents the native click), so even a focus the row did not place (a mouse press dragged off a
 * button) cannot press a different button than the ⏎ one. While focus is on a control elsewhere
 * that owns Enter (a link, a tab, a plan tree's toggle) or a modal dialog is open, the hint is
 * hidden: Enter would not decide there.
 */
import { Button, Group, Text } from "@mantine/core";
import { type CSSProperties, type FocusEvent, useEffect, useRef, useState } from "react";
import { enterTakenFromPermission, PERM_BUTTON_BAR_ATTR } from "../interaction/enter-ownership";

export interface PermButton {
	label: string;
	color: string;
	variant?: string;
	onClick: () => void;
}

/** The row's `index`th button. */
function buttonAt(row: HTMLElement | null, index: number): HTMLButtonElement | null {
	return row?.querySelectorAll<HTMLButtonElement>(":scope > button")[index] ?? null;
}

/** Whether the element's focus came from the keyboard (`:focus-visible`; false where unknown). */
function focusVisible(el: Element): boolean {
	try {
		return el.matches(":focus-visible");
	} catch {
		return false;
	}
}

/** Whether Enter is taken by a control elsewhere (the hint then hides), followed as focus moves. */
function useEnterTakenElsewhere(active: boolean): boolean {
	const [taken, setTaken] = useState(false);
	useEffect(() => {
		if (!active || typeof document === "undefined") {
			setTaken(false);
			return;
		}
		const doc = document;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const update = () => {
			clearTimeout(timer);
			// After the focus has landed (a focusout alone leaves the body focused).
			timer = setTimeout(() => setTaken(enterTakenFromPermission(doc)), 0);
		};
		update();
		doc.addEventListener("focusin", update);
		doc.addEventListener("focusout", update);
		return () => {
			clearTimeout(timer);
			doc.removeEventListener("focusin", update);
			doc.removeEventListener("focusout", update);
		};
	}, [active]);
	return taken;
}

/**
 * Renders a row of permission buttons with keyboard-driven focus highlight.
 * Reports button count to the parent via setButtonCount so the global
 * keydown handler knows the navigation range.
 */
export function PermButtonBar({
	buttons,
	focusIndex,
	setFocusIndex,
	setButtonCount,
	registerActions,
}: {
	buttons: PermButton[];
	focusIndex: number | null;
	/** Move the highlight (the active permission's; absent for an inactive one). */
	setFocusIndex?: (index: number | null) => void;
	setButtonCount: (n: number) => void;
	registerActions: (actions: (() => void)[]) => void;
}) {
	useEffect(() => {
		setButtonCount(buttons.length);
		registerActions(buttons.map((b) => b.onClick));
	}, [buttons, setButtonCount, registerActions]);

	const active = focusIndex !== null;
	const row = useRef<HTMLDivElement>(null);

	// The arrow keys moved the highlight: the focus follows it while it is in the row.
	useEffect(() => {
		if (focusIndex === null) return;
		const focused = document.activeElement;
		if (!focused || !row.current?.contains(focused)) return;
		const target = buttonAt(row.current, focusIndex);
		if (target && target !== focused) target.focus();
	}, [focusIndex]);
	const onFocusButton = (index: number) => (e: FocusEvent<HTMLButtonElement>) => {
		if (focusIndex === null) return;
		const from = e.relatedTarget as Node | null;
		if (from && row.current?.contains(from)) {
			// Moving inside the row (Tab between its buttons): the highlight goes with the focus.
			if (index !== focusIndex) setFocusIndex?.(index);
			return;
		}
		// Keyboard focus entering the row lands on the highlighted button. (A mouse press is the
		// reader's own choice of button: it is left where it is, and its click decides.)
		if (index !== focusIndex && focusVisible(e.currentTarget))
			buttonAt(row.current, focusIndex)?.focus();
	};
	const hintTaken = useEnterTakenElsewhere(active);

	return (
		<Group gap="sm" ref={row} {...{ [PERM_BUTTON_BAR_ATTR]: active ? "active" : "idle" }}>
			{buttons.map((btn, i) => {
				const focused = focusIndex === i;
				return (
					<Button
						key={`${btn.label}-${btn.color}`}
						size="sm"
						color={btn.color}
						variant={btn.variant as "light" | "subtle" | undefined}
						onClick={btn.onClick}
						onFocus={onFocusButton(i)}
						data-perm-button={focused ? "highlighted" : ""}
						className={focused && !hintTaken ? "perm-btn-pulse" : undefined}
						style={
							focused && !hintTaken
								? ({
										"--perm-pulse-color": `var(--mantine-color-${btn.color}-filled)`,
									} as CSSProperties)
								: undefined
						}
					>
						{btn.label}
						{focused && !hintTaken && (
							<Text span size="xs" ml={4} opacity={0.7}>
								⏎
							</Text>
						)}
					</Button>
				);
			})}
		</Group>
	);
}

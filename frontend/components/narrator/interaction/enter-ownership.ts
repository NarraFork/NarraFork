/**
 * Who owns an Enter press: the element under the focus, or the window-level shortcuts that act
 * on Enter "anywhere else" — the session panel's waiting-permission shortcut
 * (`usePermissionFocusNav`) and the composer's "Enter returns focus to the chat input"
 * (`NarratorComposer`). Both ask the same question here, so they cannot drift apart.
 *
 * A control keeps its own Enter: a field, a button, a link, anything with a button-like or
 * composite role, a terminal, and everything while a modal dialog is open. The waiting
 * permission's own button row is the one exception, decided by its handler: Enter there runs the
 * highlighted decision (`PERM_BUTTON_BAR_ATTR`).
 */

/** Elements (or their insides) whose Enter is theirs. */
export const ENTER_OWNER_SELECTOR = [
	"input",
	"textarea",
	"select",
	"button",
	"a[href]",
	"summary",
	'[contenteditable]:not([contenteditable="false"])',
	'[role="button"]',
	'[role="link"]',
	'[role="menuitem"]',
	'[role="option"]',
	'[role="tab"]',
	'[role="checkbox"]',
	'[role="switch"]',
	'[role="combobox"]',
	'[role="menu"]',
	'[role="listbox"]',
	'[role="dialog"]',
	'[role="alertdialog"]',
	".xterm",
].join(", ");

/**
 * The waiting permission's button row (`PermButtonBar`): `"active"` while it is the one the
 * panel's Enter shortcut decides for.
 */
export const PERM_BUTTON_BAR_ATTR = "data-perm-button-bar";

function asElement(target: EventTarget | null | undefined): Element | null {
	return target && typeof (target as Element).closest === "function" ? (target as Element) : null;
}

/** Whether Enter at `target` belongs to it (or a modal dialog is open), not to a shortcut. */
export function enterOwnedByTarget(target: EventTarget | null | undefined, doc: Document): boolean {
	if (asElement(target)?.closest(ENTER_OWNER_SELECTOR)) return true;
	return !!doc.querySelector('[aria-modal="true"]');
}

/** Whether `target` is in the waiting permission's active button row. */
export function inActivePermButtonBar(target: EventTarget | null | undefined): boolean {
	return !!asElement(target)?.closest(`[${PERM_BUTTON_BAR_ATTR}="active"]`);
}

/** A text field: what it does with Enter is its own business (a newline, a submit). */
function isTextField(el: Element): boolean {
	return (
		el.tagName === "INPUT" ||
		el.tagName === "TEXTAREA" ||
		(el as HTMLElement).isContentEditable === true
	);
}

/**
 * Whether the waiting permission's ⏎ hint would lie with the focus where it is: a control
 * outside the permission's button row owns Enter (a link, a tab, a tree's toggle), or a modal
 * dialog is open. Text fields are left alone (the empty composer hands its Enter over; a form's
 * feedback box submits its own).
 */
export function enterTakenFromPermission(doc: Document): boolean {
	const el = doc.activeElement;
	if (doc.querySelector('[aria-modal="true"]')) return true;
	if (!el || el === doc.body || el === doc.documentElement) return false;
	if (inActivePermButtonBar(el) || isTextField(el)) return false;
	return enterOwnedByTarget(el, doc);
}

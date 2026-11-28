/**
 * ContextMenu.tsx — a pointer-positioned menu for a right-click.
 *
 * ## Why this is Mantine's `Menu`
 *
 * A right-click has no target element to hang a menu from, so this mounts a zero-size
 * `Menu.Target` at the pointer and lets the popover position itself relative to it. That
 * is the mechanism the conversation's row menus use (`VListRowInteractionControls`), and it
 * is reused deliberately rather than reimplemented: `Menu.Item` brings the hover/active
 * background, icon gutter, disabled styling, divider spacing, roving focus and
 * Escape handling that every other menu in the app already has. A hand-rolled row of
 * buttons looks and behaves subtly differently, which is exactly what the file tree showed
 * before this change.
 *
 * ## Why the position is NOT pinned by hand
 *
 * Pinning the dropdown with `styles.dropdown: { position: "fixed", left, top }` fights the
 * popover's own floating-ui coordinates, and measuring the dropdown to flip it needs a ref
 * that only attaches after the portal has mounted — a first layout effect sees `null`, so a
 * "hidden until measured" menu stays hidden forever. Both failure modes are invisible in a
 * test DOM (every rect is zero) and fatal in a browser. Letting floating-ui do it removes
 * them: it already flips and shifts the dropdown to stay in the viewport.
 *
 * Click-outside and Escape are Mantine's too (`opened` + `onChange`), so there is no
 * backdrop element: the dropdown closes when the user clicks anywhere else, including on
 * another row. The browser's own menu never appears because the caller prevented it at the
 * `contextmenu` event.
 */

import { Z } from "@frontend/lib/z-index";
import { Menu } from "@mantine/core";
import { Fragment, type ReactNode } from "react";

export interface ContextMenuItem {
	/** Stable identity for React and for tests. */
	key: string;
	label: string;
	icon?: ReactNode;
	onSelect: () => void;
	/** Shown but not selectable, e.g. paste with an empty clipboard. */
	disabled?: boolean;
	/** `Menu.Item`'s own colouring, e.g. red for a destructive entry. */
	color?: string;
	/** Draw a divider above this entry, grouping it away from the ones before it. */
	dividerBefore?: boolean;
}

export interface ContextMenuProps {
	x: number;
	y: number;
	items: readonly ContextMenuItem[];
	onClose: () => void;
	/** Accessible name for the menu, usually the entry it was opened on. */
	ariaLabel?: string;
}

export function ContextMenu({ x, y, items, onClose, ariaLabel }: ContextMenuProps) {
	return (
		<Menu
			opened
			// Mantine reports every dismissal (outside click, Escape, focus loss) here.
			onChange={(opened) => {
				if (!opened) onClose();
			}}
			// The item handlers close the menu themselves: several of them open a dialog, and
			// the menu has to be gone before that dialog appears. Letting Mantine close on the
			// click as well would report the dismissal twice.
			closeOnItemClick={false}
			// The pointer is the reference, so the dropdown hangs just below-right of it and
			// flips above/left when it would leave the viewport.
			position="bottom-start"
			offset={2}
			withinPortal
			shadow="md"
			zIndex={Z.contextMenu}
			// No enter animation: a pointer-positioned menu that slides in from the target's
			// direction reads as a mis-click.
			transitionProps={{ duration: 0 }}
		>
			<Menu.Target>
				<div style={{ position: "fixed", left: x, top: y, width: 0, height: 0 }} />
			</Menu.Target>
			<Menu.Dropdown aria-label={ariaLabel} miw={160}>
				{items.map((item) => (
					<Fragment key={item.key}>
						{item.dividerBefore && <Menu.Divider />}
						<Menu.Item
							leftSection={item.icon}
							color={item.color}
							disabled={item.disabled}
							data-context-menu-item={item.key}
							onClick={() => {
								if (item.disabled) return;
								// The caller's handler owns closing: some entries open a dialog
								// that must outlive the menu.
								item.onSelect();
							}}
						>
							{item.label}
						</Menu.Item>
					</Fragment>
				))}
			</Menu.Dropdown>
		</Menu>
	);
}

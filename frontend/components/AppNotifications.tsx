import { TOP_NOTIFICATION_SAFE_AREA_CLASSNAME } from "@frontend/lib/safe-area";
import { TOAST_SELECTABLE_CLASSNAME } from "@frontend/lib/toast";
import { Z } from "@frontend/lib/z-index";
import { useMediaQuery } from "@mantine/hooks";
import { Notifications } from "@mantine/notifications";

/** True on devices whose primary pointer can hover and position a caret precisely. */
const FINE_POINTER_MEDIA_QUERY = "(hover: hover) and (pointer: fine)";

export function AppNotifications() {
	// Mantine v9 enables swipe-to-dismiss by default. Its useDrag takes over after
	// 5px of pointer movement and sets document.body.style.userSelect = "none",
	// which makes it impossible to select toast text with a mouse — the drag runs
	// away with the whole toast instead. Keep the gesture where it is the natural
	// dismissal affordance (touch/pen) and drop it for mouse users, who dismiss
	// via the close button and expect to be able to copy the message.
	const hasFinePointer = useMediaQuery(FINE_POINTER_MEDIA_QUERY, false, {
		getInitialValueInEffect: false,
	});

	return (
		<Notifications
			position="top-right"
			zIndex={Z.toast}
			pauseResetOnHover="notification"
			allowDragDismiss={!hasFinePointer}
			classNames={{
				root: TOP_NOTIFICATION_SAFE_AREA_CLASSNAME,
				notification: hasFinePointer ? TOAST_SELECTABLE_CLASSNAME : undefined,
			}}
		/>
	);
}

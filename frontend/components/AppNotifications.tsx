import { TOP_NOTIFICATION_SAFE_AREA_CLASSNAME } from "@frontend/lib/safe-area";
import { Z } from "@frontend/lib/z-index";
import { Notifications } from "@mantine/notifications";

export function AppNotifications() {
	return (
		<Notifications
			position="top-right"
			zIndex={Z.toast}
			pauseResetOnHover="notification"
			classNames={{ root: TOP_NOTIFICATION_SAFE_AREA_CLASSNAME }}
		/>
	);
}

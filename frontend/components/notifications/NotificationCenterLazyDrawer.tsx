import { useMediaQuery } from "@mantine/hooks";
import { lazy } from "react";
import { useTranslation } from "react-i18next";
import { LazyOverlayShell } from "../common/LazyOverlayBoundary";
import type { NotificationCenterDrawerProps } from "./NotificationCenterDrawer";

const importNotificationCenterBody = () => import("./NotificationCenterDrawer");
const NotificationCenterBody = lazy(() =>
	importNotificationCenterBody().then((module) => ({
		default: module.NotificationCenterDrawerBody,
	})),
);

/** Warm the body on intent; failures are reported by the real open's error boundary. */
export function preloadNotificationCenterDrawer(): void {
	void importNotificationCenterBody().catch(() => {});
}

export function NotificationCenterLazyDrawer(props: NotificationCenterDrawerProps) {
	const { t } = useTranslation("nav");
	const mobile = useMediaQuery("(max-width: 48em)");
	return (
		<LazyOverlayShell
			type="drawer"
			opened={props.opened}
			onClose={props.onClose}
			label={t("notificationCenter")}
			position="right"
			size={mobile ? "100%" : 600}
			title={t("notificationCenter")}
			onKeyDown={(event) => {
				if (["Enter", "ArrowLeft", "ArrowRight"].includes(event.key)) event.stopPropagation();
			}}
		>
			<NotificationCenterBody {...props} />
		</LazyOverlayShell>
	);
}

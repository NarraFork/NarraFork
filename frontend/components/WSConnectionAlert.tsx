import { Alert, Button, Group, Text } from "@mantine/core";
import { IconPlugConnectedX, IconRefresh } from "@tabler/icons-react";
import { useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { TOP_BANNER_SAFE_AREA_STYLE } from "../lib/safe-area";
import { getDisconnected, hasDisconnected, onWSStatusChange } from "../lib/ws-status";
import { Z } from "../lib/z-index";

function subscribe(cb: () => void) {
	return onWSStatusChange(cb);
}

function getSnapshot() {
	return hasDisconnected();
}

/**
 * Global banner shown at the top of the app when any WebSocket connection is lost.
 * Provides a reconnect button that triggers all disconnected connections to retry.
 */
export function WSConnectionAlert() {
	const anyDisconnected = useSyncExternalStore(subscribe, getSnapshot);
	const { t } = useTranslation("common");

	// When the page regains visibility while disconnected, auto-reconnect all
	useEffect(() => {
		if (!anyDisconnected) return;
		function handleVisibility() {
			if (document.visibilityState === "visible") {
				for (const entry of getDisconnected()) {
					entry.reconnect?.();
				}
			}
		}
		document.addEventListener("visibilitychange", handleVisibility);
		return () => document.removeEventListener("visibilitychange", handleVisibility);
	}, [anyDisconnected]);

	if (!anyDisconnected) return null;

	const entries = getDisconnected();

	const handleReconnectAll = () => {
		for (const entry of entries) {
			entry.reconnect?.();
		}
	};

	return (
		<Alert
			color="red"
			variant="filled"
			icon={<IconPlugConnectedX size={18} />}
			style={{
				position: "fixed",
				...TOP_BANNER_SAFE_AREA_STYLE,
				left: "50%",
				transform: "translateX(-50%)",
				zIndex: Z.toast,
				maxWidth: 500,
				width: "calc(100% - 32px)",
			}}
		>
			<Group justify="space-between" wrap="nowrap" gap="sm">
				<Text size="sm">{t("wsDisconnected")}</Text>
				<Button
					size="compact-xs"
					variant="white"
					color="red"
					leftSection={<IconRefresh size={14} />}
					onClick={handleReconnectAll}
				>
					{t("wsReconnect")}
				</Button>
			</Group>
		</Alert>
	);
}

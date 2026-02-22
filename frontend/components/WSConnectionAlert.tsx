import { Alert, Button, Group, Text } from "@mantine/core";
import { IconPlugConnectedX, IconRefresh } from "@tabler/icons-react";
import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { getDisconnected, hasDisconnected, onWSStatusChange } from "../lib/ws-status";

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
				top: 8,
				left: "50%",
				transform: "translateX(-50%)",
				zIndex: 1000,
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

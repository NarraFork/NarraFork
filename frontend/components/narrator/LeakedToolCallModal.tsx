import { narratorsApi } from "@frontend/lib/api/narrators";
import { Alert, Button, Code, Group, Modal, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { IconAlertTriangle, IconDownload, IconInfoCircle } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { LeakedToolEvent } from "./useNarratorPanelWS";

function downloadJsonFile(fileName: string, value: unknown): void {
	const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = fileName;
	document.body.append(link);
	link.click();
	link.remove();
	URL.revokeObjectURL(url);
}

interface LeakedToolCallModalProps {
	narratorId: string;
	event: LeakedToolEvent | null;
	onClose: () => void;
}

/**
 * Dialog shown when the streaming XML tool-call capture failed for this turn:
 * - `recovered`: the post-turn safety net extracted and executed the tool, but the raw
 *   data is worth downloading to investigate why streaming capture missed it.
 * - `unrecovered`: leaked `<invoke>` text remained that could not be parsed; a tool may
 *   not have executed. The raw SSE dump is force-persisted and downloadable here.
 */
export function LeakedToolCallModal({ narratorId, event, onClose }: LeakedToolCallModalProps) {
	const { t } = useTranslation("narrator");
	const [downloading, setDownloading] = useState(false);

	const handleDownload = async () => {
		if (!event) return;
		setDownloading(true);
		try {
			const dump = await narratorsApi.getLeakedToolDump(narratorId, event.apiRequestId);
			downloadJsonFile(`narrator-${narratorId}-request-${event.apiRequestId}.json`, dump);
		} catch (error) {
			notifications.show({
				title: t("leakedToolDownloadFailedTitle"),
				message: error instanceof Error ? error.message : String(error),
				color: "red",
			});
		} finally {
			setDownloading(false);
		}
	};

	const unrecovered = event?.phase === "unrecovered";

	return (
		<Modal
			opened={!!event}
			onClose={onClose}
			title={unrecovered ? t("leakedToolUnrecoveredTitle") : t("leakedToolRecoveredTitle")}
			size="lg"
		>
			{event && (
				<Stack gap="md">
					<Alert
						variant="light"
						color={unrecovered ? "red" : "yellow"}
						icon={unrecovered ? <IconAlertTriangle size={18} /> : <IconInfoCircle size={18} />}
					>
						{unrecovered ? t("leakedToolUnrecoveredBody") : t("leakedToolRecoveredBody")}
					</Alert>

					{event.toolNames && event.toolNames.length > 0 && (
						<Text size="sm">
							{t("leakedToolRecoveredTools", { tools: event.toolNames.join(", ") })}
						</Text>
					)}

					{event.snippet && (
						<Stack gap={4}>
							<Text size="sm" c="dimmed">
								{t("leakedToolSnippetLabel")}
							</Text>
							<Code block style={{ maxHeight: 200, overflow: "auto", whiteSpace: "pre-wrap" }}>
								{event.snippet}
							</Code>
						</Stack>
					)}

					<Group justify="flex-end">
						<Button variant="default" onClick={onClose}>
							{t("leakedToolDismiss")}
						</Button>
						<Button
							leftSection={<IconDownload size={16} />}
							loading={downloading}
							onClick={handleDownload}
						>
							{t("leakedToolDownload")}
						</Button>
					</Group>
				</Stack>
			)}
		</Modal>
	);
}

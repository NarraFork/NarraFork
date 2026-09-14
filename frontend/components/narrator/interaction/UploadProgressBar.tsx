import { Anchor, Group, Loader, Progress, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";

export interface UploadProgressBarProps {
	sendingState: {
		attachmentCount: number;
		progress: number | null;
		canCancel: boolean;
	} | null;
	cancelSending: () => void;
}

/**
 * Upload / send progress shown while attachments are uploading, so the input area
 * does not look empty after the draft is cleared. Renders nothing unless there is
 * an in-flight send with attachments.
 */
export function UploadProgressBar({ sendingState, cancelSending }: UploadProgressBarProps) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");

	if (!sendingState || sendingState.attachmentCount <= 0) return null;

	return (
		<Stack
			gap={4}
			pt="xs"
			px="md"
			pb={6}
			style={{
				borderTop: "1px solid var(--mantine-color-default-border)",
				flexShrink: 0,
			}}
		>
			<Group gap="xs" wrap="nowrap" justify="space-between">
				{sendingState.progress !== null && sendingState.progress < 1 ? (
					<Text size="xs" c="dimmed">
						{t("uploadingAttachments", {
							percent: Math.round(sendingState.progress * 100),
						})}
					</Text>
				) : (
					<Group gap="xs" wrap="nowrap">
						<Loader size="xs" />
						<Text size="xs" c="dimmed">
							{t("sendingMessage")}
						</Text>
					</Group>
				)}
				{sendingState.canCancel && (
					<Anchor
						component="button"
						type="button"
						size="xs"
						c="dimmed"
						style={{ textDecoration: "underline", flexShrink: 0 }}
						onClick={cancelSending}
					>
						{tc("cancel")}
					</Anchor>
				)}
			</Group>
			{sendingState.progress !== null && sendingState.progress < 1 && (
				<Progress
					value={sendingState.progress * 100}
					size="sm"
					radius="xl"
					transitionDuration={150}
				/>
			)}
		</Stack>
	);
}

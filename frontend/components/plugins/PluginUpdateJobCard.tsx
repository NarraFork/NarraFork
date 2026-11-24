import { Alert, Badge, Button, Group, Paper, Progress, Stack, Text } from "@mantine/core";
import type { PluginUpdateJob } from "@shared/plugin-source";
import { useTranslation } from "react-i18next";
import { pluginUpdateDownloadPercent, pluginUpdateJobActive } from "./plugin-source-management";

export function PluginUpdateJobCard({
	job,
	canCancel = false,
	onCancel,
	cancelling = false,
}: {
	job: PluginUpdateJob;
	canCancel?: boolean;
	onCancel?: () => void;
	cancelling?: boolean;
}) {
	const { t } = useTranslation("plugins");
	const percent = pluginUpdateDownloadPercent(job);
	const active = pluginUpdateJobActive(job);
	return (
		<Paper
			withBorder
			p="sm"
			radius="sm"
			data-plugin-update-job={job.id}
			data-job-phase={job.phase}
			data-job-status={job.status}
		>
			<Stack gap="xs" aria-live="polite">
				<Group justify="space-between" wrap="wrap">
					<Text size="sm" fw={500}>
						{t(`admin.updates.phases.${job.phase}`)}
					</Text>
					<Badge
						color={job.status === "succeeded" ? "green" : job.status === "failed" ? "red" : "gray"}
						variant="light"
					>
						{t(`admin.updates.jobStatuses.${job.status}`)}
					</Badge>
				</Group>
				{(job.phase === "downloading" || job.downloadedBytes > 0) && (
					<>
						<Progress
							value={percent ?? 0}
							striped={percent === null && active}
							aria-label={t("admin.updates.downloadProgress")}
						/>
						<Text size="xs" c="dimmed">
							{job.totalBytes === null
								? t("admin.updates.downloadedBytes", { bytes: job.downloadedBytes })
								: t("admin.updates.byteProgress", {
										bytes: job.downloadedBytes,
										total: job.totalBytes,
									})}
						</Text>
					</>
				)}
				{job.error && (
					<Alert color={job.status === "manual_required" ? "yellow" : "red"}>
						{t(`admin.updates.errors.${job.error}`, { defaultValue: t("admin.updates.failed") })}
					</Alert>
				)}
				{active && (
					<Button
						size="compact-xs"
						variant="light"
						color="orange"
						disabled={!canCancel || !job.cancellable || !onCancel}
						loading={cancelling}
						onClick={onCancel}
					>
						{t("admin.updates.cancel")}
					</Button>
				)}
				{active && !job.cancellable && (
					<Text size="xs" c="dimmed">
						{t("admin.updates.notCancellable")}
					</Text>
				)}
			</Stack>
		</Paper>
	);
}

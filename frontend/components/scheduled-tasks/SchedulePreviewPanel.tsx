import type { SchedulePreview } from "@frontend/lib/api/scheduled-tasks";
import { Alert, Group, Loader, Paper, Stack, Text, Title } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { formatTaskTime } from "./schedule-presentation";

export function SchedulePreviewPanel({
	preview,
	timezone,
	loading = false,
	error,
}: {
	preview?: SchedulePreview;
	timezone: string | null;
	loading?: boolean;
	error?: string | null;
}) {
	const { t, i18n } = useTranslation("scheduledTasks");
	return (
		<Paper withBorder p="md" radius="md">
			<Stack gap="sm">
				<Group justify="space-between">
					<Title order={4}>{t("nextOccurrences")}</Title>
					{loading && <Loader size="xs" />}
				</Group>
				<Text size="xs" c="dimmed">
					{timezone || t("serverTimezone")}
				</Text>
				{error && <Alert color="red">{error}</Alert>}
				{!loading && !error && preview && (
					<>
						{preview.exhausted ? (
							<Text size="sm" c="dimmed">
								{t("previewExhausted")}
							</Text>
						) : (
							<Stack gap={6}>
								{preview.occurrences.map((time) => (
									<Text size="sm" key={time}>
										{formatTaskTime(time, timezone, i18n.language)}
									</Text>
								))}
							</Stack>
						)}
						<Text size="xs" c="dimmed">
							{preview.total === null
								? t(preview.finite ? "previewFinite" : "previewUnlimited")
								: t("previewCount", {
										total: preview.total,
										remaining: preview.remaining ?? preview.total,
									})}
						</Text>
						{preview.endsAt && (
							<Text size="xs" c="dimmed">
								{t("endsAt", { time: formatTaskTime(preview.endsAt, timezone, i18n.language) })}
							</Text>
						)}
					</>
				)}
				<Text size="xs" c="dimmed">
					{t("previewHint")}
				</Text>
			</Stack>
		</Paper>
	);
}

import { Alert, Badge, Code, Group, Loader, Paper, Stack, Text } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import type { PluginDetail, PluginDiagnostic } from "../../lib/api/plugins";
import { formatLocaleDateTime } from "../../lib/intl-format";

function DiagnosticRow({ diagnostic }: { diagnostic: PluginDiagnostic }) {
	return (
		<Paper withBorder p="xs" radius="sm">
			<Group gap="xs" wrap="wrap">
				<Badge color="red" variant="light" size="sm">
					{diagnostic.code}
				</Badge>
				{diagnostic.phase && (
					<Badge color="gray" variant="outline" size="sm">
						{diagnostic.phase}
					</Badge>
				)}
			</Group>
			<Text size="sm" mt={4} style={{ wordBreak: "break-word" }}>
				{diagnostic.message}
			</Text>
		</Paper>
	);
}

/**
 * Read-only diagnostics panel. The server payload is already sanitized
 * (tokens/secrets stripped, stderr truncated to a summary) — this component
 * never renders raw fields.
 */
export function PluginDiagnosticsPanel({
	diagnostics,
	isLoading,
}: {
	diagnostics: PluginDetail | undefined;
	isLoading: boolean;
}) {
	const { t } = useTranslation("plugins");

	if (isLoading) {
		return (
			<Group justify="center" py="xl">
				<Loader size="sm" />
			</Group>
		);
	}

	if (!diagnostics) {
		return (
			<Alert color="gray" variant="light" icon={<IconAlertCircle size={18} />}>
				{t("admin.detail.diagnostics.empty")}
			</Alert>
		);
	}

	const runtime = diagnostics.runtime;
	const items = diagnostics.diagnostics ?? [];
	const lastError = diagnostics.lastError;

	return (
		<Stack gap="md">
			<Text size="xs" c="dimmed">
				{t("admin.detail.diagnostics.autoRefresh")}
			</Text>

			{lastError && (
				<div>
					<Text fw={600} size="sm" mb={4}>
						{t("admin.detail.diagnostics.lastError")}
					</Text>
					<DiagnosticRow diagnostic={lastError} />
				</div>
			)}

			{runtime && (
				<div>
					<Text fw={600} size="sm" mb={4}>
						{t("admin.detail.diagnostics.runtime")}
					</Text>
					<Paper withBorder p="sm" radius="sm">
						<Stack gap={4}>
							{runtime.runtimeId && (
								<Group justify="space-between" wrap="nowrap">
									<Text size="sm" c="dimmed">
										{t("admin.detail.diagnostics.runtimeId")}
									</Text>
									<Code>{runtime.runtimeId}</Code>
								</Group>
							)}
							{runtime.generation !== undefined && (
								<Group justify="space-between" wrap="nowrap">
									<Text size="sm" c="dimmed">
										{t("admin.detail.diagnostics.generation")}
									</Text>
									<Text size="sm">{runtime.generation}</Text>
								</Group>
							)}
							{runtime.inFlight !== undefined && (
								<Group justify="space-between" wrap="nowrap">
									<Text size="sm" c="dimmed">
										{t("admin.detail.diagnostics.inFlight")}
									</Text>
									<Text size="sm">{runtime.inFlight}</Text>
								</Group>
							)}
							{runtime.lateMessages !== undefined && (
								<Group justify="space-between" wrap="nowrap">
									<Text size="sm" c="dimmed">
										{t("admin.detail.diagnostics.lateMessages")}
									</Text>
									<Text size="sm">{runtime.lateMessages}</Text>
								</Group>
							)}
							{runtime.startedAt && (
								<Group justify="space-between" wrap="nowrap">
									<Text size="sm" c="dimmed">
										{t("admin.detail.diagnostics.startedAt")}
									</Text>
									<Text size="sm">{formatLocaleDateTime(runtime.startedAt)}</Text>
								</Group>
							)}
							{runtime.stoppedAt && (
								<Group justify="space-between" wrap="nowrap">
									<Text size="sm" c="dimmed">
										{t("admin.detail.diagnostics.stoppedAt")}
									</Text>
									<Text size="sm">{formatLocaleDateTime(runtime.stoppedAt)}</Text>
								</Group>
							)}
							{runtime.stderrSummary && (
								<div>
									<Text size="sm" c="dimmed" mb={4}>
										{t("admin.detail.diagnostics.stderrSummary")}
									</Text>
									<Code block>{runtime.stderrSummary}</Code>
								</div>
							)}
						</Stack>
					</Paper>
				</div>
			)}

			<div>
				<Text fw={600} size="sm" mb={4}>
					{t("admin.detail.diagnostics.title")}
				</Text>
				{items.length === 0 ? (
					<Text size="sm" c="dimmed">
						{t("admin.detail.diagnostics.empty")}
					</Text>
				) : (
					<Stack gap="xs">
						{items.map((diagnostic) => (
							<DiagnosticRow
								key={`${diagnostic.code}-${diagnostic.phase ?? ""}-${diagnostic.message.slice(0, 48)}`}
								diagnostic={diagnostic}
							/>
						))}
					</Stack>
				)}
			</div>
		</Stack>
	);
}

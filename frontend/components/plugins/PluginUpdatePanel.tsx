import {
	Alert,
	Button,
	Checkbox,
	Code,
	Group,
	Loader,
	Paper,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useApplyPluginUpdate,
	useCancelPluginUpdateJob,
	useCheckPluginUpdates,
	usePluginSource,
	usePluginUpdateJob,
	usePluginUpdates,
	useSetPluginUpdatePreferences,
} from "../../hooks/usePlugins";
import { PluginUpdateJobCard } from "./PluginUpdateJobCard";
import {
	pluginSourceAllowsAutomatic,
	pluginUpdateErrorMessage,
	pluginUpdateJobActive,
	pluginUpdateJobMissing,
} from "./plugin-source-management";

export function PluginUpdatePanel({
	pluginId,
	canManage = false,
	disabled = false,
	sourceDirty = false,
}: {
	pluginId: string;
	canManage?: boolean;
	disabled?: boolean;
	sourceDirty?: boolean;
}) {
	const { t } = useTranslation("plugins");
	const sourceQuery = usePluginSource(pluginId, { enabled: canManage });
	const updatesQuery = usePluginUpdates(pluginId, { enabled: canManage });
	const check = useCheckPluginUpdates(pluginId);
	const apply = useApplyPluginUpdate(pluginId);
	const preferences = useSetPluginUpdatePreferences(pluginId);
	const cancel = useCancelPluginUpdateJob();
	const [startedJob, setStartedJob] = useState<{ id: string; revision: number } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [approvedCandidate, setApprovedCandidate] = useState<string | null>(null);
	const sourceView = sourceQuery.data;
	const binding = sourceView?.binding;
	const updates = updatesQuery.data;
	const localJobId = startedJob && binding?.revision === startedJob.revision ? startedJob.id : null;
	const jobId = localJobId ?? updates?.jobId ?? null;
	const jobQuery = usePluginUpdateJob(jobId, { enabled: canManage });
	const jobMissing = pluginUpdateJobMissing(jobQuery.error);
	const job = !jobMissing && jobQuery.data?.pluginId === pluginId ? jobQuery.data : undefined;
	const busy =
		check.isPending ||
		apply.isPending ||
		preferences.isPending ||
		pluginUpdateJobActive(job) ||
		Boolean(jobId && !job && !jobMissing);
	const locked = !canManage || disabled || sourceDirty || !binding || busy;
	const hasSource = Boolean(binding?.source);
	const automaticAllowed = pluginSourceAllowsAutomatic(binding?.source);
	const manualRequired = updates?.status === "manual_required" || job?.status === "manual_required";
	const candidateAvailable =
		(updates?.status === "available" || updates?.status === "manual_required") &&
		Boolean(updates?.candidateId);
	const approvalKey = JSON.stringify([pluginId, updates?.candidateId, binding?.revision]);
	const allowTrustChange = approvedCandidate === approvalKey;
	const start = (kind: "check" | "apply") => {
		if (locked || !hasSource || !binding) return;
		setError(null);
		const onSuccess = (result: { pluginId: string; jobId: string }) => {
			if (result.pluginId === pluginId)
				setStartedJob({ id: result.jobId, revision: binding.revision });
		};
		const onError = (cause: unknown) => setError(pluginUpdateErrorMessage(cause, t));
		if (kind === "check") check.mutate(undefined, { onSuccess, onError });
		else if (candidateAvailable && updates?.candidateId && (!manualRequired || allowTrustChange))
			apply.mutate(
				{
					candidateId: updates.candidateId,
					expectedRevision: binding.revision,
					...(allowTrustChange ? { allowTrustChange: true } : {}),
				},
				{ onSuccess, onError },
			);
	};
	const setAutomatic = (autoUpdate: boolean) => {
		if (locked || !binding || !hasSource || (autoUpdate && !automaticAllowed)) return;
		setError(null);
		preferences.mutate(
			{ autoUpdate, expectedRevision: binding.revision },
			{
				onError: (cause) => setError(pluginUpdateErrorMessage(cause, t)),
			},
		);
	};
	return (
		<Paper withBorder p="md" radius="md" data-plugin-update-panel={pluginId}>
			<Stack gap="sm">
				<Title order={5}>{t("admin.updates.title")}</Title>
				<Text size="sm" c="dimmed">
					{t("admin.updates.runtimeSeparate")}
				</Text>
				{(sourceQuery.isPending || updatesQuery.isPending) && canManage && (
					<Group gap="xs">
						<Loader size="xs" />
						<Text size="sm">{t("admin.updates.loading")}</Text>
					</Group>
				)}
				{!hasSource && (
					<Text size="sm" c="dimmed">
						{t("admin.updates.noSource")}
					</Text>
				)}
				{sourceDirty && <Alert color="yellow">{t("admin.updates.saveSourceFirst")}</Alert>}
				{updatesQuery.error && (
					<Alert color="yellow">{pluginUpdateErrorMessage(updatesQuery.error, t)}</Alert>
				)}
				{error && (
					<Alert color="red" role="alert">
						{error}
					</Alert>
				)}
				{updates && (
					<Stack gap={4}>
						<Text size="sm">
							{t("admin.updates.installedVersion", { version: updates.installedVersion ?? "—" })}
						</Text>
						<Text size="sm">
							{t(`admin.updates.statuses.${hasSource ? updates.status : "no_source"}`)}
						</Text>
						{updates.checkedAt && (
							<Text size="xs" c="dimmed">
								{t("admin.updates.checkedAt", { time: updates.checkedAt })}
							</Text>
						)}
						{updates.latest && hasSource && (
							<>
								<Text size="sm" fw={500}>
									{t("admin.updates.latestVersion", { version: updates.latest.version })}
								</Text>
								<Text size="xs" c="dimmed">
									{t("admin.updates.archiveBytes", { bytes: updates.latest.size })}
								</Text>
								<Code style={{ overflowWrap: "anywhere" }}>{updates.latest.sha256}</Code>
								{updates.latest.notes && (
									<Text size="sm" style={{ whiteSpace: "pre-line" }}>
										{updates.latest.notes}
									</Text>
								)}
							</>
						)}
						{updates.error && hasSource && (
							<Alert color={updates.status === "manual_required" ? "yellow" : "red"}>
								{t(`admin.updates.errors.${updates.error}`)}
							</Alert>
						)}
					</Stack>
				)}
				<Checkbox
					label={t("admin.updates.automatic")}
					description={t("admin.updates.automaticHint")}
					checked={hasSource && binding?.autoUpdate === true}
					disabled={locked || !hasSource || (!automaticAllowed && !binding?.autoUpdate)}
					onChange={(event) => setAutomatic(event.currentTarget.checked)}
				/>
				{hasSource && !automaticAllowed && (
					<Text size="xs" c="orange">
						{t("admin.updates.insecureManualOnly")}
					</Text>
				)}
				{manualRequired && (
					<Checkbox
						label={t("admin.updates.allowTrustChange")}
						description={t("admin.updates.allowTrustChangeHint")}
						checked={allowTrustChange}
						disabled={locked}
						onChange={(event) =>
							setApprovedCandidate(event.currentTarget.checked ? approvalKey : null)
						}
					/>
				)}
				<Group gap="xs">
					<Button
						size="xs"
						variant="light"
						disabled={locked || !hasSource}
						loading={check.isPending}
						onClick={() => start("check")}
					>
						{t("admin.updates.check")}
					</Button>
					<Button
						size="xs"
						disabled={
							locked || !hasSource || !candidateAvailable || (manualRequired && !allowTrustChange)
						}
						loading={apply.isPending}
						onClick={() => start("apply")}
					>
						{t("admin.updates.apply")}
					</Button>
				</Group>
				{jobQuery.error && (
					<Alert color="yellow">
						<Stack gap="xs">
							<Text size="sm">{t("admin.updates.progressUnavailable")}</Text>
							<Button size="compact-xs" variant="light" onClick={() => void jobQuery.refetch()}>
								{t("admin.updates.retryProgress")}
							</Button>
						</Stack>
					</Alert>
				)}
				{job && (
					<PluginUpdateJobCard
						job={job}
						canCancel={canManage}
						cancelling={cancel.isPending}
						onCancel={() =>
							cancel.mutate(job.id, {
								onError: (cause) => setError(pluginUpdateErrorMessage(cause, t)),
							})
						}
					/>
				)}
			</Stack>
		</Paper>
	);
}

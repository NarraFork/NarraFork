import {
	Alert,
	Badge,
	Button,
	Checkbox,
	FileInput,
	Group,
	Modal,
	Select,
	Stack,
	Text,
	Textarea,
	TextInput,
} from "@mantine/core";
import type {
	NarratorBackupJob,
	NarratorBackupProfile,
	NarratorRestorePreview,
	NarratorRestoreResult,
} from "@shared/narrator-backup";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { narratorBackupsApi } from "../../lib/api/narrator-backups";
import { canApplyBackupState, parseBackupMapping } from "./narrator-backup-policy";

export function NarratorBackupModal({
	opened,
	onClose,
	narratorId,
}: {
	opened: boolean;
	onClose: () => void;
	/** Omit on the list page: restore deleted sessions without a project or existing panel. */
	narratorId?: string;
}) {
	const { t } = useTranslation("narrator");
	const qc = useQueryClient();
	const [profile, setProfile] = useState<NarratorBackupProfile>("conversation-state-v1");
	const [job, setJob] = useState<NarratorBackupJob | null>(null);
	const [artifactId, setArtifactId] = useState("");
	const [mappingText, setMappingText] = useState("");
	const [preview, setPreview] = useState<NarratorRestorePreview | null>(null);
	const [confirmed, setConfirmed] = useState(false);
	const [result, setResult] = useState<NarratorRestoreResult | null>(null);
	const downloadController = useRef<AbortController | null>(null);
	useEffect(() => () => downloadController.current?.abort(), []);

	const plan = useQuery({
		queryKey: ["narrator-backup-plan", narratorId, profile],
		queryFn: () => narratorBackupsApi.plan({ narratorIds: [narratorId as string], profile }),
		enabled: opened && !!narratorId,
		retry: false,
	});
	const jobQuery = useQuery({
		queryKey: ["narrator-backup-job", job?.jobId],
		queryFn: () => narratorBackupsApi.job(job?.jobId as string),
		enabled: !!job,
		initialData: job ?? undefined,
		refetchInterval: (query) =>
			["queued", "running"].includes(query.state.data?.status ?? "") ? 1000 : false,
		retry: false,
	});
	const currentJob = jobQuery.data ?? job;
	const running = !!currentJob && ["queued", "running"].includes(currentJob.status);
	const exportJob = useMutation({
		mutationFn: () => narratorBackupsApi.export({ narratorIds: [narratorId as string], profile }),
		onSuccess: (value) => setJob(value),
	});
	const cancelJob = useMutation({
		mutationFn: () => narratorBackupsApi.cancel(currentJob?.jobId as string),
		onSuccess: (value) => {
			setJob(value);
			qc.setQueryData(["narrator-backup-job", value.jobId], value);
		},
	});
	const upload = useMutation({
		mutationFn: narratorBackupsApi.upload,
		onSuccess: (value) => changeArtifact(value.artifactId),
	});
	const previewMutation = useMutation({
		mutationFn: () =>
			narratorBackupsApi.preview({ artifactId, mapping: parseBackupMapping(mappingText) }),
		onSuccess: (value) => {
			setPreview(value);
			setConfirmed(false);
			setResult(null);
		},
	});
	const restore = useMutation({
		mutationFn: () => {
			if (!canApplyBackupState(preview, confirmed) || preview?.artifactId !== artifactId)
				throw new Error(t("backup.blocked"));
			return narratorBackupsApi.restore({ artifactId, mapping: parseBackupMapping(mappingText) });
		},
		onSuccess: (value) => {
			setResult(value);
			setPreview(null);
			setConfirmed(false);
			qc.invalidateQueries({ queryKey: ["narrators"] });
		},
	});
	const download = useMutation({
		mutationFn: async (id: string) => {
			downloadController.current = new AbortController();
			try {
				await narratorBackupsApi.download(id, downloadController.current.signal);
			} finally {
				downloadController.current = null;
			}
		},
	});
	function changeArtifact(value: string) {
		setArtifactId(value);
		setPreview(null);
		setConfirmed(false);
		setResult(null);
	}
	const error = [
		plan.error,
		jobQuery.error,
		exportJob.error,
		cancelJob.error,
		upload.error,
		previewMutation.error,
		restore.error,
		download.error,
	].find(Boolean)?.message;
	const busy = upload.isPending || previewMutation.isPending || restore.isPending;

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t(narratorId ? "backup.exportTitle" : "backup.restoreTitle")}
			size="lg"
			centered
		>
			<Stack>
				<Alert color="orange">{t("backup.boundary")}</Alert>
				<Text size="sm">{t("backup.private")}</Text>
				{error && <Alert color="red">{error}</Alert>}
				{narratorId && (
					<Stack gap="xs">
						<Select
							label={t("backup.profile")}
							value={profile}
							disabled={running || exportJob.isPending}
							allowDeselect={false}
							data={[
								{ value: "conversation-state-v1", label: t("backup.stateProfile") },
								{ value: "conversation-tree-v1", label: t("backup.treeProfile") },
							]}
							onChange={(value) => {
								if (value) {
									setProfile(value as NarratorBackupProfile);
									setJob(null);
								}
							}}
						/>
						<Text size="sm" c="dimmed">
							{t(profile === "conversation-state-v1" ? "backup.stateHint" : "backup.treeHint")}
						</Text>
						{plan.data && (
							<>
								<Text size="sm">
									{t("backup.capability", {
										profile: plan.data.profile,
										disk: String(plan.data.productionDiskRestoreAllowed),
									})}
								</Text>
								<Text fw={600} size="sm">
									{t("backup.exclusions")}
								</Text>
								{plan.data.exclusions.map((item) => (
									<Text key={item} size="sm">
										{item}
									</Text>
								))}
							</>
						)}
						<Group>
							<Button
								loading={exportJob.isPending || plan.isFetching}
								disabled={
									!plan.data ||
									!!plan.error ||
									running ||
									plan.data.productionDiskRestoreAllowed !== false
								}
								onClick={() => exportJob.mutate()}
							>
								{t("backup.export")}
							</Button>
							{running && (
								<Button
									variant="default"
									loading={cancelJob.isPending}
									onClick={() => cancelJob.mutate()}
								>
									{t("backup.cancelJob")}
								</Button>
							)}
						</Group>
						{currentJob && (
							<Text size="sm">
								{t("backup.job", {
									id: currentJob.jobId,
									status: t(`backup.status.${currentJob.status}`),
								})}
							</Text>
						)}
						{currentJob?.error && <Alert color="red">{currentJob.error}</Alert>}
						{currentJob?.status === "completed" && currentJob.artifactId && (
							<Group>
								<Button
									loading={download.isPending}
									onClick={() => download.mutate(currentJob.artifactId as string)}
								>
									{t("backup.download")}
								</Button>
								<Button
									variant="default"
									disabled={busy}
									onClick={() => changeArtifact(currentJob.artifactId as string)}
								>
									{t("backup.useOwned")}
								</Button>
								<Text size="xs">{currentJob.artifactId}</Text>
							</Group>
						)}
						{download.isPending && (
							<Button variant="default" onClick={() => downloadController.current?.abort()}>
								{t("backup.cancelDownload")}
							</Button>
						)}
					</Stack>
				)}
				<Text fw={600}>{t("backup.restoreTitle")}</Text>
				<FileInput
					label={t("backup.upload")}
					accept=".sqlite,.db,application/octet-stream"
					disabled={busy}
					clearable
					onChange={(file) => {
						setPreview(null);
						setConfirmed(false);
						if (file) upload.mutate(file);
					}}
				/>
				<Text size="sm" c="dimmed">
					{t("backup.uploadHint")}
				</Text>
				<TextInput
					label={t("backup.artifact")}
					value={artifactId}
					disabled={busy}
					onChange={(event) => changeArtifact(event.currentTarget.value)}
				/>
				<details>
					<summary>{t("backup.advanced")}</summary>
					<Text size="sm">{t("backup.mappingHint")}</Text>
					<Textarea
						value={mappingText}
						disabled={busy}
						maxLength={100_000}
						autosize
						minRows={3}
						placeholder={'{"users":{},"devices":{},"paths":{},"projects":{}}'}
						onChange={(event) => {
							setMappingText(event.currentTarget.value);
							setPreview(null);
							setConfirmed(false);
						}}
					/>
				</details>
				<Button
					variant="default"
					disabled={!artifactId.trim() || busy}
					loading={previewMutation.isPending}
					onClick={() => previewMutation.mutate()}
				>
					{t("backup.preview")}
				</Button>
				{preview && (
					<Stack gap="xs">
						<Badge color={preview.verifiedSameInstance ? "teal" : "orange"}>
							{t(preview.verifiedSameInstance ? "backup.verified" : "backup.foreign")}
						</Badge>
						<Text size="sm">
							{t("backup.previewInfo", {
								profile: preview.profile,
								ids: preview.narratorIds.join(", "),
							})}
						</Text>
						<Text size="sm">
							{t("backup.restoreCapability", {
								state: String(preview.sameInstanceStateRestoreAllowed),
								cross: String(preview.crossInstanceApplySupported),
								disk: String(preview.productionDiskRestoreAllowed),
							})}
						</Text>
						<Text size="sm">{t("backup.integrity")}</Text>
						<Text fw={600} size="sm">
							{t("backup.blockers")}
						</Text>
						{preview.blockers.length === 0 ? (
							<Text size="sm">{t("backup.noBlockers")}</Text>
						) : (
							preview.blockers.map((item) => (
								<Alert key={item} color="red">
									{item}
								</Alert>
							))
						)}
						<Text fw={600} size="sm">
							{t("backup.exclusions")}
						</Text>
						{preview.exclusions.map((item) => (
							<Text key={item} size="sm">
								{item}
							</Text>
						))}
						{!preview.verifiedSameInstance && (
							<Alert color="orange">{t("backup.crossDisabled")}</Alert>
						)}
						<Text size="sm">{t("backup.activation")}</Text>
						<Checkbox
							checked={confirmed}
							disabled={
								busy ||
								!preview.sameInstanceStateRestoreAllowed ||
								!preview.verifiedSameInstance ||
								preview.blockers.length > 0
							}
							onChange={(event) => setConfirmed(event.currentTarget.checked)}
							label={t("backup.confirm")}
						/>
						<Button
							color="orange"
							loading={restore.isPending}
							disabled={busy || !canApplyBackupState(preview, confirmed)}
							onClick={() => restore.mutate()}
						>
							{t("backup.restore")}
						</Button>
					</Stack>
				)}
				{result && (
					<Alert color="teal">{t("backup.restored", { ids: result.narratorIds.join(", ") })}</Alert>
				)}
			</Stack>
		</Modal>
	);
}

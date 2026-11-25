/**
 * Merging a ready work item (M), shared by the drawer's bottom bar and the 等你处理 card:
 *
 * - `MergeButton`: 「合并到 {{base}}」 → 「正在合并…」 (a background job; the drawer polls it),
 *   「重新准备」 once a merge was prepared; disabled with its reason (GitHub's PR flow not offered
 *   yet, the worker running, git too old, a remote-tracking base, …);
 * - `MergeOutcome`: the newest outcome in the drawer — the conflicting files with 「退回给工作者」
 *   (the reason prefilled), a failure in words, or a prepared merge: 「合并结果已准备好。{{base}}
 *   检出在 <path>，NarraFork 不改动那里的文件」 with 「在该目录中快进」 (after a confirmation that
 *   lists the files) and the command to run there instead.
 *
 * NarraFork never touches a person's checkout except on that explicit fast-forward.
 */
import { CopyButton } from "@frontend/components/common/CopyButton";
import { useMergeWorkItem } from "@frontend/hooks/useTeams";
import { describeApiError } from "@frontend/lib/api-error";
import {
	ActionIcon,
	Alert,
	Box,
	Button,
	Code,
	Group,
	List,
	Modal,
	SegmentedControl,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import type {
	TeamWorkMergeOutcome,
	TeamWorkMergeSummary,
	TeamWorkMergeView,
} from "@shared/project-teams";
import {
	IconAlertTriangle,
	IconArrowBackUp,
	IconCheck,
	IconCopy,
	IconGitMerge,
	IconPlayerTrackNext,
} from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { mergeControl, mergeErrorKey, mergeRequestCode } from "./team-page-model";
import { MONO } from "./team-page-ui";

/** The words for a merge refusal or failure. */
function useMergeErrorText() {
	const { t } = useTranslation("projects");
	return (code: string | null, fallback: string | null) => {
		const key = mergeErrorKey(code);
		if (key) return t(key);
		return fallback ?? t("teams.page.merge.failedGeneric");
	};
}

export function MergeButton({
	projectId,
	teamId,
	itemId,
	merge,
	base,
	size = "sm",
}: {
	projectId: string;
	teamId: string;
	itemId: string;
	merge: TeamWorkMergeSummary | undefined;
	base: string;
	size?: "xs" | "sm";
}) {
	const { t } = useTranslation("projects");
	const send = useMergeWorkItem(projectId, teamId);
	const errorText = useMergeErrorText();
	const control = mergeControl(merge);
	if (!control) return null;
	const pending = send.isPending || control.busy;
	const button = (
		<Button
			size={size}
			disabled={!control.enabled && !pending}
			loading={pending}
			leftSection={<IconGitMerge size={size === "xs" ? 14 : 16} aria-hidden />}
			onClick={() => send.mutate({ itemId })}
			data-testid="team-merge-button"
			data-merge-label={control.label}
		>
			{t(`teams.page.merge.${control.label}`, { base })}
		</Button>
	);
	return (
		<Stack gap={4} align="flex-end">
			{control.disabledKey && !pending ? (
				<Tooltip label={t(control.disabledKey, { base })} withinPortal multiline maw={300}>
					<span data-testid="team-merge-disabled" data-reason={merge?.disabledReason ?? ""}>
						{button}
					</span>
				</Tooltip>
			) : (
				button
			)}
			{send.isError && (
				<Text size="xs" c="red" data-testid="team-merge-request-error" maw={320}>
					{errorText(mergeRequestCode(send.error), describeApiError(send.error, t).message)}
				</Text>
			)}
		</Stack>
	);
}

type CommandShell = "sh" | "powershell";

/**
 * The command a person can run in the checkout, with a copy button: a Git Bash / sh form and a
 * PowerShell form, labelled; the server's platform picks the first shown, and the person can
 * switch.
 */
function CopyCommand({
	commands,
}: {
	commands: { sh: string; powershell: string; preferred: CommandShell };
}) {
	const { t } = useTranslation("projects");
	const [shell, setShell] = useState<CommandShell>(commands.preferred);
	const command = commands[shell];
	return (
		<Stack gap={4} data-testid="team-merge-command" data-shell={shell}>
			<SegmentedControl
				size="xs"
				value={shell}
				onChange={(value) => setShell(value === "powershell" ? "powershell" : "sh")}
				data={[
					{ value: "sh", label: t("teams.page.merge.shell.sh") },
					{ value: "powershell", label: t("teams.page.merge.shell.powershell") },
				]}
				data-testid="team-merge-command-shell"
			/>
			<Group gap={4} wrap="nowrap" align="flex-start">
				<Code
					block
					style={{
						...MONO,
						flex: 1,
						minWidth: 0,
						whiteSpace: "pre-wrap",
						overflowWrap: "anywhere",
					}}
				>
					{command}
				</Code>
				<CopyButton value={command}>
					{({ copied, copy }) => (
						<Tooltip label={copied ? t("teams.page.merge.copied") : t("teams.page.merge.copy")}>
							<ActionIcon
								variant="subtle"
								color={copied ? "teal" : "gray"}
								onClick={copy}
								aria-label={t("teams.page.merge.copy")}
								data-testid="team-merge-copy"
							>
								{copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
							</ActionIcon>
						</Tooltip>
					)}
				</CopyButton>
			</Group>
		</Stack>
	);
}

/** 「在该目录中快进」 with its confirmation, which lists the files it changes there. */
function FastForward({
	projectId,
	teamId,
	itemId,
	base,
	prepared,
	fastForward,
}: {
	projectId: string;
	teamId: string;
	itemId: string;
	base: string;
	prepared: Extract<TeamWorkMergeOutcome, { kind: "prepared" }>;
	fastForward: NonNullable<TeamWorkMergeView["fastForward"]>;
}) {
	const { t } = useTranslation("projects");
	const send = useMergeWorkItem(projectId, teamId);
	const errorText = useMergeErrorText();
	const [confirming, setConfirming] = useState(false);
	// What the fast-forward writes there (prepared base → merge commit), not the review diff.
	const files = fastForward.files;
	const shown = files.slice(0, 50);
	return (
		<>
			<Group gap="xs" wrap="wrap">
				<Button
					size="xs"
					variant="light"
					leftSection={<IconPlayerTrackNext size={14} aria-hidden />}
					disabled={!fastForward.available}
					onClick={() => setConfirming(true)}
					data-testid="team-merge-fast-forward"
				>
					{t("teams.page.merge.fastForward")}
				</Button>
				{fastForward.blocker && (
					<Text size="xs" c="dimmed" data-testid="team-merge-blocker">
						{t(`teams.page.merge.blocker.${fastForward.blocker}`, {
							base,
							count: fastForward.runningSessions,
						})}
					</Text>
				)}
			</Group>
			{send.isError && (
				<Text size="xs" c="red" data-testid="team-merge-ff-error">
					{errorText(mergeRequestCode(send.error), describeApiError(send.error, t).message)}
				</Text>
			)}
			<Modal
				opened={confirming}
				onClose={() => setConfirming(false)}
				title={t("teams.page.merge.confirmTitle", { base })}
				size="md"
			>
				<Stack gap="sm" data-testid="team-merge-confirm">
					<Text size="sm">
						{t("teams.page.merge.confirmText", { base, path: prepared.checkedOutAt })}
					</Text>
					{fastForward.terminals > 0 && (
						<Alert color="yellow" p="xs" icon={<IconAlertTriangle size={16} />}>
							{t("teams.page.merge.terminalsWarning", { count: fastForward.terminals })}
						</Alert>
					)}
					<Box style={{ maxHeight: 240, overflow: "auto" }}>
						<List size="sm" spacing={2} data-testid="team-merge-confirm-files">
							{shown.map((file) => (
								<List.Item key={file} style={{ ...MONO, overflowWrap: "anywhere" }}>
									{file}
								</List.Item>
							))}
						</List>
						{(fastForward.filesMore || files.length > shown.length) && (
							<Text size="xs" c="dimmed">
								{t("teams.page.merge.confirmFilesMore")}
							</Text>
						)}
					</Box>
					<Group justify="flex-end" gap="xs">
						<Button variant="default" onClick={() => setConfirming(false)}>
							{t("teams.page.drawer.cancel")}
						</Button>
						<Button
							loading={send.isPending}
							onClick={() =>
								send.mutate(
									{ itemId, fastForward: true },
									{ onSettled: () => setConfirming(false) },
								)
							}
							data-testid="team-merge-confirm-button"
						>
							{t("teams.page.merge.confirmButton")}
						</Button>
					</Group>
				</Stack>
			</Modal>
		</>
	);
}

/** The newest merge outcome in the drawer (conflicts, a failure, a prepared merge). */
export function MergeOutcome({
	projectId,
	teamId,
	itemId,
	base,
	merge,
	canReturn,
	onReturn,
}: {
	projectId: string;
	teamId: string;
	itemId: string;
	base: string;
	merge: TeamWorkMergeView;
	canReturn: boolean;
	onReturn: () => void;
}) {
	const { t } = useTranslation("projects");
	const errorText = useMergeErrorText();
	const detail = merge.detail;
	if (merge.phase || !detail) return null;
	if (detail.kind === "failed" && detail.code === "conflict") {
		const conflicts = detail.conflicts ?? [];
		return (
			<Alert
				color="red"
				p="xs"
				icon={<IconAlertTriangle size={16} />}
				title={t("teams.page.merge.conflictTitle", { base, count: conflicts.length })}
				data-testid="team-merge-conflicts"
			>
				<Stack gap={6}>
					<Box style={{ maxHeight: 160, overflow: "auto" }}>
						<List size="xs" spacing={1}>
							{conflicts.map((file) => (
								<List.Item key={file} style={{ ...MONO, overflowWrap: "anywhere" }}>
									{file}
								</List.Item>
							))}
						</List>
						{detail.more && (
							<Text size="xs" c="dimmed">
								{t("teams.page.merge.conflictsMore")}
							</Text>
						)}
					</Box>
					<Text size="xs">{t("teams.page.merge.conflictHint")}</Text>
					{canReturn && (
						<Group>
							<Button
								size="xs"
								variant="default"
								leftSection={<IconArrowBackUp size={14} aria-hidden />}
								onClick={onReturn}
								data-testid="team-merge-conflict-return"
							>
								{t("teams.page.merge.returnToWorker")}
							</Button>
						</Group>
					)}
				</Stack>
			</Alert>
		);
	}
	if (detail.kind === "failed")
		return (
			<Alert color="red" p="xs" data-testid="team-merge-failed" data-code={detail.code}>
				{errorText(detail.code, detail.message)}
			</Alert>
		);
	return (
		<Alert color="blue" p="xs" data-testid="team-merge-prepared">
			<Stack gap={6}>
				<Text size="sm">{t("teams.page.merge.prepared", { base, path: detail.checkedOutAt })}</Text>
				{detail.fastForwardFailure && (
					<Box
						data-testid="team-merge-ff-failed"
						data-code={detail.fastForwardFailure.code}
						style={{ color: "var(--mantine-color-red-text)" }}
					>
						<Text size="sm" inherit>
							{errorText(detail.fastForwardFailure.code, detail.fastForwardFailure.message)}
						</Text>
						{(detail.fastForwardFailure.files?.length ?? 0) > 0 && (
							<List size="xs" spacing={1} data-testid="team-merge-ff-files">
								{detail.fastForwardFailure.files?.map((file) => (
									<List.Item key={file} style={{ ...MONO, overflowWrap: "anywhere" }}>
										{file}
									</List.Item>
								))}
							</List>
						)}
					</Box>
				)}
				{merge.fastForward && (
					<>
						<FastForward
							projectId={projectId}
							teamId={teamId}
							itemId={itemId}
							base={base}
							prepared={detail}
							fastForward={merge.fastForward}
						/>
						{merge.fastForward.command && (
							<>
								<Text size="xs" c="dimmed">
									{t("teams.page.merge.commandHint")}
								</Text>
								<CopyCommand commands={merge.fastForward.command} />
							</>
						)}
					</>
				)}
			</Stack>
		</Alert>
	);
}

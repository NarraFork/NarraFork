/**
 * Merging a ready work item (M), shared by the drawer's bottom bar and the 等你处理 card:
 *
 * - `MergeButton`: 「合并到 {{base}}」 → 「正在合并…」 (a background job; the drawer polls it),
 *   「重新准备」 once a merge was prepared; disabled with its reason (the worker running, git too
 *   old, a remote-tracking base, …). When origin is on GitHub (G): 「发起 PR」 → 「正在推送分支… /
 *   正在创建 PR…」, then 「查看 PR #N」 with its status (CI, review, conflict / behind / blocked,
 *   已加入合并队列) and 「合并 PR」 (only for CLEAN, HAS_HOOKS or UNSTABLE; a menu of merge
 *   methods when the repository allows several), 「更新 PR」 after a re-ready, 「重新发起 PR」 when
 *   it was closed; disabled with the reason (gh missing, logged out, no write permission, …);
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
	Anchor,
	Badge,
	Box,
	Button,
	Code,
	Group,
	List,
	Menu,
	Modal,
	SegmentedControl,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import type {
	TeamPrMergeMethod,
	TeamWorkMergeOutcome,
	TeamWorkMergeSummary,
	TeamWorkMergeView,
} from "@shared/project-teams";
import {
	IconAlertTriangle,
	IconArrowBackUp,
	IconCheck,
	IconChevronDown,
	IconCopy,
	IconExternalLink,
	IconGitMerge,
	IconGitPullRequest,
	IconPlayerTrackNext,
} from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	mergeControl,
	mergeErrorKey,
	mergeRequestCode,
	type PullRequestControlView,
	pullRequestControl,
	safeHref,
} from "./team-page-model";
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
	const pr = pullRequestControl(merge);
	if (!control && !pr) return null;
	const pending = send.isPending || !!control?.busy;
	const github = merge?.mode === "github";
	const icon = github ? IconGitPullRequest : IconGitMerge;
	const Icon = icon;
	const button = control && (
		<Button
			size={size}
			disabled={!control.enabled && !pending}
			loading={pending && !pr?.busy}
			leftSection={<Icon size={size === "xs" ? 14 : 16} aria-hidden />}
			onClick={() => send.mutate({ itemId })}
			data-testid="team-merge-button"
			data-merge-label={control.label}
		>
			{t(`teams.page.merge.${control.label}`, { base })}
		</Button>
	);
	return (
		<Stack gap={4} align="flex-end">
			<Group gap="xs" wrap="wrap" justify="flex-end">
				{pr && (
					<PullRequestActions
						pr={pr}
						base={base}
						size={size}
						pending={send.isPending}
						disabledReason={merge?.disabledReason ?? null}
						onMerge={(method) => send.mutate({ itemId, pullRequest: { method } })}
					/>
				)}
				{control &&
					(control.disabledKey && !pending ? (
						<Tooltip label={t(control.disabledKey, { base })} withinPortal multiline maw={300}>
							<span data-testid="team-merge-disabled" data-reason={merge?.disabledReason ?? ""}>
								{button}
							</span>
						</Tooltip>
					) : (
						button
					))}
			</Group>
			{pr && pr.labels.length > 0 && <PullRequestLabels pr={pr} base={base} />}
			{send.isError && (
				<Text size="xs" c="red" data-testid="team-merge-request-error" maw={320}>
					{errorText(mergeRequestCode(send.error), describeApiError(send.error, t).message)}
				</Text>
			)}
		</Stack>
	);
}

/** 「查看 PR #N」, and 「合并 PR」 with a menu of methods when the repository allows several. */
function PullRequestActions({
	pr,
	base,
	size,
	pending,
	disabledReason,
	onMerge,
}: {
	pr: PullRequestControlView;
	base: string;
	size: "xs" | "sm";
	pending: boolean;
	disabledReason: string | null;
	onMerge: (method: TeamPrMergeMethod | undefined) => void;
}) {
	const { t } = useTranslation("projects");
	const [chosen, setChosen] = useState<TeamPrMergeMethod | null>(null);
	const method = chosen && pr.methods.includes(chosen) ? chosen : (pr.methods[0] ?? null);
	const href = safeHref(pr.url);
	const iconSize = size === "xs" ? 14 : 16;
	const merge = pr.showMerge && (
		<Button
			size={size}
			disabled={!pr.mergeEnabled || pending}
			loading={pr.busy}
			leftSection={<IconGitMerge size={iconSize} aria-hidden />}
			onClick={() => onMerge(method ?? undefined)}
			data-testid="team-pr-merge"
			data-method={method ?? ""}
			style={pr.methods.length > 1 ? { borderTopRightRadius: 0, borderBottomRightRadius: 0 } : {}}
		>
			{pr.busy ? t("teams.page.merge.mergingPr") : t("teams.page.merge.mergePr")}
			{method && pr.methods.length > 1 ? ` · ${t(`teams.page.merge.method.${method}`)}` : ""}
		</Button>
	);
	return (
		<Group gap="xs" wrap="nowrap" data-testid="team-pr" data-pr={pr.number}>
			<Button
				size={size}
				variant="default"
				component="a"
				href={href ?? undefined}
				target="_blank"
				rel="noopener noreferrer"
				disabled={!href}
				leftSection={<IconExternalLink size={iconSize} aria-hidden />}
				data-testid="team-pr-view"
			>
				{t("teams.page.merge.viewPr", { number: pr.number })}
			</Button>
			{merge && (
				<Group gap={0} wrap="nowrap">
					{pr.mergeDisabledKey && !pr.busy ? (
						<Tooltip label={t(pr.mergeDisabledKey, { base })} withinPortal multiline maw={300}>
							<span data-testid="team-pr-merge-disabled" data-reason={disabledReason ?? ""}>
								{merge}
							</span>
						</Tooltip>
					) : (
						merge
					)}
					{pr.methods.length > 1 && (
						<Menu position="bottom-end" withinPortal>
							<Menu.Target>
								<Tooltip label={t("teams.page.merge.methodMenu")} withinPortal>
									<ActionIcon
										size={size === "xs" ? 30 : 36}
										variant="filled"
										disabled={!pr.mergeEnabled || pending}
										aria-label={t("teams.page.merge.methodMenu")}
										data-testid="team-pr-method"
										style={{
											borderTopLeftRadius: 0,
											borderBottomLeftRadius: 0,
											borderLeft: "1px solid var(--mantine-color-body)",
										}}
									>
										<IconChevronDown size={iconSize} aria-hidden />
									</ActionIcon>
								</Tooltip>
							</Menu.Target>
							<Menu.Dropdown>
								{pr.methods.map((option, index) => (
									<Menu.Item
										key={option}
										onClick={() => setChosen(option)}
										leftSection={
											option === method ? <IconCheck size={14} aria-hidden /> : <Box w={14} />
										}
										data-testid="team-pr-method-option"
										data-method={option}
									>
										{t(`teams.page.merge.method.${option}`)}
										{index === 0 ? ` (${t("teams.page.merge.methodDefault")})` : ""}
									</Menu.Item>
								))}
							</Menu.Dropdown>
						</Menu>
					)}
				</Group>
			)}
		</Group>
	);
}

/** The pull request's status labels: CI, review, conflict / behind / blocked, queued. */
function PullRequestLabels({ pr, base }: { pr: PullRequestControlView; base: string }) {
	const { t } = useTranslation("projects");
	return (
		<Group gap={4} wrap="wrap" justify="flex-end" data-testid="team-pr-labels">
			{pr.labels.map((label) => (
				<Badge
					key={`${label.kind}:${label.key}`}
					size="sm"
					variant="light"
					color={label.color}
					tt="none"
					data-testid="team-pr-label"
					data-kind={label.kind}
					data-key={label.key}
				>
					{t(`teams.page.merge.pr.${label.key}`, { ...label.values, base })}
				</Badge>
			))}
		</Group>
	);
}

/** The drawer's detail of a pull request: failed checks (linked) and a failed read. */
function PullRequestDetail({ merge }: { merge: TeamWorkMergeView }) {
	const { t } = useTranslation("projects");
	const pr = pullRequestControl(merge);
	if (!pr || (pr.failures.length === 0 && !pr.error)) return null;
	return (
		<Alert color={pr.failures.length > 0 ? "red" : "yellow"} p="xs" data-testid="team-pr-detail">
			<Stack gap={4}>
				{pr.failures.length > 0 && (
					<>
						<Text size="sm" fw={600}>
							{t("teams.page.merge.pr.failuresTitle")}
						</Text>
						<List size="xs" spacing={1} data-testid="team-pr-failures">
							{pr.failures.map((failure) => {
								const href = safeHref(failure.link);
								return (
									<List.Item key={failure.name} style={{ overflowWrap: "anywhere" }}>
										{href ? (
											<Anchor href={href} target="_blank" rel="noopener noreferrer" size="xs">
												{failure.name}
											</Anchor>
										) : (
											failure.name
										)}
									</List.Item>
								);
							})}
						</List>
					</>
				)}
				{pr.error && (
					<Text size="xs" data-testid="team-pr-error">
						{t("teams.page.merge.pr.readFailed", { message: pr.error })}
					</Text>
				)}
			</Stack>
		</Alert>
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
	if (merge.phase) return null;
	if (!detail) return <PullRequestDetail merge={merge} />;
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
			<Stack gap={6}>
				<Alert color="red" p="xs" data-testid="team-merge-failed" data-code={detail.code}>
					<Stack gap={6}>
						<Text size="sm" inherit>
							{errorText(detail.code, detail.message)}
						</Text>
						{/* G: GitHub's branch has commits the ready head lacks: the worker brings them in. */}
						{detail.code === "TEAM_PR_PUSH_REJECTED" && canReturn && (
							<Group>
								<Button
									size="xs"
									variant="default"
									leftSection={<IconArrowBackUp size={14} aria-hidden />}
									onClick={onReturn}
									data-testid="team-merge-rejected-return"
								>
									{t("teams.page.merge.returnToWorker")}
								</Button>
							</Group>
						)}
					</Stack>
				</Alert>
				<PullRequestDetail merge={merge} />
			</Stack>
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

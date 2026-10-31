import { useClipboard } from "@frontend/hooks/useClipboard";
import {
	useGitBranches,
	useGitCheckoutBranch,
	useGitFetchRemote,
	useGitStatus,
} from "@frontend/hooks/useGit";
import { type GitTarget, gitCanWrite } from "@frontend/lib/api/git";
import {
	ActionIcon,
	Badge,
	Button,
	Checkbox,
	Group,
	Loader,
	Modal,
	Stack,
	Text,
	TextInput,
	Tooltip,
} from "@mantine/core";
import {
	GIT_BRANCH_LIST_LIMIT,
	type GitBranchEntry,
	isValidGitBranchName,
} from "@shared/git-branches";
import { IconCheck, IconCopy, IconSearch } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmDialog } from "../common/confirm-dialog-context";
import {
	aheadBehindLabel,
	branchRowDisabledReason,
	branchSwitchRequest,
	filterBranches,
} from "./git-branch-list";

const SHORT_SHA_LENGTH = 7;

/**
 * Branch picker: switch to a local branch, create one, or check out a remote one.
 *
 * Every write is guarded the same way the rest of the panel guards writes: a
 * read-only workspace disables them, and a dirty worktree asks first, because git
 * either carries the changes along or refuses outright — the user should know which
 * question they are answering rather than discover it in an error.
 */
export function GitBranchModal({
	opened,
	onClose,
	target,
	readOnly = false,
}: {
	opened: boolean;
	onClose: () => void;
	target: GitTarget;
	readOnly?: boolean;
}) {
	const { t } = useTranslation("git");
	const confirm = useConfirmDialog();
	const clipboard = useClipboard({ timeout: 1500 });
	const status = useGitStatus(target);
	const branches = useGitBranches(target, opened);
	const checkout = useGitCheckoutBranch(target);
	const fetch = useGitFetchRemote(target);
	const [search, setSearch] = useState("");
	const [newName, setNewName] = useState("");
	const [prune, setPrune] = useState(false);

	const canWrite = gitCanWrite(target) && !readOnly;
	const listing = branches.data;
	const branch = listing?.branch ?? status.data?.branch ?? null;
	const headSha = listing?.headSha ?? status.data?.headSha ?? null;
	const detached = listing ? listing.detached : !branch && !!headSha;
	const local = useMemo(() => listing?.local ?? [], [listing]);
	const remoteEntries = useMemo(() => listing?.remote ?? [], [listing]);
	const remotes = listing?.remotes;
	const shownLocal = useMemo(() => filterBranches(local, search), [local, search]);
	const shownRemote = useMemo(() => filterBranches(remoteEntries, search), [remoteEntries, search]);
	const trimmedName = newName.trim();
	const nameValid = trimmedName.length === 0 || isValidGitBranchName(trimmedName);
	const createDisabled =
		!canWrite ||
		trimmedName.length === 0 ||
		!isValidGitBranchName(trimmedName) ||
		checkout.isPending;
	const remote = listing?.defaultRemote ?? null;
	const error = checkout.error ?? fetch.error;

	async function confirmDirty(request: { branch: string }) {
		if (!status.data?.hasChanges) return true;
		return confirm({ message: t("branches.dirtySwitch", { branch: request.branch }) });
	}

	function remotePlan(entry: GitBranchEntry) {
		if (!canWrite) return { request: null, reason: "readOnly" as const, localName: "" };
		const request = branchSwitchRequest(entry, { local, remote: true, remotes });
		if ("blocked" in request)
			return { request: null, reason: "nameTaken" as const, localName: request.localName };
		const target = local.find((item) => item.name === request.branch);
		if (target?.name === branch)
			return { request: null, reason: "current" as const, localName: "" };
		if (target?.worktreePath)
			return {
				request: null,
				reason: "worktree" as const,
				localName: "",
				worktreePath: target.worktreePath,
			};
		return { request, reason: null, localName: "" };
	}

	async function switchTo(entry: GitBranchEntry, fromRemote: boolean) {
		if (!canWrite || checkout.isPending) return;
		const request = fromRemote
			? remotePlan(entry).request
			: branchSwitchRequest(entry, { local, remote: false, remotes });
		if (!request || "blocked" in request) return;
		if (!(await confirmDirty(request))) return;
		checkout.mutate(request, { onSuccess: () => onClose() });
	}

	async function createBranch() {
		if (createDisabled) return;
		if (!(await confirmDirty({ branch: trimmedName }))) return;
		checkout.mutate(
			{ branch: trimmedName, create: true },
			{
				onSuccess: () => {
					setNewName("");
					onClose();
				},
			},
		);
	}

	function reasonFor(entry: GitBranchEntry): string | null {
		const reason = branchRowDisabledReason(entry, {
			current: entry.name === branch,
			canWrite,
		});
		if (reason === "current") return t("branches.current");
		if (reason === "worktree") return t("branches.inWorktree", { path: entry.worktreePath ?? "" });
		if (reason === "readOnly") return t("branches.readOnly");
		return null;
	}

	return (
		<Modal opened={opened} onClose={onClose} title={t("branches.title")} size="md">
			<Stack gap="xs">
				<Text size="xs" c="dimmed" truncate title={branch ?? undefined}>
					{detached
						? t("branches.detachedHead", {
								sha: headSha ? headSha.slice(0, SHORT_SHA_LENGTH) : "",
							})
						: (branch ?? "")}
				</Text>
				<TextInput
					data-autofocus
					leftSection={<IconSearch size={14} />}
					placeholder={t("branches.search")}
					value={search}
					onChange={(event) => setSearch(event.currentTarget.value)}
				/>
				<Group gap={6} wrap="nowrap" align="flex-start">
					<TextInput
						style={{ flex: 1 }}
						placeholder={t("branches.createPlaceholder")}
						aria-label={t("branches.create")}
						value={newName}
						error={nameValid ? undefined : t("branches.invalidName")}
						onChange={(event) => setNewName(event.currentTarget.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") void createBranch();
						}}
					/>
					<Button
						size="compact-xs"
						variant="light"
						loading={checkout.isPending}
						disabled={createDisabled}
						onClick={() => void createBranch()}
					>
						{t("branches.createAndSwitch")}
					</Button>
				</Group>

				{branches.isPending && <Loader size="xs" />}
				{branches.error && (
					<Group gap="xs" justify="space-between" wrap="nowrap">
						<Text size="xs" c="red" lineClamp={2} title={branches.error.message}>
							{t("branches.loadFailed")}: {branches.error.message}
						</Text>
						<Button size="compact-xs" variant="subtle" onClick={() => void branches.refetch()}>
							{t("branches.refresh")}
						</Button>
					</Group>
				)}

				{shownLocal.length > 0 && (
					<Stack gap={2}>
						<Text size="xs" fw={600}>
							{t("branches.local")}
						</Text>
						{shownLocal.map((entry) => {
							const reason = reasonFor(entry);
							const counts = aheadBehindLabel(entry, t);
							return (
								<Button
									key={`local:${entry.name}`}
									data-branch-name={entry.name}
									variant={entry.name === branch ? "light" : "subtle"}
									fullWidth
									h="auto"
									py={4}
									justify="flex-start"
									styles={{ label: { display: "block", width: "100%", textAlign: "left" } }}
									disabled={reason !== null}
									title={reason ?? t("branches.switchTo", { branch: entry.name })}
									onClick={() => void switchTo(entry, false)}
								>
									<Group gap={6} wrap="nowrap" justify="space-between">
										<Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
											<Text size="xs" ff="monospace" truncate>
												{entry.name}
											</Text>
											{entry.name === branch && <Badge size="xs">{t("branches.current")}</Badge>}
										</Group>
										{counts && (
											<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
												{counts}
											</Text>
										)}
									</Group>
									{entry.upstream && (
										<Text size="xs" c="dimmed" truncate>
											{t("branches.tracking", { upstream: entry.upstream })}
										</Text>
									)}
									{entry.worktreePath && (
										<Text size="xs" c="yellow" truncate title={entry.worktreePath}>
											{t("branches.inWorktree", { path: entry.worktreePath })}
										</Text>
									)}
									{entry.subject && (
										<Text size="xs" c="dimmed" truncate>
											{entry.subject}
										</Text>
									)}
								</Button>
							);
						})}
					</Stack>
				)}

				{shownRemote.length > 0 && (
					<Stack gap={2}>
						<Text size="xs" fw={600}>
							{t("branches.remote")}
						</Text>
						{shownRemote.map((entry) => {
							const plan = remotePlan(entry);
							const reason =
								plan.reason === "current"
									? t("branches.current")
									: plan.reason === "worktree"
										? t("branches.inWorktree", { path: plan.worktreePath ?? "" })
										: plan.reason === "nameTaken"
											? t("branches.nameTaken", {
													branch: plan.localName,
													remote: entry.name,
												})
											: plan.reason === "readOnly"
												? t("branches.readOnly")
												: null;
							const trackingLocal =
								plan.request !== null && local.some((item) => item.name === plan.request?.branch);
							return (
								<Button
									key={`remote:${entry.name}`}
									data-branch-name={entry.name}
									variant="subtle"
									fullWidth
									h="auto"
									py={4}
									justify="flex-start"
									styles={{ label: { display: "block", width: "100%", textAlign: "left" } }}
									disabled={reason !== null}
									title={
										reason ??
										(trackingLocal
											? t("branches.switchTo", { branch: plan.request?.branch ?? entry.name })
											: t("branches.trackRemote", { branch: entry.name }))
									}
									onClick={() => void switchTo(entry, true)}
								>
									<Group gap={6} wrap="nowrap" justify="space-between">
										<Text size="xs" ff="monospace" truncate>
											{entry.name}
										</Text>
										{entry.subject && (
											<Text size="xs" c="dimmed" truncate style={{ flexShrink: 1 }}>
												{entry.subject}
											</Text>
										)}
									</Group>
								</Button>
							);
						})}
					</Stack>
				)}

				{listing &&
					shownLocal.length === 0 &&
					shownRemote.length === 0 &&
					(listing.local.length > 0 || listing.remote.length > 0) && (
						<Text size="xs" c="dimmed">
							{t("branches.noMatch")}
						</Text>
					)}
				{listing && listing.local.length === 0 && listing.remote.length === 0 && (
					<Text size="xs" c="dimmed">
						{t("branches.empty")}
					</Text>
				)}

				{listing?.truncated && (
					<Text size="xs" c="yellow">
						{t("branches.truncated", { count: GIT_BRANCH_LIST_LIMIT })}
					</Text>
				)}
				{listing && listing.remote.length > 0 && (
					<Text size="xs" c="dimmed">
						{t("branches.staleRemote")}
					</Text>
				)}
				{readOnly && (
					<Text size="xs" c="yellow">
						{t("branches.readOnly")}
					</Text>
				)}

				{error && (
					<>
						<Text size="xs" c="red" lineClamp={2} title={error.message}>
							{error.message}
						</Text>
						<Text size="xs" c="dimmed">
							{t("workspace.writeFailureHint")}
						</Text>
					</>
				)}
				{fetch.isSuccess && !error && (
					<Text size="xs" c="green">
						{t("branches.fetched")}
					</Text>
				)}

				<Group gap="xs" justify="space-between" wrap="nowrap">
					<Group gap={4} wrap="nowrap">
						<Tooltip label={clipboard.copied ? t("branches.copied") : t("branches.copyName")}>
							<ActionIcon
								size="sm"
								variant="subtle"
								color={clipboard.copied ? "green" : "gray"}
								aria-label={t("branches.copyName")}
								disabled={!branch}
								onClick={() => branch && clipboard.copy(branch)}
							>
								{clipboard.copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
							</ActionIcon>
						</Tooltip>
						<Button
							size="compact-xs"
							variant="subtle"
							loading={branches.isFetching}
							onClick={() => void branches.refetch()}
						>
							{t("branches.refresh")}
						</Button>
					</Group>
					<Group gap={6} wrap="nowrap">
						<Checkbox
							size="xs"
							checked={prune}
							disabled={!canWrite}
							label={t("branches.fetchPrune")}
							onChange={(event) => setPrune(event.currentTarget.checked)}
						/>
						<Button
							size="compact-xs"
							variant="light"
							disabled={!canWrite || (!!listing && !remote)}
							loading={fetch.isPending}
							title={t("branches.fetchHint")}
							onClick={() => fetch.mutate(remote ? { remote, prune } : { prune })}
						>
							{t("branches.fetch")}
						</Button>
					</Group>
				</Group>
			</Stack>
		</Modal>
	);
}

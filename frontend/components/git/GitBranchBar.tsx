import { useClipboard } from "@frontend/hooks/useClipboard";
import {
	useGitBranches,
	useGitFetchRemote,
	useGitPushBranch,
	useGitStatus,
} from "@frontend/hooks/useGit";
import { type GitTarget, gitCanWrite } from "@frontend/lib/api/git";
import { ActionIcon, Badge, Box, Group, Text, Tooltip, UnstyledButton } from "@mantine/core";
import {
	IconCheck,
	IconChevronDown,
	IconCloudDownload,
	IconCloudUpload,
	IconCopy,
	IconGitBranch,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConfirmDialog } from "../common/confirm-dialog-context";
import { GitBranchModal } from "./GitBranchModal";
import { publishBranchName } from "./git-branch-list";

/** Detached HEADs are identified by the commit, so the short form is enough. */
const SHORT_SHA_LENGTH = 7;

/**
 * One-line branch bar above the Changes tab: where HEAD is, how far it is from its
 * upstream, and the two remote operations.
 *
 * The branch name falls back to `status.branch` until the listing arrives, so the
 * bar never renders an empty chip even though the listing is the slower read. Every
 * write here is opt-in: the bar performs nothing on mount.
 */
export function GitBranchBar({
	target,
	readOnly = false,
}: {
	target: GitTarget;
	readOnly?: boolean;
}) {
	const { t } = useTranslation("git");
	const confirm = useConfirmDialog();
	const clipboard = useClipboard({ timeout: 1500 });
	const status = useGitStatus(target);
	const branches = useGitBranches(target);
	const push = useGitPushBranch(target);
	const fetch = useGitFetchRemote(target);
	const [opened, setOpened] = useState(false);

	const canWrite = gitCanWrite(target) && !readOnly;
	const listing = branches.data;
	const branch = listing?.branch ?? status.data?.branch ?? null;
	const headSha = listing?.headSha ?? status.data?.headSha ?? null;
	const detached = listing ? listing.detached : !branch && !!headSha;
	const current = branch ? listing?.local.find((entry) => entry.name === branch) : undefined;
	const ahead = current?.ahead ?? 0;
	const behind = current?.behind ?? 0;
	const upstreamGone = current?.upstreamGone === true;
	const upstream = current?.upstream ?? null;
	const remote = listing?.defaultRemote ?? null;
	// Without the listing there is no trustworthy target branch/remote to name, and
	// an old executor does not offer these operations at all.
	const known = listing !== undefined;
	// No upstream means ahead stays 0 — git has nothing to compare — but the branch
	// can still be published. A gone upstream is the same publish, onto the old name.
	const needsPublish = !upstream || upstreamGone;
	const remoteCount = listing?.remotes.length ?? 0;
	const remoteAmbiguous = known && !remote && remoteCount > 1;
	const destination = branch ? publishBranchName({ branch, upstream, remote }) : "";
	const pushable = canWrite && known && !detached && !!remote && (ahead > 0 || needsPublish);
	// A failed listing still lets the server pick the remote. A loaded listing with
	// no single choice must not fire a request that can only come back as an error.
	const fetchable = canWrite && !fetch.isPending && (!known || !!remote);

	const label = branch ?? (headSha ? headSha.slice(0, SHORT_SHA_LENGTH) : t("branches.detached"));

	// The status poll is the cheap signal that HEAD moved (a terminal checkout, a
	// worktree action). Re-listing on every WS push would be six git processes a
	// second; re-listing once per HEAD change is not.
	const observedHead = useRef<string | null>(null);
	const refetchBranches = useRef(branches.refetch);
	refetchBranches.current = branches.refetch;
	const headIdentity = status.data ? `${status.data.branch}:${status.data.headSha}` : null;
	useEffect(() => {
		if (!headIdentity) return;
		const previous = observedHead.current;
		observedHead.current = headIdentity;
		if (previous && previous !== headIdentity) void refetchBranches.current();
	}, [headIdentity]);

	const remoteHint = remoteAmbiguous
		? t("branches.remoteAmbiguous")
		: known && !remote
			? t("branches.noRemote")
			: null;
	const pushHint = !canWrite
		? t("branches.readOnly")
		: detached
			? t("branches.detachedPush")
			: !known
				? (branches.error?.message ?? t("branches.loadFailed"))
				: remoteHint
					? remoteHint
					: needsPublish && ahead === 0
						? t("branches.pushNoUpstream", { branch: destination, remote: remote ?? "" })
						: ahead === 0
							? t("branches.pushUpToDate")
							: t("branches.pushAhead", {
									count: ahead,
									remote,
									branch: destination,
								});
	const fetchHint = !canWrite ? t("branches.readOnly") : (remoteHint ?? t("branches.fetchHint"));

	async function handlePush() {
		if (!pushable || !remote || !branch) return;
		const setUpstream = needsPublish;
		// No upstream yet means the push creates the remote branch; say so first.
		if (setUpstream) {
			const confirmed = await confirm({
				message: t("branches.pushNewConfirm", { branch: destination, remote }),
			});
			if (!confirmed) return;
		}
		push.mutate({ remote, setUpstream });
	}

	function handleFetch() {
		if (!fetchable) return;
		// The server resolves the remote when the bar cannot name one (failed listing).
		fetch.mutate(remote ? { remote } : {});
	}

	const error = push.error ?? fetch.error ?? branches.error;
	const writeFailed = !!(push.error || fetch.error);

	return (
		<Box style={{ flexShrink: 0 }}>
			<Group
				gap={6}
				px="xs"
				wrap="nowrap"
				h={30}
				style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}
			>
				<UnstyledButton
					aria-label={t("branches.open")}
					onClick={() => setOpened(true)}
					style={{ flex: 1, minWidth: 0, overflow: "hidden" }}
				>
					{/* The name owns the remaining width; the glyphs never shrink. */}
					<Group gap={4} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
						<IconGitBranch size={14} style={{ flexShrink: 0 }} />
						<Text
							size="xs"
							ff="monospace"
							truncate
							title={label}
							style={{ minWidth: 0, flexShrink: 1, userSelect: "text" }}
						>
							{label}
						</Text>
						<IconChevronDown size={12} style={{ flexShrink: 0 }} />
					</Group>
				</UnstyledButton>
				{/* Kept in the panel (not only the picker): it is the one branch action
				    that works on every workspace, read-only ones included. */}
				<Tooltip label={clipboard.copied ? t("panel.branchCopied") : t("panel.copyBranch")}>
					<ActionIcon
						variant="subtle"
						color={clipboard.copied ? "green" : "gray"}
						size="sm"
						aria-label={t("panel.copyBranch")}
						style={{ flexShrink: 0 }}
						onClick={() => clipboard.copy(label)}
					>
						{clipboard.copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
					</ActionIcon>
				</Tooltip>
				{ahead > 0 && (
					<Tooltip label={t("branches.ahead", { count: ahead })}>
						<Badge size="xs" variant="light" style={{ flexShrink: 0 }}>
							↑{ahead}
						</Badge>
					</Tooltip>
				)}
				{behind > 0 && (
					<Tooltip label={t("branches.behind", { count: behind })}>
						<Badge size="xs" variant="light" color="gray" style={{ flexShrink: 0 }}>
							↓{behind}
						</Badge>
					</Tooltip>
				)}
				{upstreamGone && (
					<Tooltip label={t("branches.upstreamGoneHint")}>
						<Badge size="xs" variant="light" color="yellow" style={{ flexShrink: 0 }}>
							{t("branches.upstreamGone")}
						</Badge>
					</Tooltip>
				)}
				<Box style={{ flex: 1, minWidth: 0 }} />
				<Tooltip label={fetchHint} multiline maw={280}>
					<ActionIcon
						variant="subtle"
						size="sm"
						aria-label={t("branches.fetch")}
						disabled={!fetchable}
						loading={fetch.isPending}
						style={{ flexShrink: 0 }}
						onClick={handleFetch}
					>
						<IconCloudDownload size={15} />
					</ActionIcon>
				</Tooltip>
				<Tooltip label={pushHint} multiline maw={280}>
					<ActionIcon
						variant="subtle"
						size="sm"
						aria-label={t("branches.push")}
						disabled={!pushable || push.isPending}
						loading={push.isPending}
						style={{ flexShrink: 0 }}
						onClick={() => void handlePush()}
					>
						<IconCloudUpload size={15} />
					</ActionIcon>
				</Tooltip>
			</Group>
			{error && (
				<>
					<Text c="red" size="xs" px="xs" pt={4} lineClamp={2} title={error.message}>
						{error.message}
					</Text>
					{writeFailed && (
						<Text c="dimmed" size="xs" px="xs">
							{t("workspace.writeFailureHint")}
						</Text>
					)}
				</>
			)}
			{push.isSuccess && !error && remote && branch && (
				<Text c="green" size="xs" px="xs" pt={4}>
					{t("branches.pushSuccess", { remote, branch: destination || branch })}
				</Text>
			)}
			<GitBranchModal
				opened={opened}
				onClose={() => setOpened(false)}
				target={target}
				readOnly={readOnly}
			/>
		</Box>
	);
}

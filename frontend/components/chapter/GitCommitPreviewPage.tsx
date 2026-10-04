import { Alert, Button, Container, Group, Loader, Stack, Title } from "@mantine/core";
import { GIT_COMMIT_PREVIEW_UNSUPPORTED, GIT_COMMIT_SHA_PATTERN } from "@shared/git-commit-preview";
import { Link, useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { gitWorkspaceTarget, useGitCommitDetail, useGitWorkspace } from "../../hooks/useGit";
import { useNarrator } from "../../hooks/useNarrator";
import { useWorkspaceContext } from "../../hooks/useWorkspaceContext";
import type { ApiError } from "../../lib/api";
import { type GitTarget, gitBasePath, gitTargetKey } from "../../lib/api/git";
import {
	buildCommitPreviewHref,
	type CommitPreviewPageMode,
	type CommitPreviewSearch,
} from "../../lib/git-commit-preview-navigation";
import { GitCommitPreview } from "./GitCommitPreview";

type Owner = { narratorId: string; chapterId?: never } | { chapterId: string; narratorId?: never };
type Props = Owner & {
	sha: string;
	search: CommitPreviewSearch;
	mode?: CommitPreviewPageMode;
};

/** Shared by the legacy AppShell page and the lightweight Git window, outside the narrator Dock. */
export function GitCommitPreviewPage(props: Props) {
	const { t } = useTranslation("git");
	const valid = GIT_COMMIT_SHA_PATTERN.test(props.sha) && !props.search.invalid;
	const sha = props.sha.toLowerCase();
	const mode = props.mode ?? "page";
	return (
		<Container fluid={mode === "window"} size="xl" py="md" w="100%" data-git-preview-page={mode}>
			<Stack gap="md">
				<Group justify="space-between">
					<Title order={2}>{t("commitPreview.title", { sha: props.sha.slice(0, 7) })}</Title>
					{props.narratorId !== undefined ? (
						<Link
							to="/narrators/$narratorId"
							params={{ narratorId: props.narratorId }}
							target={mode === "window" ? "_blank" : undefined}
							rel={mode === "window" ? "noopener noreferrer" : undefined}
							data-git-preview-owner-link
							style={{ textDecoration: "none" }}
						>
							<Button component="span" variant="subtle">
								{mode === "window"
									? t("commitPreview.page.openInApp")
									: t("commitPreview.page.backNarrator", { defaultValue: "Back to narrator" })}
							</Button>
						</Link>
					) : (
						<Link
							to="/chapters/$chapterId"
							params={{ chapterId: props.chapterId }}
							target={mode === "window" ? "_blank" : undefined}
							rel={mode === "window" ? "noopener noreferrer" : undefined}
							data-git-preview-owner-link
							style={{ textDecoration: "none" }}
						>
							<Button component="span" variant="subtle">
								{mode === "window"
									? t("commitPreview.page.openInApp")
									: t("commitPreview.page.backChapter", { defaultValue: "Back to chapter" })}
							</Button>
						</Link>
					)}
				</Group>
				{!valid ? (
					<Alert color="red" role="alert">
						{t("commitPreview.page.invalidUrl", {
							defaultValue:
								"Invalid commit preview URL. Use a full commit SHA and valid query parameters.",
						})}
					</Alert>
				) : props.narratorId !== undefined ? (
					<NarratorPreview
						key={props.narratorId}
						narratorId={props.narratorId}
						sha={sha}
						search={props.search}
						mode={mode}
					/>
				) : (
					<ResolvedPreview
						key={`${props.chapterId}:${sha}`}
						target={props.chapterId}
						sha={sha}
						file={props.search.file}
						mode={mode}
					/>
				)}
			</Stack>
		</Container>
	);
}

function PreviewFailure({ error, retry }: { error: unknown; retry: () => void }) {
	const { t } = useTranslation("git");
	const failure = error as ApiError | null;
	const unsupported = failure?.data?.code === GIT_COMMIT_PREVIEW_UNSUPPORTED;
	let message = t("workspace.error");
	if (unsupported) message = t("commitPreview.unsupported");
	else if (failure?.status === 401 || failure?.status === 403)
		message = t("workspace.access_denied");
	else if (failure?.status === 404)
		message = t("commitPreview.page.notFound", {
			defaultValue: "The commit or its workspace no longer exists, or is not accessible.",
		});
	else if (failure?.status === 409)
		message = t("commitPreview.page.workspaceChanged", {
			defaultValue: "The workspace has changed. Open a new preview from its current Git history.",
		});
	else if (failure?.status === 503) message = t("workspace.device_offline");
	else if (failure?.message) message = failure.message;
	return (
		<Alert color={unsupported ? "yellow" : "red"} role="alert">
			<Stack gap="sm">
				{message}
				<Button variant="light" size="xs" onClick={retry} style={{ alignSelf: "flex-start" }}>
					{t("workspace.retry")}
				</Button>
			</Stack>
		</Alert>
	);
}

function NarratorPreview(props: {
	narratorId: string;
	sha: string;
	search: CommitPreviewSearch;
	mode: CommitPreviewPageMode;
}) {
	const { t } = useTranslation("git");
	const context = useWorkspaceContext(props.narratorId);
	const narrator = useNarrator(props.narratorId);
	const [initialized, setInitialized] = useState(false);
	// useGitWorkspace keys reads by contextKey, falling back to narrator metadata.
	// Do not mount its consumer on a provisional key: a late identity response would
	// otherwise tear down a visible preview and fetch the same commit a second time.
	useEffect(() => {
		if (
			!context.transitioning &&
			!context.isPending &&
			(context.data?.contextKey || !narrator.isPending)
		)
			setInitialized(true);
	}, [context.transitioning, context.isPending, context.data?.contextKey, narrator.isPending]);
	// This is a first-visit gate, not a background-fetch gate. In particular, a legacy
	// context endpoint may retry on mount; that retry must not keep unmounting its child.
	if (!initialized || context.transitioning) return <Loader aria-label={t("workspace.loading")} />;
	return <NarratorWorkspacePreview {...props} />;
}

function NarratorWorkspacePreview({
	narratorId,
	sha,
	search,
	mode,
}: {
	narratorId: string;
	sha: string;
	search: CommitPreviewSearch;
	mode: CommitPreviewPageMode;
}) {
	const { t } = useTranslation("git");
	const router = useRouter();
	const workspace = useGitWorkspace(narratorId);
	const [checked, setChecked] = useState(false);
	const { refetch } = workspace;
	useEffect(() => {
		let active = true;
		// Even a fresh-looking cache entry is not authorization for a new page visit.
		void refetch({ cancelRefetch: false }).then(() => {
			if (active) setChecked(true);
		});
		return () => {
			active = false;
		};
	}, [refetch]);
	const target = !workspace.isError ? gitWorkspaceTarget(narratorId, workspace.data) : null;
	const mismatch =
		target &&
		typeof target !== "string" &&
		search.workspaceKey !== undefined &&
		search.workspaceKey !== target.workspaceKey;
	const mustPin = checked && target && !mismatch && search.workspaceKey === undefined;
	useEffect(() => {
		if (!mustPin || !target) return;
		void router.navigate({
			href: buildCommitPreviewHref(target, sha, search.file, mode),
			replace: true,
		});
	}, [router, mustPin, target, sha, search.file, mode]);
	if (!checked || workspace.isLoading) return <Loader aria-label={t("workspace.loading")} />;
	if (workspace.isError)
		return <PreviewFailure error={workspace.error} retry={() => void refetch()} />;
	if (mismatch) return <PreviewFailure error={{ status: 409 }} retry={() => void refetch()} />;
	if (!target)
		return (
			<Alert color="yellow" role="alert">
				<Stack gap="sm">
					{t(
						`workspace.${workspace.data?.state === "ready" ? "access_denied" : (workspace.data?.state ?? "error")}`,
					)}
					<Button variant="light" size="xs" onClick={() => void refetch()}>
						{t("workspace.retry")}
					</Button>
				</Stack>
			</Alert>
		);
	if (mustPin) return <Loader aria-label={t("workspace.loading")} />;
	return (
		<ResolvedPreview
			key={JSON.stringify([gitBasePath(target), gitTargetKey(target), sha])}
			target={target}
			sha={sha}
			file={search.file}
			mode={mode}
		/>
	);
}

function ResolvedPreview({
	target,
	sha,
	file,
	mode,
}: {
	target: GitTarget;
	sha: string;
	file?: string;
	mode: CommitPreviewPageMode;
}) {
	const { t } = useTranslation("git");
	const router = useRouter();
	const detail = useGitCommitDetail(target, sha);
	const [checked, setChecked] = useState(false);
	const { refetch } = detail;
	useEffect(() => {
		let active = true;
		// Commit content is immutable, access is not. Verify cached chapter reads too.
		void refetch({ cancelRefetch: false }).then(() => {
			if (active) setChecked(true);
		});
		return () => {
			active = false;
		};
	}, [refetch]);
	const data = checked && !detail.isError && !detail.isFetching ? detail.data : undefined;
	const firstFile = data?.files[0]?.path;
	useEffect(() => {
		if (file !== undefined || firstFile === undefined) return;
		void router.navigate({
			href: buildCommitPreviewHref(target, sha, firstFile, mode),
			replace: true,
		});
	}, [router, target, sha, file, firstFile, mode]);
	if (!checked || detail.isLoading || detail.isFetching) return <Loader />;
	if (detail.isError) return <PreviewFailure error={detail.error} retry={() => void refetch()} />;
	if (file !== undefined && data && !data.files.some((entry) => entry.path === file))
		return (
			<Alert color="red" role="alert">
				{t("commitPreview.page.invalidFile", {
					defaultValue: "The selected file is not in this commit's available file list.",
				})}
			</Alert>
		);
	return (
		<GitCommitPreview
			target={target}
			sha={sha}
			mode={mode}
			selectedPath={file ?? null}
			onSelectPath={(path) => {
				if (path === file || !data?.files.some((entry) => entry.path === path)) return;
				void router.navigate({ href: buildCommitPreviewHref(target, sha, path, mode) });
			}}
			onNavigateCommit={(parent) => {
				if (!data?.parents.includes(parent)) return;
				void router.navigate({ href: buildCommitPreviewHref(target, parent, undefined, mode) });
			}}
		/>
	);
}

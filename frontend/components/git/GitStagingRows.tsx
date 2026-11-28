import { statusRegistry } from "@frontend/lib/status-registry";
import { ActionIcon, Badge, Button, Checkbox, Group, Loader, Menu, Text } from "@mantine/core";
import type {
	GitStagingFile,
	GitStagingFilesPage,
	GitStagingList,
	GitStagingStatsTotal,
	GitStagingSummary,
} from "@shared/git-staging-lists";
import { IconArrowRight, IconBinary, IconDots, IconGitBranch } from "@tabler/icons-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { type GitStagingController, useGitStagingFiles } from "../../hooks/useGitStagingLists";
import type { GitTarget } from "../../lib/api/git";
import { LeftTruncatedPathText } from "../common/TruncatedPath";
import classes from "./GitChangesTab.module.css";
import type { GitStagingManagementAction } from "./GitStagingLists";
import {
	clampGitFilePath,
	DirectoryGlyph,
	LineStats,
	STATUS_BADGE_WIDTH,
	TreeRow,
} from "./GitTreeRow";
import { type GitStagingChangesRow, gitStagingPagesComplete } from "./git-changes-list-model";
import { gitFileBadgeChar } from "./git-file-status";
import { gitStagingListDisplayName } from "./git-staging-list-display";
import type { GitStatusFilterChar } from "./git-status-filter";
import type { GitStagingListPagesInput } from "./useGitChangesList";

const EMPTY_PAGES: readonly GitStagingFilesPage[] = [];
export interface GitStagingPageReport extends GitStagingListPagesInput {
	scope: string;
	error: Error | null;
	fetching: boolean;
	complete: boolean;
	retry: () => void;
}

/** Only expansion starts a reader; collapsed readers keep their existing pages. */
export function GitStagingPageLoader({
	scope,
	target,
	summary,
	list,
	enabled,
	filter,
	onReport,
}: {
	scope: string;
	target: GitTarget;
	summary: GitStagingSummary;
	list: GitStagingList;
	enabled: boolean;
	filter?: GitStatusFilterChar[];
	onReport: (report: GitStagingPageReport) => void;
}) {
	const files = useGitStagingFiles(target, summary, list, enabled, filter);
	useEffect(() => {
		const pages = files.displayAllowed ? (files.data?.pages ?? EMPTY_PAGES) : EMPTY_PAGES;
		onReport({
			scope,
			listId: list.id,
			pages,
			error: files.error,
			fetching: files.isFetching,
			complete: gitStagingPagesComplete(pages),
			retry: () => void files.retry(),
		});
	}, [
		scope,
		list.id,
		files.data,
		files.displayAllowed,
		files.error,
		files.isFetching,
		files.retry,
		onReport,
	]);
	return null;
}

function StagingStats({
	stats,
	refreshing,
}: {
	stats?: GitStagingStatsTotal;
	refreshing?: boolean;
}) {
	const { t } = useTranslation("git");
	if (!stats) return null;
	const hasText = stats.files === 0 || stats.files > stats.binaryFiles + stats.gitlinkFiles;
	const nonText = stats.binaryFiles > 0 || stats.gitlinkFiles > 0;
	return (
		<LineStats
			added={hasText ? stats.added : undefined}
			removed={hasText ? stats.removed : undefined}
			refreshing={refreshing}
			annotation={
				nonText
					? {
							label: t("staging.nonTextStats", {
								binary: stats.binaryFiles,
								gitlink: stats.gitlinkFiles,
							}),
							content: stats.binaryFiles ? <IconBinary size={12} /> : <IconGitBranch size={12} />,
						}
					: undefined
			}
		/>
	);
}

export function GitStagingRow({
	row,
	staging,
	report,
	onToggle,
	onToggleFolder,
	onManage,
	onPreview,
	onMove,
	onSelect,
	selection,
}: {
	row: GitStagingChangesRow;
	staging: GitStagingController;
	displaySummary?: GitStagingSummary;
	report?: GitStagingPageReport;
	onToggle: (listId: string) => void;
	onToggleFolder: (listId: string, path: string) => void;
	onManage: (listId: string, action: GitStagingManagementAction) => void;
	onPreview: (listId: string, file: GitStagingFile) => void;
	onMove: (listId: string, paths?: string[], directory?: string) => void;
	onSelect: (listId: string, path?: string) => void;
	selection?: { fromListId: string; paths?: string[]; scope?: unknown } | null;
}) {
	const { t } = useTranslation("git");
	const listName =
		row.type === "staging-section" ? gitStagingListDisplayName(row.list, t) : undefined;
	if (row.type === "staging-section")
		return (
			<TreeRow
				depth={0}
				expanded={row.expanded}
				label={t(row.expanded ? "collapseFolder" : "expandFolder", { path: listName })}
				onActivate={() => onToggle(row.list.id)}
				data-git-staging-toggle={row.list.id}
			>
				<Checkbox
					size="xs"
					aria-label={t("staging.selectAll", { name: listName })}
					disabled={!staging.writable}
					checked={selection?.fromListId === row.list.id && !!selection.scope}
					indeterminate={selection?.fromListId === row.list.id && !!selection.paths?.length}
					onClick={(event) => event.stopPropagation()}
					onChange={() => onSelect(row.list.id)}
				/>
				<DirectoryGlyph expanded={row.expanded} />
				{row.list.active && (
					<Badge size="xs" variant="light">
						{t("staging.active")}
					</Badge>
				)}
				<Text size="xs" fw={600} truncate style={{ flex: 1, minWidth: 0 }} title={listName}>
					{listName}
				</Text>
				{row.stats && (
					<Badge size="xs" variant="light" color="gray" style={{ flexShrink: 0 }}>
						{row.stats.files}
					</Badge>
				)}
				<StagingStats stats={row.stats} refreshing={report?.fetching} />
				{row.expanded && report?.error && report.complete && (
					<Button
						className={classes.touchAction}
						size="compact-xs"
						variant="subtle"
						color="red"
						title={t("staging.filesReadFailed")}
						loading={report.fetching}
						onClick={(event) => {
							event.stopPropagation();
							report.retry();
						}}
						data-git-staging-retry={row.list.id}
					>
						{t("pages.retry")}
					</Button>
				)}
				<Menu withinPortal>
					<Menu.Target>
						<ActionIcon
							className={classes.touchAction}
							size="xs"
							variant="subtle"
							aria-label={t("staging.listActions", { name: listName })}
							data-git-staging-more={row.list.id}
							onClick={(event) => event.stopPropagation()}
						>
							<IconDots size={14} />
						</ActionIcon>
					</Menu.Target>
					<Menu.Dropdown onClick={(event) => event.stopPropagation()}>
						<Menu.Item
							disabled={!staging.writable || row.list.active}
							onClick={() => onManage(row.list.id, "activate")}
						>
							{t("staging.activate")}
						</Menu.Item>
						<Menu.Item
							disabled={!staging.writable || row.list.unitCount === 0}
							onClick={() => onMove(row.list.id)}
						>
							{t("staging.moveToList")}
						</Menu.Item>
						<Menu.Item disabled={!staging.writable} onClick={() => onManage(row.list.id, "rename")}>
							{t("staging.rename")}
						</Menu.Item>
						<Menu.Item
							disabled={!staging.writable || row.list.unitCount === 0}
							onClick={() => onManage(row.list.id, "commit")}
						>
							{t("staging.commit", { name: listName })}
						</Menu.Item>
						<Menu.Item
							color="red"
							disabled={!staging.writable || row.list.active}
							onClick={() => onManage(row.list.id, "delete")}
						>
							{t("staging.delete")}
						</Menu.Item>
					</Menu.Dropdown>
				</Menu>
			</TreeRow>
		);
	if (row.type === "staging-loading")
		return (
			<Group gap={4} h="100%" wrap="nowrap" justify="center">
				{report?.error && (
					<Text size="xs" c="red" truncate role="alert">
						{t("staging.filesReadFailed")}
					</Text>
				)}
				{report?.error || row.incomplete ? (
					<Button
						className={classes.touchAction}
						size="compact-xs"
						variant="subtle"
						loading={report?.fetching ?? false}
						onClick={report?.retry}
						data-git-staging-retry={row.listId}
					>
						{t("pages.retry")}
					</Button>
				) : (
					<Group gap={4} role="status" data-git-staging-loading={row.listId}>
						<Loader size="xs" />
						<Text size="xs">{t("pages.refreshing")}</Text>
					</Group>
				)}
			</Group>
		);
	if (row.type === "staging-directory")
		return (
			<TreeRow
				depth={row.depth}
				expanded={row.expanded}
				label={t(row.expanded ? "collapseFolder" : "expandFolder", { path: row.path })}
				onActivate={() => onToggleFolder(row.listId, row.path)}
				data-git-staging-directory={row.path}
			>
				<DirectoryGlyph expanded={row.expanded} />
				<Text
					size="xs"
					fw={600}
					lineClamp={1}
					style={{ flex: 1, minWidth: 0 }}
					ff="monospace"
					title={row.path}
				>
					{clampGitFilePath(row.label)}
				</Text>
				<Badge size="xs" variant="light" color="gray" style={{ flexShrink: 0 }}>
					{row.fileCount}
					{row.stats ? "" : "+"}
				</Badge>
				<StagingStats stats={row.stats} refreshing={report?.fetching} />
				<ActionIcon
					className={classes.touchAction}
					size="xs"
					variant="subtle"
					aria-label={t("staging.moveToList")}
					title={t("staging.moveToList")}
					disabled={!staging.writable}
					onClick={(event) => {
						event.stopPropagation();
						onMove(row.listId, undefined, row.path);
					}}
				>
					<IconArrowRight size={12} />
				</ActionIcon>
			</TreeRow>
		);
	const status = gitFileBadgeChar(`${row.file.status[0] ?? "M"} `, "staged");
	const stats = row.file.stats;
	return (
		<TreeRow
			depth={row.depth}
			label={t("viewDiffOf", { path: row.path })}
			onActivate={() => onPreview(row.listId, row.file)}
			data-git-staging-file={row.path}
		>
			<Checkbox
				size="xs"
				aria-label={t("staging.selectFile", { path: row.path })}
				disabled={!staging.writable || (selection?.fromListId === row.listId && !!selection.scope)}
				checked={
					selection?.fromListId === row.listId &&
					(!!selection.scope || !!selection.paths?.includes(row.path))
				}
				onClick={(event) => event.stopPropagation()}
				onChange={() => onSelect(row.listId, row.path)}
			/>
			<Badge
				size="xs"
				variant="filled"
				color={statusRegistry.gitFileStatus(status).color}
				w={STATUS_BADGE_WIDTH}
				style={{ flexShrink: 0 }}
			>
				{status}
			</Badge>
			<LeftTruncatedPathText
				path={row.label}
				size="xs"
				ff="monospace"
				style={{ flex: 1, minWidth: 0 }}
				attributes={{
					root: { title: row.file.oldPath ? `${row.file.oldPath} → ${row.path}` : row.path },
				}}
			/>
			<LineStats
				added={stats?.kind === "text" ? stats.added : undefined}
				removed={stats?.kind === "text" ? stats.removed : undefined}
				refreshing={report?.fetching}
				annotation={
					stats?.kind === "binary" || stats?.kind === "gitlink"
						? {
								label: t(stats.kind === "binary" ? "staging.binary" : "staging.gitlink"),
								content:
									stats.kind === "binary" ? <IconBinary size={12} /> : <IconGitBranch size={12} />,
							}
						: undefined
				}
			/>
			<ActionIcon
				className={classes.touchAction}
				size="xs"
				variant="subtle"
				aria-label={t("staging.moveToList")}
				title={t("staging.moveToList")}
				disabled={!staging.writable}
				onClick={(event) => {
					event.stopPropagation();
					onMove(row.listId, [row.path]);
				}}
			>
				<IconArrowRight size={12} />
			</ActionIcon>
		</TreeRow>
	);
}

import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Group,
	Loader,
	Modal,
	ScrollArea,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import {
	GIT_STAGING_LIMITS,
	type GitStagingAction,
	type GitStagingExpectedVersion,
	type GitStagingFile,
	type GitStagingStatsTotal,
} from "@shared/git-staging-lists";
import { gitStatusBadgeChar, gitStatusMatchesSection } from "@shared/git-status-page";
import { IconBinary, IconGitBranch, IconRefresh } from "@tabler/icons-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useGitStagingFolderPrefs } from "../../hooks/useGitStagingFolderPrefs";
import { type GitStagingController, useGitStagingLists } from "../../hooks/useGitStagingLists";
import { useGitStatusFilter } from "../../hooks/useGitStatusFilter";
import { useGitViewMode } from "../../hooks/useGitViewMode";
import type { GitTarget } from "../../lib/api/git";
import { describeApiError } from "../../lib/api-error";
import classes from "./GitChangesTab.module.css";
import { GitLineStatsSummary } from "./GitLineStatsSummary";
import { GitStagingDiffPreview } from "./GitStagingDiffPreview";
import { GitStagingPageLoader, type GitStagingPageReport, GitStagingRow } from "./GitStagingRows";
import { LineStats } from "./GitTreeRow";
import { GIT_CHANGES_ROW_HEIGHT, type GitChangesListConfig } from "./git-changes-list-model";
import { gitStagingListDisplayName } from "./git-staging-list-display";
import { type GitStatusFilterChar, visibleFilterChars } from "./git-status-filter";
import { useGitChangesList } from "./useGitChangesList";

type Props = { staging: GitStagingController };
type Dialog = {
	listId?: string;
	scope: string;
	selectionKey: string;
	version: GitStagingExpectedVersion;
};
export type GitStagingManagementAction = "rename" | "delete" | "commit" | "activate";

/** Dialog selections keep the observation the user actually chose. */
export function useGitStagingManagement({ staging }: Props) {
	const { t } = useTranslation("git");
	const { summary, mutation } = staging;
	const [dialog, setDialog] = useState<
		(Dialog & { action: "create" | "rename" | "delete" | "commit" }) | null
	>(null);
	const [name, setName] = useState("");
	const [message, setMessage] = useState("");
	const scope = staging.scopeKey;
	const live = useRef(scope);
	live.current = scope;
	useLayoutEffect(() => {
		if (live.current !== scope) return;
		setDialog(null);
		setName("");
		setMessage("");
	}, [scope]);
	const selected = summary?.lists.find((list) => list.id === dialog?.listId);
	const current =
		dialog?.scope === scope &&
		dialog.selectionKey === staging.selectionKey &&
		dialog.version.expectedGeneration === summary?.generation &&
		dialog.version.observationId === summary?.observationId;
	function openName(listId?: string) {
		if (!staging.writable || !staging.version || !summary) return;
		setName(
			listId
				? (summary.lists.find((list) => list.id === listId)?.name ?? "")
				: t("staging.defaultName", { count: summary.lists.length + 1 }),
		);
		setDialog({
			action: listId ? "rename" : "create",
			listId,
			scope,
			selectionKey: staging.selectionKey,
			version: staging.version,
		});
	}
	function close() {
		if (!mutation.isPending) setDialog(null);
	}
	function submit() {
		if (!dialog || !current || !staging.writable) return;
		const version = dialog.version;
		let action: GitStagingAction;
		if (dialog.action === "create") {
			if (!name.trim()) return;
			action = { action: "create", name: name.trim(), ...version };
		} else if (dialog.action === "rename") {
			if (!selected || !name.trim()) return;
			action = { action: "rename", listId: selected.id, name: name.trim(), ...version };
		} else if (dialog.action === "delete") {
			if (!selected || selected.active) return;
			action = { action: "delete", listId: selected.id, ...version };
		} else {
			if (!selected || !message.trim() || selected.unitCount === 0) return;
			action = { action: "commit", listId: selected.id, message: message.trim(), ...version };
		}
		mutation.mutate(action, {
			onSuccess: (result) => {
				if (live.current === scope && (result.outcome === "applied" || result.commitOid))
					setDialog(null);
			},
		});
	}
	function manage(listId: string, action: GitStagingManagementAction) {
		const list = summary?.lists.find((entry) => entry.id === listId);
		if (!staging.writable || !staging.version || !list) return;
		if (action === "activate") {
			mutation.mutate({ action, listId, ...staging.version });
			return;
		}
		if (action === "rename") {
			openName(listId);
			return;
		}
		if (action === "delete" && list.active) return;
		setMessage("");
		setDialog({
			action,
			listId,
			scope,
			selectionKey: staging.selectionKey,
			version: staging.version,
		});
	}
	const localizeReadError = (error: Error | null) =>
		error ? new Error(describeApiError(error, t).message) : null;
	const totalFiles = Object.values(summary?.stats ?? {}).reduce(
		(sum, value) => sum + (value?.files ?? 0),
		0,
	);
	const toolbar = staging.supported ? (
		<Group gap={4} wrap="nowrap" h="100%" data-git-staging-lists style={{ minWidth: 0 }}>
			<Text size="xs" fw={600} truncate style={{ flex: 1 }}>
				{t("staging.title")}
			</Text>
			{staging.active && (
				<Badge
					size="xs"
					color="gray"
					variant="light"
					aria-label={t("staging.totalFiles", { count: totalFiles })}
				>
					{totalFiles}
				</Badge>
			)}
			<Button
				className={classes.touchAction}
				size="compact-xs"
				variant="light"
				disabled={staging.active ? !staging.writable : !staging.initializable}
				onClick={() => (staging.active ? openName() : mutation.mutate({ action: "init" }))}
			>
				{t(staging.active ? "staging.create" : "staging.initialize")}
			</Button>
		</Group>
	) : null;
	const failure = mutation.error || staging.query.error;
	const feedback =
		failure || staging.notice || (summary?.initialized && summary.state !== "ready") ? (
			<Stack gap={4} px="xs" py={4}>
				{failure && (
					<Text size="xs" c="red" role="alert">
						{localizeReadError(failure)?.message}
					</Text>
				)}
				{summary?.initialized && summary.state !== "ready" && (
					<Text size="xs" c="orange" role="status">
						{t(`staging.state.${summary.state}`)}
					</Text>
				)}
				{staging.notice && (
					<>
						<Text size="xs" c="red" role="alert">
							{staging.notice.result.commitOid
								? t("staging.commitCleanupFailed", { oid: staging.notice.result.commitOid })
								: t("staging.partial")}
							{staging.notice.result.reason ? `: ${staging.notice.result.reason}` : ""}
						</Text>
						{staging.notice.result.operationId && (
							<Button
								size="compact-xs"
								variant="light"
								disabled={!staging.initializable || !staging.version}
								onClick={() => {
									if (staging.version && staging.notice?.result.operationId)
										mutation.mutate({
											action: "recover",
											operationId: staging.notice.result.operationId,
											...staging.version,
										});
								}}
							>
								{t("staging.recover")}
							</Button>
						)}
					</>
				)}
			</Stack>
		) : null;
	const title =
		dialog?.action === "delete"
			? t("staging.deleteTitle", { name: gitStagingListDisplayName(selected, t) })
			: dialog?.action === "commit"
				? t("staging.commit", { name: gitStagingListDisplayName(selected, t) })
				: t(dialog?.action === "rename" ? "staging.rename" : "staging.create");
	const dialogs = (
		<Modal
			opened={!!summary && !staging.refused && !!dialog && dialog.scope === scope}
			onClose={close}
			title={title}
			size="sm"
			classNames={{ body: classes.safeModal, title: classes.modalTitle }}
			closeButtonProps={{ "aria-label": t("common:close"), disabled: mutation.isPending }}
			closeOnClickOutside={!mutation.isPending}
			closeOnEscape={!mutation.isPending}
		>
			<Stack gap="sm">
				{dialog?.action === "delete" ? (
					<Text size="sm">
						{t("staging.deleteWarning", {
							name: gitStagingListDisplayName(
								summary?.lists.find((list) => list.active),
								t,
							),
						})}
					</Text>
				) : (
					<TextInput
						label={dialog?.action === "commit" ? t("commitMessage") : t("staging.name")}
						value={dialog?.action === "commit" ? message : name}
						maxLength={dialog?.action === "commit" ? undefined : GIT_STAGING_LIMITS.maxNameChars}
						onChange={(event) =>
							dialog?.action === "commit"
								? setMessage(event.currentTarget.value)
								: setName(event.currentTarget.value)
						}
						onKeyDown={(event) => {
							if (event.key === "Enter") submit();
						}}
					/>
				)}
				{!current && (
					<Text size="xs" c="orange" role="alert">
						{t("staging.selectionExpired")}
					</Text>
				)}
				{mutation.error && (
					<Text size="xs" c="red" role="alert">
						{localizeReadError(mutation.error)?.message}
					</Text>
				)}
				<Group justify="flex-end">
					<Button variant="default" disabled={mutation.isPending} onClick={close}>
						{t("common:cancel")}
					</Button>
					<Button
						color={dialog?.action === "delete" ? "red" : undefined}
						disabled={
							!staging.writable ||
							!current ||
							(dialog?.action === "commit"
								? !message.trim() || !selected?.unitCount
								: dialog?.action !== "delete" && !name.trim())
						}
						loading={mutation.isPending}
						onClick={submit}
						data-git-staging-confirm-delete={dialog?.action === "delete" || undefined}
					>
						{t(
							dialog?.action === "delete"
								? "staging.delete"
								: dialog?.action === "commit"
									? "commitButton"
									: "common:save",
						)}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
	return { toolbar, feedback, dialogs, manage, localizeReadError };
}

export function GitStagingLists(props: Props) {
	const management = useGitStagingManagement(props);
	return (
		<Box>
			{management.toolbar}
			{management.feedback}
			{management.dialogs}
		</Box>
	);
}

type Move = Omit<Extract<GitStagingAction, { action: "move" }>, "action" | "toListId"> & {
	owner: string;
};
const EMPTY_PAGES: never[] = [];

export function GitStagingWorkspace({ target }: { target: GitTarget; onRefresh?: () => void }) {
	const { t } = useTranslation("git");
	const staging = useGitStagingLists(target);
	const management = useGitStagingManagement({ staging });
	const { summary } = staging;
	const filter = useGitStatusFilter(`${target.workspaceKey}:changelists`);
	const { mode, setMode } = useGitViewMode(`${target.workspaceKey}:changelists`);
	const observation = JSON.stringify([
		staging.scopeKey,
		summary?.generation,
		summary?.observationId,
		[...filter.selected].sort(),
	]);
	const { groups, folders, toggleGroup, toggleFolder } = useGitStagingFolderPrefs(
		staging.preferenceKey,
	);
	const [reports, setReports] = useState<Record<string, GitStagingPageReport>>({});
	const report = useCallback(
		(value: GitStagingPageReport) =>
			setReports((previous) => ({ ...previous, [value.listId]: value })),
		[],
	);
	const stagingPages = useMemo(
		() => Object.values(reports).filter((entry) => entry.scope === observation),
		[reports, observation],
	);
	const config = useMemo<GitChangesListConfig>(
		() => ({
			stagingOnly: true,
			mode,
			filter: [...filter.selected],
			expanded: { staged: [], unstaged: [] },
			staging: {
				lists: summary?.lists ?? [],
				observationId: summary?.observationId ?? undefined,
				generation: summary?.generation,
				expanded: groups,
				folders,
			},
		}),
		[summary, mode, filter.selected, groups, folders],
	);
	const list = useGitChangesList({
		generation: observation,
		pages: EMPTY_PAGES,
		config,
		stagingPages,
		displayScope: staging.scopeKey,
		displayAllowed: staging.active && !staging.refused,
	});
	const rowsCurrent = list.isCurrent && !list.isRetained && list.displayGeneration === observation;
	const rowStaging = { ...staging, writable: staging.writable && rowsCurrent };
	const selectionOwner = JSON.stringify([observation, staging.selectionKey]);
	const [selection, setSelection] = useState<Move | null>(null);
	const selected = selection?.owner === selectionOwner ? selection : null;
	const [moving, setMoving] = useState(false);
	const [preview, setPreview] = useState<{
		owner: string;
		listId: string;
		file: GitStagingFile;
	} | null>(null);
	const previewList =
		preview?.owner === staging.displayScope && staging.active && !staging.refused
			? summary?.lists.find((entry) => entry.id === preview.listId)
			: undefined;
	const closePreview = useCallback(() => setPreview(null), []);
	const selectionCount =
		selected?.paths?.length ??
		(selected
			? Object.entries(
					summary?.lists.find((entry) => entry.id === selected.fromListId)?.stats ?? {},
				).reduce(
					(sum, [status, value]) =>
						sum +
						(gitStatusMatchesSection(`${status} `, "staged", [...filter.selected])
							? (value?.files ?? 0)
							: 0),
					0,
				)
			: 0);
	const statusCounts = new Map<GitStatusFilterChar, number>();
	const totalStats: GitStagingStatsTotal | undefined = summary?.observationId
		? { files: 0, added: 0, removed: 0, binaryFiles: 0, gitlinkFiles: 0 }
		: undefined;
	for (const [status, value] of Object.entries(summary?.stats ?? {})) {
		const char = gitStatusBadgeChar(`${status} `, "staged");
		statusCounts.set(char, (statusCounts.get(char) ?? 0) + (value?.files ?? 0));
		if (totalStats && value) {
			totalStats.files += value.files;
			totalStats.added += value.added;
			totalStats.removed += value.removed;
			totalStats.binaryFiles += value.binaryFiles;
			totalStats.gitlinkFiles += value.gitlinkFiles;
		}
	}
	const hasTextStats =
		totalStats &&
		(totalStats.files === 0 || totalStats.files > totalStats.binaryFiles + totalStats.gitlinkFiles);
	const chars = visibleFilterChars(statusCounts, filter.selected);
	function select(fromListId: string, path?: string) {
		if (!staging.version || !rowStaging.writable) return;
		if (!path) {
			setSelection(
				selected?.fromListId === fromListId && selected.scope
					? null
					: {
							owner: selectionOwner,
							fromListId,
							scope: { filter: [...filter.selected] },
							...staging.version,
						},
			);
			return;
		}
		const paths = selected?.fromListId === fromListId && selected.paths ? selected.paths : [];
		setSelection({
			owner: selectionOwner,
			fromListId,
			paths: paths.includes(path) ? paths.filter((value) => value !== path) : [...paths, path],
			...staging.version,
		});
	}
	function move(fromListId: string, paths?: string[], directory?: string) {
		if (!staging.version || !rowStaging.writable) return;
		setSelection({
			owner: selectionOwner,
			fromListId,
			...(paths
				? { paths }
				: { scope: { filter: [...filter.selected], ...(directory ? { directory } : {}) } }),
			...staging.version,
		});
		setMoving(true);
	}
	const moveTargets = (
		<Stack gap="xs" data-git-staging-picker>
			{staging.mutation.error && (
				<Text size="xs" c="red" role="alert">
					{management.localizeReadError(staging.mutation.error)?.message}
				</Text>
			)}
			{summary?.lists.map((destination) => (
				<Button
					key={destination.id}
					data-git-staging-target={destination.id}
					disabled={!staging.writable || destination.id === selected?.fromListId}
					onClick={() => {
						if (!selected || !staging.writable || destination.id === selected.fromListId) return;
						const { owner: _owner, scope, ...request } = selected;
						const selector = scope
							? scope.directory || scope.filter?.length
								? { scope }
								: { all: true as const }
							: {};
						staging.mutation.mutate(
							{ action: "move", ...request, ...selector, toListId: destination.id },
							{
								onSuccess: () => {
									setMoving(false);
									setSelection(null);
									setPreview(null);
								},
							},
						);
					}}
				>
					{gitStagingListDisplayName(destination, t)}
				</Button>
			))}
		</Stack>
	);
	return (
		<Box
			style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
			data-git-staging-observation={staging.observation?.status ?? "unknown"}
		>
			<Group px="xs" py={4} gap="xs" wrap="nowrap">
				<Box style={{ flex: 1 }}>{management.toolbar}</Box>
				<ActionIcon
					variant="subtle"
					aria-label={t("workspace.retry")}
					title={t(
						staging.observation?.status === "failed"
							? "workspace.retry"
							: staging.observing
								? "staging.observing"
								: "workspace.retry",
					)}
					data-git-staging-refresh
					disabled={!staging.canRefresh}
					loading={staging.mutation.isPending}
					onClick={() => {
						void staging.refresh().catch(() => {});
					}}
				>
					<IconRefresh
						size={15}
						className={staging.active && staging.observing ? classes.refreshing : undefined}
					/>
				</ActionIcon>
			</Group>
			{management.feedback}
			{management.dialogs}
			{staging.query.isLoading && <Loader size="xs" />}
			{summary && !staging.supported && (
				<Text size="xs" px="xs">
					{t("staging.unsupported")}
				</Text>
			)}
			{staging.active && (
				<>
					<Group px="xs" py={4} gap={4} wrap="wrap">
						<Button.Group>
							<Button
								size="compact-xs"
								variant={mode === "tree" ? "filled" : "subtle"}
								onClick={() => setMode("tree")}
							>
								{t("view.tree")}
							</Button>
							<Button
								size="compact-xs"
								variant={mode === "flat" ? "filled" : "subtle"}
								onClick={() => setMode("flat")}
							>
								{t("view.flat")}
							</Button>
						</Button.Group>
						{chars.map((char) => (
							<Badge
								key={char}
								component="button"
								type="button"
								size="sm"
								variant={filter.selected.has(char) ? "filled" : "light"}
								aria-pressed={filter.selected.has(char)}
								onClick={() => filter.toggle(char)}
							>
								{char} {statusCounts.get(char) ?? 0}
							</Badge>
						))}
						{filter.selected.size > 0 && (
							<Button size="compact-xs" variant="subtle" onClick={filter.clear}>
								{t("filter.clear")}
							</Button>
						)}
						{selected && (selected.paths?.length || selected.scope) && (
							<Button
								size="compact-xs"
								variant="light"
								disabled={!staging.writable}
								onClick={() => setMoving(true)}
							>
								{selected.scope?.directory
									? t("staging.moveToList")
									: t("staging.moveSelected", { count: selectionCount })}
							</Button>
						)}
						{totalStats && (
							<Group
								ml="auto"
								gap={5}
								wrap="nowrap"
								style={{ flexShrink: 0 }}
								aria-busy={staging.observing}
								data-git-staging-total-stats
							>
								<LineStats
									refreshing={staging.observing}
									annotation={
										totalStats.binaryFiles > 0 || totalStats.gitlinkFiles > 0
											? {
													label: t("staging.nonTextStats", {
														binary: totalStats.binaryFiles,
														gitlink: totalStats.gitlinkFiles,
													}),
													content: totalStats.binaryFiles ? (
														<IconBinary size={12} />
													) : (
														<IconGitBranch size={12} />
													),
												}
											: undefined
									}
								/>
								{hasTextStats && (
									<GitLineStatsSummary
										data={{
											linesAdded: totalStats.added,
											linesRemoved: totalStats.removed,
											complete: true,
										}}
										error={null}
									/>
								)}
							</Group>
						)}
					</Group>
					{summary?.lists.map((entry) => (
						<GitStagingPageLoader
							key={entry.id}
							scope={observation}
							target={target}
							summary={summary}
							list={entry}
							enabled={groups.includes(entry.id)}
							filter={[...filter.selected]}
							onReport={report}
						/>
					))}
					{list.error && (
						<Text size="xs" c="red" role="alert">
							{management.localizeReadError(list.error)?.message}
						</Text>
					)}
					<ScrollArea
						style={{ flex: 1, minHeight: 0 }}
						viewportRef={list.viewportRef}
						onScrollPositionChange={list.onScroll}
					>
						<Box px={4} data-git-changelists>
							<div
								aria-hidden="true"
								style={{ height: list.window.start * GIT_CHANGES_ROW_HEIGHT }}
							/>
							{list.window.rows.map((row) => (
								<Box key={row.key} h={GIT_CHANGES_ROW_HEIGHT} data-git-row-type={row.type}>
									{row.type === "staging-section" ||
									row.type === "staging-file" ||
									row.type === "staging-directory" ||
									row.type === "staging-loading" ? (
										<GitStagingRow
											row={row}
											staging={rowStaging}
											report={stagingPages.find(
												(entry) => entry.listId === ("list" in row ? row.list.id : row.listId),
											)}
											onToggle={toggleGroup}
											onToggleFolder={toggleFolder}
											onManage={management.manage}
											onPreview={(listId, file) => {
												if (rowsCurrent) setPreview({ owner: staging.displayScope, listId, file });
											}}
											onMove={move}
											onSelect={select}
											selection={selected}
										/>
									) : null}
								</Box>
							))}
							<div
								aria-hidden="true"
								style={{
									height:
										Math.max(
											0,
											list.window.totalRows - list.window.start - list.window.rows.length,
										) * GIT_CHANGES_ROW_HEIGHT,
								}}
							/>
						</Box>
					</ScrollArea>
				</>
			)}
			<Modal
				opened={!!previewList}
				onClose={() => {
					if (!staging.mutation.isPending) closePreview();
				}}
				title={t("staging.diffTitle", {
					name: gitStagingListDisplayName(previewList, t),
					file: preview?.file.path,
				})}
				size="xl"
				classNames={{ body: classes.safeModal, title: classes.modalTitle }}
				closeButtonProps={{ "aria-label": t("common:close") }}
			>
				{previewList && preview && (
					<GitStagingDiffPreview
						key={`${staging.displayScope}:${previewList.id}:${preview.file.fileId}`}
						target={target}
						staging={staging}
						list={previewList}
						file={preview.file}
						onEmpty={closePreview}
						localizeError={management.localizeReadError}
					/>
				)}
			</Modal>
			<Modal
				opened={moving && !!selected && !!summary}
				onClose={() => {
					if (!staging.mutation.isPending) setMoving(false);
				}}
				title={t("staging.moveToList")}
				size="sm"
				classNames={{ body: classes.safeModal, title: classes.modalTitle }}
				closeButtonProps={{ "aria-label": t("common:close") }}
			>
				{moveTargets}
			</Modal>
		</Box>
	);
}

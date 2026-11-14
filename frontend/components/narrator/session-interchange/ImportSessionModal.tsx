/**
 * Import a Claude Code or Codex session as a new narrator.
 *
 * Three sources: an upload from this browser (anyone), a scan of the server's
 * `~/.claude` / `~/.codex` (admins only; the tab is hidden otherwise because the
 * server would refuse), and a scan of an online device the caller manages.
 */

import {
	Badge,
	Button,
	CloseButton,
	Divider,
	FileButton,
	Group,
	Loader,
	Modal,
	Progress,
	ScrollArea,
	SegmentedControl,
	Select,
	Stack,
	Tabs,
	Text,
	TextInput,
	UnstyledButton,
} from "@mantine/core";
import { IconFileUpload, IconFolder, IconRefresh } from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAllModels } from "../../../hooks/useModels";
import { api } from "../../../lib/api";
import type {
	SessionCandidate,
	SessionFormat,
	SessionImportResult,
	SessionLocation,
} from "../../../lib/api/session-interchange";
import { describeApiError } from "../../../lib/api-error";
import { FOLLOW_DEFAULT_MODEL } from "../../../lib/constants";
import { formatRelativeTime } from "../../../lib/format";
import { SessionWarningsList } from "./SessionWarningsList";
import {
	availableImportSources,
	effectiveImportSource,
	formatBytes,
	type ImportSource,
	mergeUploadFiles,
	selectedSessionDevice,
} from "./session-interchange-logic";
import { useSessionTargets } from "./useSessionTargets";

type SourceTab = ImportSource;

const SOURCE_LABEL_KEYS: Record<ImportSource, string> = {
	upload: "sessionInterchange.sourceUpload",
	local: "sessionInterchange.sourceServer",
	device: "sessionInterchange.sourceDevice",
};

export interface ImportSessionModalProps {
	opened: boolean;
	onClose: () => void;
	/** Called once the narrator exists; the caller navigates to it. */
	onImported: (result: SessionImportResult & { title: string }) => void;
}

const MODEL_SELECT_OPTION_LIMIT = 100;

function CandidateRow({
	candidate,
	selected,
	onSelect,
}: {
	candidate: SessionCandidate;
	selected: boolean;
	onSelect: () => void;
}) {
	const { t } = useTranslation("narrators");
	return (
		<UnstyledButton
			onClick={onSelect}
			aria-pressed={selected}
			p="xs"
			style={{
				borderRadius: "var(--mantine-radius-sm)",
				border: `1px solid ${selected ? "var(--mantine-primary-color-filled)" : "var(--mantine-color-default-border)"}`,
				background: selected ? "var(--mantine-primary-color-light)" : undefined,
				width: "100%",
			}}
		>
			<Group justify="space-between" wrap="nowrap" gap="xs">
				<Text size="sm" fw={500} truncate>
					{candidate.title || t("sessionInterchange.untitled")}
				</Text>
				<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
					{formatRelativeTime(candidate.mtime)}
				</Text>
			</Group>
			<Group gap={6} mt={2} wrap="nowrap">
				<Text size="xs" c="dimmed" ff="monospace" truncate style={{ flex: 1, minWidth: 0 }}>
					{candidate.cwd || candidate.sessionId}
				</Text>
				{candidate.subagentCount ? (
					<Badge size="xs" variant="light">
						{t("sessionInterchange.subagentCount", { count: candidate.subagentCount })}
					</Badge>
				) : null}
				{candidate.archived ? (
					<Badge size="xs" variant="light" color="gray">
						{t("sessionInterchange.archived")}
					</Badge>
				) : null}
				<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
					{formatBytes(candidate.size)}
				</Text>
			</Group>
		</UnstyledButton>
	);
}

function CandidateList({
	format,
	location,
	selectedPath,
	onSelect,
	onRootResolved,
}: {
	format: SessionFormat;
	location: SessionLocation;
	selectedPath: string | null;
	onSelect: (candidate: SessionCandidate) => void;
	onRootResolved: (root: string) => void;
}) {
	const { t } = useTranslation("narrators");
	const { t: te } = useTranslation("errors");
	const query = useInfiniteQuery({
		queryKey: ["session-interchange", "scan", format, location],
		queryFn: ({ pageParam, signal }) =>
			api.scanSessions({ format, location, cursor: pageParam ?? undefined, limit: 30 }, signal),
		initialPageParam: null as string | null,
		getNextPageParam: (page) => page.nextCursor,
		retry: false,
	});
	const root = query.data?.pages[0]?.root;
	useEffect(() => {
		if (root) onRootResolved(root);
	}, [root, onRootResolved]);

	if (query.isLoading) return <Loader size="sm" />;
	if (query.isError) {
		return (
			<Text size="sm" c="red">
				{query.error
					? describeApiError(query.error, te, t("sessionInterchange.scanFailed")).message
					: t("sessionInterchange.scanFailed")}
			</Text>
		);
	}
	const candidates = query.data?.pages.flatMap((page) => page.candidates) ?? [];
	const truncated = query.data?.pages.some((page) => page.truncated);
	return (
		<Stack gap="xs">
			<Group justify="space-between">
				<Text size="xs" c="dimmed" ff="monospace" truncate style={{ flex: 1, minWidth: 0 }}>
					{root}
				</Text>
				<Button
					size="compact-xs"
					variant="subtle"
					leftSection={<IconRefresh size={12} />}
					onClick={() => query.refetch()}
					loading={query.isRefetching}
				>
					{t("sessionInterchange.rescan")}
				</Button>
			</Group>
			{candidates.length === 0 ? (
				<Text size="sm" c="dimmed">
					{t("sessionInterchange.noSessions")}
				</Text>
			) : (
				<ScrollArea.Autosize mah={300} type="auto">
					<Stack gap={6} pr="xs">
						{candidates.map((candidate) => (
							<CandidateRow
								key={candidate.path}
								candidate={candidate}
								selected={candidate.path === selectedPath}
								onSelect={() => onSelect(candidate)}
							/>
						))}
					</Stack>
				</ScrollArea.Autosize>
			)}
			{query.hasNextPage ? (
				<Button
					size="xs"
					variant="default"
					onClick={() => query.fetchNextPage()}
					loading={query.isFetchingNextPage}
				>
					{t("sessionInterchange.loadMore")}
				</Button>
			) : null}
			{truncated ? (
				<Text size="xs" c="dimmed">
					{t("sessionInterchange.scanTruncated")}
				</Text>
			) : null}
		</Stack>
	);
}

export function ImportSessionModal({ opened, onClose, onImported }: ImportSessionModalProps) {
	const { t } = useTranslation("narrators");
	const { t: tc } = useTranslation("common");
	const { t: te } = useTranslation("errors");
	const qc = useQueryClient();
	const targets = useSessionTargets(opened);
	const fileResetRef = useRef<() => void>(null);
	const { groupedModels, modelOptionsFilter } = useAllModels();

	const [requestedTab, setTab] = useState<SourceTab>("upload");
	const [format, setFormat] = useState<SessionFormat>("claude-code");
	const [deviceId, setDeviceId] = useState<string | null>(null);
	const [rootInput, setRootInput] = useState("");
	const [appliedRoot, setAppliedRoot] = useState<string | undefined>(undefined);
	const [files, setFiles] = useState<File[]>([]);
	const [selected, setSelected] = useState<SessionCandidate | null>(null);
	const [cwd, setCwd] = useState("");
	const [title, setTitle] = useState("");
	// Whether the fields hold what a selection prefilled, or what the user typed.
	// Only prefilled values are replaced or cleared when the source changes.
	const [cwdTouched, setCwdTouched] = useState(false);
	const [titleTouched, setTitleTouched] = useState(false);
	const [model, setModel] = useState("");
	const [progress, setProgress] = useState<number | null>(null);
	const [result, setResult] = useState<SessionImportResult | null>(null);

	const availableSources = availableImportSources(targets.isAdmin, targets.devices.length);
	// A tab whose source disappeared (devices went offline) falls back to upload
	// rather than leaving an empty, unusable pane selected.
	const tab = effectiveImportSource(requestedTab, availableSources);
	const device = selectedSessionDevice(targets.devices, deviceId);
	const location: SessionLocation | null =
		tab === "local"
			? { target: "local", ...(appliedRoot ? { root: appliedRoot } : {}) }
			: tab === "device" && device
				? { target: "device", deviceId: device.id, ...(appliedRoot ? { root: appliedRoot } : {}) }
				: null;

	// A new source, format or (on the device tab) device starts a fresh selection.
	// The root override does not carry across machines, and values a previous
	// selection prefilled must not follow the user into a different session.
	const sourceKey = `${tab}|${format}|${tab === "device" ? (device?.id ?? "") : ""}`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset on source change only
	useEffect(() => {
		setSelected(null);
		setRootInput("");
		setAppliedRoot(undefined);
		if (!cwdTouched) setCwd("");
		if (!titleTouched) setTitle("");
	}, [sourceKey]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: prefill on selection only
	useEffect(() => {
		if (!selected) return;
		if (!cwdTouched) setCwd(selected.cwd ?? "");
		if (!titleTouched) setTitle(selected.title ?? "");
	}, [selected]);

	const reset = () => {
		setFiles([]);
		setSelected(null);
		setCwd("");
		setTitle("");
		setCwdTouched(false);
		setTitleTouched(false);
		setModel("");
		setProgress(null);
		setResult(null);
		setRootInput("");
		setAppliedRoot(undefined);
	};

	const importMutation = useMutation({
		mutationFn: async () => {
			const overrides = {
				cwd: cwd.trim() || undefined,
				title: title.trim() || undefined,
				model: model && model !== FOLLOW_DEFAULT_MODEL ? model : undefined,
			};
			if (tab === "upload") {
				setProgress(0);
				return api.importSessionUpload(
					files,
					{ format: "auto", ...overrides },
					{
						onProgress: setProgress,
					},
				);
			}
			if (!location || !selected) throw new Error(t("sessionInterchange.selectSession"));
			return api.importSessionFromPath({
				format,
				location,
				path: selected.path,
				...overrides,
			});
		},
		onSuccess: (data) => {
			setProgress(null);
			void qc.invalidateQueries({ queryKey: ["narrators"] });
			if (data.warnings.length > 0) {
				// Keep the modal open so the warnings are read before leaving.
				setResult(data);
				return;
			}
			finish(data);
		},
		onError: () => setProgress(null),
	});

	const finish = (data: SessionImportResult) => {
		onImported({ ...data, title: title.trim() || selected?.title || files[0]?.name || "" });
		reset();
		onClose();
	};

	const handleClose = () => {
		if (importMutation.isPending) return;
		if (result) {
			finish(result);
			return;
		}
		reset();
		onClose();
	};

	const tabs = availableSources.map((value) => ({ value, label: t(SOURCE_LABEL_KEYS[value]) }));

	const canImport =
		!importMutation.isPending &&
		!result &&
		(tab === "upload" ? files.length > 0 : !!selected && !!location);

	// Prefill the root field with the directory the server actually scanned, without
	// overwriting anything the user typed.
	const handleRootResolved = useCallback(
		(root: string) => setRootInput((current) => current || root),
		[],
	);

	return (
		<Modal
			opened={opened}
			onClose={handleClose}
			title={t("sessionInterchange.importTitle")}
			size="lg"
		>
			<Stack gap="md">
				{result ? (
					<Stack gap="sm">
						<Text size="sm">
							{t("sessionInterchange.importDone", { count: result.messageCount })}
						</Text>
						<SessionWarningsList warnings={result.warnings} direction="import" />
					</Stack>
				) : (
					<>
						<Text size="xs" c="dimmed">
							{t("sessionInterchange.importDescription")}
						</Text>
						<Tabs value={tab} onChange={(value) => setTab((value as SourceTab) ?? "upload")}>
							<Tabs.List>
								{tabs.map((item) => (
									<Tabs.Tab key={item.value} value={item.value}>
										{item.label}
									</Tabs.Tab>
								))}
							</Tabs.List>
						</Tabs>

						{tab === "upload" ? (
							<Stack gap="xs">
								<Group gap="xs">
									<FileButton
										resetRef={fileResetRef}
										onChange={(picked) => {
											setFiles((current) => mergeUploadFiles(current, picked));
											// Let the same file be picked again after it was removed.
											fileResetRef.current?.();
										}}
										accept=".jsonl,.zst,application/x-ndjson"
										multiple
									>
										{(props) => (
											<Button
												{...props}
												variant="default"
												leftSection={<IconFileUpload size={16} />}
											>
												{files.length > 0
													? t("sessionInterchange.addFiles")
													: t("sessionInterchange.chooseFiles")}
											</Button>
										)}
									</FileButton>
									{files.length > 0 ? (
										<>
											<Text size="xs" c="dimmed">
												{t("sessionInterchange.filesChosen", { count: files.length })}
											</Text>
											<Button size="compact-xs" variant="subtle" onClick={() => setFiles([])}>
												{t("sessionInterchange.clearFiles")}
											</Button>
										</>
									) : null}
								</Group>
								<Text size="xs" c="dimmed">
									{t("sessionInterchange.uploadHint")}
								</Text>
								{files.length > 0 ? (
									<Stack gap={2}>
										{files.map((file) => (
											<Group key={file.name} gap={4} wrap="nowrap">
												<Text size="xs" ff="monospace" truncate style={{ flex: 1 }}>
													{file.name} · {formatBytes(file.size)}
												</Text>
												<CloseButton
													size="xs"
													aria-label={t("sessionInterchange.removeFile", { name: file.name })}
													onClick={() =>
														setFiles((current) => current.filter((f) => f.name !== file.name))
													}
												/>
											</Group>
										))}
									</Stack>
								) : null}
							</Stack>
						) : (
							<Stack gap="xs">
								<Group grow align="flex-end">
									<SegmentedControl
										size="xs"
										value={format}
										onChange={(value) => setFormat(value as SessionFormat)}
										data={[
											{ value: "claude-code", label: "Claude Code" },
											{ value: "codex", label: "Codex" },
										]}
									/>
									{tab === "device" ? (
										<Select
											size="xs"
											aria-label={t("sessionInterchange.device")}
											placeholder={t("sessionInterchange.selectDevice")}
											data={targets.devices.map((d) => ({ value: d.id, label: d.name }))}
											value={device?.id ?? null}
											onChange={setDeviceId}
											allowDeselect={false}
										/>
									) : null}
								</Group>
								{tab === "device" && deviceId && !device ? (
									<Text size="xs" c="red">
										{t("sessionInterchange.deviceUnavailable")}
									</Text>
								) : null}
								<Group gap="xs" align="flex-end" wrap="nowrap">
									<TextInput
										size="xs"
										style={{ flex: 1 }}
										label={t("sessionInterchange.rootLabel")}
										placeholder={t("sessionInterchange.rootPlaceholder", {
											dir: format === "claude-code" ? "~/.claude" : "~/.codex",
										})}
										leftSection={<IconFolder size={14} />}
										value={rootInput}
										onChange={(event) => setRootInput(event.currentTarget.value)}
									/>
									<Button
										size="xs"
										variant="default"
										onClick={() => setAppliedRoot(rootInput.trim() || undefined)}
									>
										{t("sessionInterchange.scan")}
									</Button>
								</Group>
								{location ? (
									<CandidateList
										format={format}
										location={location}
										selectedPath={selected?.path ?? null}
										onSelect={setSelected}
										onRootResolved={handleRootResolved}
									/>
								) : null}
							</Stack>
						)}

						<Divider label={t("sessionInterchange.overrides")} labelPosition="left" />
						<TextInput
							label={t("sessionInterchange.titleLabel")}
							placeholder={selected?.title}
							value={title}
							onChange={(event) => {
								setTitle(event.currentTarget.value);
								setTitleTouched(event.currentTarget.value !== "");
							}}
						/>
						<TextInput
							label={t("sessionInterchange.cwdLabel")}
							description={t("sessionInterchange.cwdHint")}
							value={cwd}
							onChange={(event) => {
								setCwd(event.currentTarget.value);
								setCwdTouched(event.currentTarget.value !== "");
							}}
						/>
						<Select
							label={t("sessionInterchange.modelLabel")}
							description={t("sessionInterchange.modelHint")}
							data={groupedModels}
							searchable
							filter={modelOptionsFilter}
							limit={MODEL_SELECT_OPTION_LIMIT}
							value={model || FOLLOW_DEFAULT_MODEL}
							onChange={(value) => setModel(value ?? "")}
							comboboxProps={{ withinPortal: true, zIndex: 320 }}
						/>
						{progress !== null ? <Progress value={progress * 100} size="sm" animated /> : null}
						{importMutation.isError ? (
							<Text size="sm" c="red">
								{importMutation.error
									? describeApiError(importMutation.error, te, t("sessionInterchange.importFailed"))
											.message
									: t("sessionInterchange.importFailed")}
							</Text>
						) : null}
					</>
				)}

				<Group justify="flex-end">
					{result ? (
						<Button onClick={() => finish(result)}>{t("sessionInterchange.openNarrator")}</Button>
					) : (
						<>
							<Button variant="default" onClick={handleClose} disabled={importMutation.isPending}>
								{tc("cancel")}
							</Button>
							<Button
								onClick={() => importMutation.mutate()}
								loading={importMutation.isPending}
								disabled={!canImport}
							>
								{t("sessionInterchange.importAction")}
							</Button>
						</>
					)}
				</Group>
			</Stack>
		</Modal>
	);
}

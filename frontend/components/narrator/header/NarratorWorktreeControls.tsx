import { useCurrentUser } from "@frontend/hooks/useAuth";
import {
	useSwitchWorkspaceContext,
	useWorkspaceContext,
	workspaceContextKey,
} from "@frontend/hooks/useWorkspaceContext";
import { ApiError, api } from "@frontend/lib/api";
import { formatLocaleDateTime } from "@frontend/lib/intl-format";
import { narratorWSManager } from "@frontend/lib/narrator-ws-manager";
import {
	ActionIcon,
	Alert,
	Badge,
	Button,
	Collapse,
	Group,
	Loader,
	Modal,
	ScrollArea,
	Select,
	Stack,
	Text,
	Textarea,
	TextInput,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { IconGitFork, IconSwitchHorizontal, IconTrash } from "@tabler/icons-react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { nanoid } from "nanoid";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { DirectoryPicker } from "../../common/DirectoryPicker";
import { useEditorPanelVisible } from "../narrator-panel-visibility";
import { WorktreeRemovalDialog } from "./WorktreeRemovalDialog";
import { type WorktreeDraft, WorktreeFlow, type WorktreeFlowState } from "./worktree-flow";
import { type WorktreeSort, worktreeDirectoryLabel, worktreeLabel } from "./worktree-list-view";
import {
	releaseWorktreeListPages,
	retainWorktreeFirstPage,
	WORKTREE_LIST_GC_MS,
	WORKTREE_LIST_STALE_MS,
	worktreeListQueryKey,
} from "./worktree-query-cache";
import {
	draftFingerprint,
	RECEIPT_SCOPE_LIMIT,
	type ReceiptScope,
	WorktreeReceiptStore,
} from "./worktree-receipt-store";

const subscribeCredentials = (listener: () => void) =>
	narratorWSManager.onCredentialChange(listener);
const credentialIdentity = () => narratorWSManager.getCredentialIdentity();

const EMPTY_DRAFT: WorktreeDraft = {
	name: "",
	requirement: "",
	branchOverride: "",
	destinationPath: "",
	baseRef: "",
};

/** Kept in the Git strip: name OR requirement is sufficient. */
export function NarratorWorktreeControls({
	narratorId,
	onRequirement,
	canCreateWorktree,
}: {
	narratorId: string;
	onRequirement?: (text: string) => void;
	/** Existing authoritative Git probe, not the unopened list, owns create availability. */
	canCreateWorktree?: boolean;
}) {
	const { data: user } = useCurrentUser();
	const { data: context, transitioning } = useWorkspaceContext(narratorId);
	const owner = useRef<ReceiptScope | null>(null);
	if (user?.id && context?.git) {
		owner.current = {
			userId: user.id,
			narratorId,
			deviceId: context.deviceId,
			repositoryKey: context.git.repositoryKey,
		};
	} else if (
		!transitioning ||
		owner.current?.userId !== user?.id ||
		owner.current?.narratorId !== narratorId
	) {
		owner.current = null;
	}
	const scope = owner.current;
	if (!scope) return null;
	return (
		<ScopedWorktreeControls
			key={JSON.stringify(scope)}
			narratorId={narratorId}
			onRequirement={onRequirement}
			canCreateWorktree={canCreateWorktree}
			scope={scope}
		/>
	);
}

function ScopedWorktreeControls({
	narratorId,
	onRequirement,
	canCreateWorktree,
	scope,
}: {
	narratorId: string;
	onRequirement?: (text: string) => void;
	canCreateWorktree?: boolean;
	scope: ReceiptScope;
}) {
	const { t } = useTranslation("narrator");
	const visible = useEditorPanelVisible();
	const credential = useSyncExternalStore(
		subscribeCredentials,
		credentialIdentity,
		credentialIdentity,
	);
	const contextQuery = useWorkspaceContext(narratorId);
	const context = contextQuery.data;
	const switchMutation = useSwitchWorkspaceContext(narratorId);
	const [opened, setOpened] = useState(false);
	const [advanced, setAdvanced] = useState(false);
	const [draft, setDraft] = useState<WorktreeDraft>(EMPTY_DRAFT);
	const [state, setState] = useState<WorktreeFlowState>({ step: "idle", busy: false });
	const [switchError, setSwitchError] = useState<string>();
	const [storageError, setStorageError] = useState<string>();
	const alive = useRef(true);
	const store = useRef<WorktreeReceiptStore | null>(null);
	// Prompt text stays in scoped component memory only, separately frozen per attempt.
	const requirements = useRef(new Map<string, string>());
	const assertActive = () => {
		if (!alive.current) throw new Error("worktree.receiptStorage");
	};
	const pendingReceipts = useRef(new Map<string, { flow: WorktreeFlow; draft: WorktreeDraft }>());
	const [, refreshPending] = useState(0);
	const observedContext = useRef(context?.contextKey);
	const original = useRef<{ deviceId: string; cwd: string } | null>(null);
	if (!original.current && context)
		original.current = { deviceId: context.deviceId, cwd: context.cwd };
	const canSwitch = context?.capabilities.switchDirectory === true;
	const canInspect = pendingReceipts.current.size > 0 || state.unknown || !!state.createdPath;
	const canList = (canSwitch || canInspect) && context?.deviceId === "local" && !!context.git;
	const disabledReason = context?.capabilities.reason ?? t("worktree.unsupported");
	const current = useRef(context);
	current.current = context;
	const switcher = useRef(switchMutation.mutateAsync);
	switcher.current = switchMutation.mutateAsync;
	const switching = useRef(false);
	const switchTo = async (cwd: string, deviceId = current.current?.deviceId) => {
		assertActive();
		if (switching.current) throw new Error(t("worktree.busy"));
		if (!current.current?.capabilities.switchDirectory || !deviceId)
			throw new Error(t("worktree.unsupported"));
		switching.current = true;
		setSwitchError(undefined);
		try {
			await switcher.current({
				expectedRevision: current.current.revision,
				requestId: nanoid(),
				target: { deviceId, cwd },
			});
		} catch (error) {
			const message =
				error instanceof ApiError && error.status === 409
					? `${t("worktree.busy")} ${error.message}`
					: error instanceof Error
						? error.message
						: String(error);
			setSwitchError(message);
			throw new Error(message);
		} finally {
			switching.current = false;
		}
	};
	const flowRef = useRef<WorktreeFlow | null>(null);
	const makeFlow = () => {
		const instance: WorktreeFlow = new WorktreeFlow(
			{
				prepare: (input) => api.prepareNarratorWorktree(narratorId, input),
				create: async (input) => {
					assertActive();
					try {
						return await api.createNarratorWorktree(narratorId, input);
					} finally {
						// Even an unknown receipt can have created a checkout. Mark display caches
						// stale without starting a hidden list read or replaying old cursor chains.
						void queryClient.invalidateQueries({
							queryKey: ["narratorWorktrees"],
							refetchType: "none",
						});
					}
				},
				persist: async (request, snapshot) => {
					const fingerprint = await draftFingerprint(snapshot);
					assertActive();
					if (!store.current) throw new Error("worktree.receiptStorage");
					store.current.put(scope, request, fingerprint);
					requirements.current.set(request.requestId, snapshot.requirement.trim());
				},
				complete: (id) => {
					assertActive();
					store.current?.remove(scope, id);
				},
				reconcile: async (input) => {
					const result = await api.reconcileNarratorWorktree(narratorId, input);
					if (result.outcome === "created")
						void queryClient.invalidateQueries({
							queryKey: ["narratorWorktrees"],
							refetchType: "none",
						});
					return result;
				},
				switch: (path) => switchTo(path, "local"),
				requestId: () => nanoid(),
			},
			(next) => {
				if (!alive.current) return;
				if (next.createRequest && (next.confirmedFailure || next.step === "done"))
					pendingReceipts.current.delete(next.createRequest.requestId);
				if (next.createRequest && next.confirmedFailure)
					requirements.current.delete(next.createRequest.requestId);
				if (flowRef.current === instance) setState(next);
				else refreshPending((value) => value + 1);
			},
		);
		return instance;
	};
	if (!flowRef.current) flowRef.current = makeFlow();
	const flow = flowRef.current;
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed owner scope is immutable; hydrate only on mount
	useEffect(() => {
		alive.current = true;
		try {
			store.current = new WorktreeReceiptStore(window.localStorage);
			for (const receipt of store.current.list(scope)) {
				const restored = makeFlow();
				restored.restore(receipt.request);
				pendingReceipts.current.set(receipt.request.requestId, {
					flow: restored,
					draft: { ...EMPTY_DRAFT },
				});
			}
			const first = pendingReceipts.current.values().next().value;
			if (first) {
				flowRef.current = first.flow;
				setState(first.flow.state);
			}
			refreshPending((value) => value + 1);
		} catch {
			setStorageError("worktree.receiptStorage");
		}
		return () => {
			alive.current = false;
		};
		// Scoped component remounts for user/narrator/device/repository changes.
	}, []);
	useEffect(() => {
		if (state.step !== "done" || !state.createRequest) return;
		const id = state.createRequest.requestId;
		const requirement = requirements.current.get(id);
		requirements.current.delete(id);
		if (requirement) onRequirement?.(requirement);
		setOpened(false);
	}, [state.step, state.createRequest, onRequirement]);
	// A manual context switch must not strand the current form on another workspace.
	// Preserve the frozen old attempt for read-only recovery; the new context gets a blank form.
	useEffect(() => {
		if (!context || observedContext.current === context.contextKey || state.busy) return;
		observedContext.current = context.contextKey;
		if (!state.createRequest || (!state.unknown && (!state.createdPath || state.step === "done")))
			return;
		pendingReceipts.current.set(state.createRequest.requestId, { flow, draft: { ...draft } });
		flowRef.current = null;

		setState({ step: "idle", busy: false });
		setDraft(EMPTY_DRAFT);
		setOpened(false);
	}, [
		context,
		draft,
		flow,
		state.busy,
		state.createRequest,
		state.createdPath,
		state.step,
		state.unknown,
	]);
	const resumeReceipt = (attempt: { flow: WorktreeFlow; draft: WorktreeDraft }) => {
		if (flowRef.current?.state.busy) return;
		const active = flowRef.current;
		if (
			active &&
			active !== attempt.flow &&
			active.state.createRequest &&
			(active.state.unknown || (active.state.createdPath && active.state.step !== "done"))
		)
			pendingReceipts.current.set(active.state.createRequest.requestId, {
				flow: active,
				draft: { ...draft },
			});
		observedContext.current = current.current?.contextKey;
		flowRef.current = attempt.flow;

		setDraft(attempt.draft);
		setState(attempt.flow.state);
		setOpened(true);
		if (attempt.flow.state.unknown) void attempt.flow.reconcile();
	};
	const [menuOpened, setMenuOpened] = useState(false);
	// Removal is a second modal on top of the list: the row stays where the user found it.
	const [removalPath, setRemovalPath] = useState<string | null>(null);
	// The list modal stays open behind the confirmation, so the outcome belongs there.
	const [removalNotice, setRemovalNotice] = useState<string>();
	const [search, setSearch] = useState("");
	const [sort, setSort] = useState<WorktreeSort>("lastCommitAt");
	const [descending, setDescending] = useState(true);
	const [debouncedSearch, setDebouncedSearch] = useState("");
	useEffect(() => {
		const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
		return () => clearTimeout(timer);
	}, [search]);
	const queryClient = useQueryClient();
	const listQuery = useMemo(
		() =>
			({
				limit: 20,
				search: debouncedSearch,
				sort,
				order: descending ? "desc" : "asc",
			}) as const,
		[debouncedSearch, sort, descending],
	);
	const { userId: ownerUserId, deviceId: ownerDeviceId, repositoryKey: ownerRepositoryKey } = scope;
	const listKey = useMemo(
		() =>
			worktreeListQueryKey(
				{
					userId: ownerUserId,
					narratorId,
					deviceId: ownerDeviceId,
					repositoryKey: ownerRepositoryKey,
				},
				context?.git?.workspaceKey,
				listQuery,
				credential,
			),
		[
			ownerUserId,
			narratorId,
			ownerDeviceId,
			ownerRepositoryKey,
			context?.git?.workspaceKey,
			listQuery,
			credential,
		],
	);
	const listActive = canList && menuOpened && visible && search.trim() === debouncedSearch;
	const worktrees = useInfiniteQuery({
		queryKey: listKey,
		initialPageParam: undefined as string | undefined,
		queryFn: ({ signal, pageParam }) =>
			api.listNarratorWorktrees(narratorId, context?.git?.workspaceKey ?? "", signal, {
				...listQuery,
				cursor: pageParam,
			}),
		getNextPageParam: (page) => (page.hasMore ? (page.nextCursor ?? undefined) : undefined),
		enabled: listActive,
		gcTime: WORKTREE_LIST_GC_MS,
		retry: false,
		staleTime: WORKTREE_LIST_STALE_MS,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
	});
	useEffect(() => {
		if (!listActive) void releaseWorktreeListPages(queryClient, listKey);
	}, [listActive, listKey, queryClient]);
	useEffect(
		() => () => {
			void releaseWorktreeListPages(queryClient, listKey);
		},
		[listKey, queryClient],
	);
	const firstPage = worktrees.data?.pages[0];
	const visibleEntries = [
		...new Map(
			(worktrees.data?.pages.flatMap((page) => page.entries) ?? []).map((entry) => [
				entry.path,
				entry,
			]),
		).values(),
	];
	const cursorExpired =
		worktrees.error instanceof ApiError && worktrees.error.data?.code === "WORKTREE_CURSOR_EXPIRED";
	useEffect(() => {
		if (listActive && cursorExpired) {
			// A visible cursor failure needs a new snapshot; closed lists never recover in the background.
			void queryClient.resetQueries({ queryKey: listKey, exact: true });
		}
	}, [listActive, cursorExpired, queryClient, listKey]);
	const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
	const sentinel = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const target = sentinel.current;
		if (
			!listActive ||
			!viewport ||
			!target ||
			!worktrees.data ||
			!worktrees.hasNextPage ||
			worktrees.isFetching ||
			worktrees.isFetchNextPageError ||
			search.trim() !== debouncedSearch
		)
			return;
		let disposed = false;
		let requesting = false;
		const load = () => {
			if (disposed || requesting) return;
			requesting = true;
			// Query-level cancelRefetch:false also coalesces manual and observer requests.
			void worktrees.fetchNextPage({ cancelRefetch: false }).finally(() => {
				requesting = false;
			});
		};
		const check = () => {
			const root = viewport.getBoundingClientRect();
			const item = target.getBoundingClientRect();
			if (root.height > 0 && item.top <= root.bottom + 80 && item.bottom >= root.top) load();
		};
		const observer =
			typeof IntersectionObserver === "undefined"
				? undefined
				: new IntersectionObserver(
						(entries) => {
							if (entries.some((entry) => entry.isIntersecting)) load();
						},
						{ root: viewport, rootMargin: "80px" },
					);
		observer?.observe(target);
		const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(check);
		resize?.observe(viewport);
		viewport.addEventListener("scroll", check);
		check(); // Also drain pages when the initial list does not fill the viewport.
		return () => {
			disposed = true;
			observer?.disconnect();
			resize?.disconnect();
			viewport.removeEventListener("scroll", check);
		};
	}, [
		listActive,
		viewport,
		worktrees.hasNextPage,
		worktrees.isFetching,
		worktrees.isFetchNextPageError,
		worktrees.fetchNextPage,
		worktrees.data,
		search,
		debouncedSearch,
	]);
	const openList = async (fresh = false) => {
		const workspaceKey = context?.git?.workspaceKey;
		const key = worktreeListQueryKey(scope, workspaceKey, { ...listQuery, search: "" }, credential);
		await releaseWorktreeListPages(queryClient, key);
		const savedError = queryClient.getQueryState(key)?.error;
		if (savedError instanceof ApiError && savedError.data?.code === "WORKTREE_CURSOR_EXPIRED")
			await queryClient.resetQueries({ queryKey: key, exact: true });
		if (
			!alive.current ||
			current.current?.git?.workspaceKey !== workspaceKey ||
			credentialIdentity() !== credential
		)
			return;
		if (fresh)
			void queryClient.invalidateQueries({ queryKey: key, exact: true, refetchType: "none" });
		setSearch("");
		setDebouncedSearch("");
		setRemovalNotice(undefined);
		setMenuOpened(true);
	};
	const formatTime = (timestamp: number | null | undefined) =>
		timestamp == null || !Number.isFinite(timestamp)
			? t("worktree.unknownTime")
			: formatLocaleDateTime(timestamp);
	const pendingLimit = pendingReceipts.current.size >= RECEIPT_SCOPE_LIMIT;
	const canCreate =
		canSwitch &&
		canList &&
		(canCreateWorktree ?? firstPage?.capabilities.create) === true &&
		!pendingLimit &&
		!storageError;
	// Deleting needs the server-advertised capability, not just a clickable list.
	const canRemove = canList && firstPage?.capabilities.delete === true;
	const createDisabledReason = storageError
		? t(storageError)
		: pendingLimit
			? t("worktree.pendingLimit")
			: (firstPage?.capabilities.reason ?? worktrees.error?.message ?? disabledReason);
	const startForm = () => {
		// Keep a successful receipt and failed-switch retry even when the dialog is reopened.
		if (state.step === "done") {
			flowRef.current = null;

			setState({ step: "idle", busy: false });
			setDraft(EMPTY_DRAFT);
		}
		setOpened(true);
	};
	return (
		<>
			<Group
				gap={3}
				wrap="nowrap"
				onClick={(event) => event.stopPropagation()}
				onKeyDown={(event) => event.stopPropagation()}
			>
				<Tooltip label={canCreate ? t("worktree.quickCreate") : createDisabledReason}>
					<ActionIcon
						size="sm"
						variant="subtle"
						aria-label={t("worktree.quickCreate")}
						disabled={!canCreate || switchMutation.isPending}
						onClick={startForm}
					>
						<IconGitFork size={15} />
					</ActionIcon>
				</Tooltip>
				<Tooltip label={canSwitch ? t("worktree.switch") : disabledReason}>
					<ActionIcon
						size="sm"
						variant="subtle"
						aria-label={t("worktree.switch")}
						disabled={(!canSwitch && !canInspect) || switchMutation.isPending || state.busy}
						onClick={() => void openList()}
					>
						<IconSwitchHorizontal size={15} />
					</ActionIcon>
				</Tooltip>
				<Modal
					opened={menuOpened}
					onClose={() => setMenuOpened(false)}
					title={t("worktree.switch")}
					size="lg"
				>
					<Stack gap="sm">
						<Text size="xs" c="dimmed" truncate title={`${context?.deviceId}: ${context?.cwd}`}>
							{worktreeDirectoryLabel(context?.cwd ?? "")}
						</Text>
						<TextInput
							label={t("worktree.search")}
							placeholder={t("worktree.searchPlaceholder")}
							value={search}
							onChange={(event) => setSearch(event.currentTarget.value)}
							data-autofocus
						/>
						<Group align="end" wrap="nowrap">
							<Select
								label={t("worktree.sort")}
								value={sort}
								allowDeselect={false}
								style={{ flex: 1 }}
								data={[
									{ value: "lastCommitAt", label: t("worktree.lastCommit") },
									{ value: "createdAt", label: t("worktree.createdTime") },
									{ value: "name", label: t("worktree.nameSort") },
								]}
								onChange={(value) => {
									if (value === "lastCommitAt" || value === "createdAt" || value === "name") {
										setSort(value);
										setDescending(value !== "name");
									}
								}}
							/>
							<Button variant="light" onClick={() => setDescending((value) => !value)}>
								{t(descending ? "worktree.descending" : "worktree.ascending")}
							</Button>
						</Group>
						{sort === "createdAt" && (
							<Text size="xs" c="dimmed">
								{t("worktree.createdTimeHint")}
							</Text>
						)}
						{storageError && <Alert color="red">{t(storageError)}</Alert>}
						{canCreate && (state.unknown || state.createdPath) && (
							<Button
								variant="subtle"
								disabled={state.busy}
								onClick={() => {
									if (state.createRequest)
										pendingReceipts.current.set(state.createRequest.requestId, {
											flow,
											draft: { ...EMPTY_DRAFT },
										});
									flowRef.current = null;
									setState({ step: "idle", busy: false });
									setDraft(EMPTY_DRAFT);
									setMenuOpened(false);
									setOpened(true);
								}}
							>
								{t("worktree.independentTask")}
							</Button>
						)}
						{state.unknown && state.createRequest && (
							<Button
								variant="subtle"
								onClick={() => {
									setMenuOpened(false);
									setOpened(true);
								}}
							>
								{t("worktree.verify")}
							</Button>
						)}
						{[...pendingReceipts.current.values()]
							.filter((attempt) => attempt.flow !== flow)
							.map((attempt) => (
								<Button
									key={attempt.flow.state.createRequest?.requestId}
									variant="subtle"
									disabled={state.busy}
									onClick={() => {
										setMenuOpened(false);
										resumeReceipt(attempt);
									}}
								>
									{t(
										attempt.flow.state.unknown
											? "worktree.pendingAttempt"
											: "worktree.resumeSwitch",
									)}
									: {attempt.flow.state.createRequest?.destinationPath}
								</Button>
							))}
						{original.current && original.current.cwd !== context?.cwd && (
							<Button
								variant="subtle"
								disabled={!canSwitch || state.busy}
								onClick={() => {
									const target = original.current;
									if (target)
										void switchTo(target.cwd, target.deviceId)
											.then(() => setMenuOpened(false))
											.catch(() => {});
								}}
								title={original.current.cwd}
							>
								{t("worktree.returnOriginal")}: {worktreeDirectoryLabel(original.current.cwd)}
							</Button>
						)}
						{worktrees.isPending && canList && <Loader size="xs" />}
						{worktrees.error && !worktrees.isFetchNextPageError && (
							<Button variant="subtle" onClick={() => void worktrees.refetch()}>
								{t("worktree.retry")}: {worktrees.error.message}
							</Button>
						)}
						<ScrollArea.Autosize mah="45vh" type="auto" viewportRef={setViewport}>
							<Stack gap={4}>
								{visibleEntries.map((entry) => (
									<Group key={entry.path} gap={4} wrap="nowrap" align="stretch">
										<UnstyledButton
											data-worktree-path={entry.path}
											py="xs"
											px={6}
											style={{ flex: 1, minWidth: 0, borderRadius: 4 }}
											bg={
												entry.path === context?.cwd
													? "var(--mantine-color-default-hover)"
													: undefined
											}
											title={`${context?.deviceId}: ${entry.path}`}
											disabled={
												!canSwitch ||
												state.busy ||
												switchMutation.isPending ||
												entry.path === context?.cwd ||
												entry.locked ||
												entry.prunable
											}
											onClick={() =>
												void switchTo(entry.path)
													.then(() => setMenuOpened(false))
													.catch(() => {})
											}
										>
											<Group gap="xs" wrap="nowrap">
												<Text size="sm" truncate>
													{entry.branch
														? worktreeLabel(entry)
														: `${t("worktree.detached")} · ${worktreeLabel(entry)}`}
												</Text>
												{entry.path === context?.cwd && (
													<Badge size="xs">{t("worktree.current")}</Badge>
												)}
												{entry.locked && (
													<Badge size="xs" color="yellow">
														{t("worktree.locked")}
													</Badge>
												)}
												{entry.prunable && (
													<Badge size="xs" color="red">
														{t("worktree.unavailable")}
													</Badge>
												)}
											</Group>
											<Text size="xs" c="dimmed" truncate>
												{context?.deviceId !== "local" && `${context?.deviceId}: `}
												{worktreeDirectoryLabel(entry.path)}
											</Text>
											{sort !== "name" && (
												<Text size="xs" c="dimmed">
													{t(sort === "createdAt" ? "worktree.createdTime" : "worktree.lastCommit")}
													: {formatTime(entry[sort])}
												</Text>
											)}
										</UnstyledButton>
										{canRemove && (
											<Tooltip
												label={entry.locked ? t("worktree.removeLocked") : t("worktree.remove")}
												withArrow
											>
												<ActionIcon
													size="lg"
													variant="subtle"
													color="red"
													aria-label={t("worktree.remove")}
													data-worktree-remove={entry.path}
													// A prunable checkout is exactly what removal is for: its
													// directory is gone and only the registration is left.
													disabled={entry.locked || state.busy}
													onClick={() => setRemovalPath(entry.path)}
												>
													<IconTrash size={15} />
												</ActionIcon>
											</Tooltip>
										)}
									</Group>
								))}
								<div ref={sentinel} data-worktree-sentinel style={{ minHeight: 1 }} />
								{worktrees.isFetchingNextPage && <Loader size="xs" />}
								{worktrees.isFetchNextPageError && !cursorExpired && (
									<Button
										variant="subtle"
										disabled={worktrees.isFetching}
										onClick={() => void worktrees.fetchNextPage({ cancelRefetch: false })}
									>
										{t("worktree.retryMore")}: {worktrees.error?.message}
									</Button>
								)}
								{worktrees.hasNextPage && !worktrees.isFetchNextPageError && (
									<Button
										variant="subtle"
										disabled={worktrees.isFetching}
										onClick={() => void worktrees.fetchNextPage({ cancelRefetch: false })}
									>
										{t("worktree.loadMore")}
									</Button>
								)}
								{!worktrees.isPending && !worktrees.error && visibleEntries.length === 0 && (
									<Text size="sm" c="dimmed">
										{t(search.trim() ? "worktree.noMatches" : "worktree.emptyList")}
									</Text>
								)}
							</Stack>
						</ScrollArea.Autosize>
						{firstPage?.truncated && <Alert color="yellow">{t("worktree.listTruncated")}</Alert>}
						{/* Removal needs a healthy checkout of the requesting session. A session whose
						    own directory was deleted sees its own prunable row here and nothing it
						    can do about it, so name the way out instead of showing a dead list. */}
						{canList && !canRemove && visibleEntries.some((entry) => entry.prunable) && (
							<Alert color="yellow">{t("worktree.removeNeedsHealthyWorkspace")}</Alert>
						)}
						{switchError && <Alert color="red">{switchError}</Alert>}
						{removalNotice && <Alert color="green">{removalNotice}</Alert>}
					</Stack>
				</Modal>
			</Group>
			<Modal
				opened={opened}
				onClose={() => !state.busy && setOpened(false)}
				title={t("worktree.quickCreate")}
				closeOnClickOutside={!state.busy}
				closeOnEscape={!state.busy}
			>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						if (context) void flow.submit(draft, context);
					}}
				>
					<Stack gap="sm">
						<Text size="xs" c="dimmed">
							{context?.deviceId}: {context?.cwd}
						</Text>
						{state.createRequest && (
							<Text size="xs" c="dimmed">
								local: {state.createRequest.destinationPath} · {state.createRequest.branch.name}
							</Text>
						)}
						{pendingReceipts.current.size > 0 && !state.createRequest && (
							<Alert color="yellow">{t("worktree.pendingNotice")}</Alert>
						)}
						<Text size="sm">{t("worktree.either")}</Text>
						<TextInput
							label={t("worktree.name")}
							value={draft.name}
							maxLength={256}
							disabled={state.busy || !!state.createdPath || state.unknown}
							onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
						/>
						<Textarea
							label={t("worktree.requirement")}
							value={draft.requirement}
							maxLength={2000}
							disabled={state.busy || !!state.createdPath || state.unknown}
							onChange={(event) => setDraft({ ...draft, requirement: event.currentTarget.value })}
							autosize
							minRows={2}
						/>
						<Button variant="subtle" size="xs" onClick={() => setAdvanced(!advanced)}>
							{t("worktree.advanced")}
						</Button>
						<Collapse expanded={advanced}>
							<Stack gap="sm">
								<TextInput
									label={t("worktree.branchOverride")}
									maxLength={256}
									value={draft.branchOverride}
									disabled={state.busy || !!state.createdPath || state.unknown}
									onChange={(event) =>
										setDraft({ ...draft, branchOverride: event.currentTarget.value })
									}
								/>
								<DirectoryPicker
									mode="newTarget"
									newTargetError={t("worktree.targetUnavailable")}
									label={t("worktree.destination")}
									description={t("worktree.defaultDestination")}
									value={draft.destinationPath}
									disabled={state.busy || !!state.createdPath || state.unknown}
									onChange={(destinationPath) => setDraft({ ...draft, destinationPath })}
								/>
								<TextInput
									label={t("worktree.baseRef")}
									maxLength={256}
									placeholder="HEAD"
									value={draft.baseRef}
									disabled={state.busy || !!state.createdPath || state.unknown}
									onChange={(event) => setDraft({ ...draft, baseRef: event.currentTarget.value })}
								/>
							</Stack>
						</Collapse>
						<Text size="xs" c="dimmed">
							{t("worktree.uncommittedStay")}
						</Text>
						{state.busy && (
							<Group gap="xs" role="status">
								<Loader size="xs" />
								<Text size="sm">{t(`worktree.step_${state.step}`)}</Text>
							</Group>
						)}
						{state.createdPath && state.error && state.step !== "done" && (
							<Alert color="blue">
								{t("worktree.createdSwitchFailed")}
								<Text size="xs">
									{context?.deviceId}: {state.createdPath}
								</Text>
							</Alert>
						)}
						{state.error && (
							<Alert color="red">
								{state.error === "empty"
									? t("worktree.empty")
									: state.error.startsWith("worktree.")
										? t(state.error)
										: state.errorCode
											? // A refusal the catalogue knows (say, a partial clone this git cannot
												// keep from fetching) in the user's language; else the server's sentence.
												t(state.errorCode, { ns: "errors", defaultValue: state.error })
											: state.error}
							</Alert>
						)}
						{state.unknown && <Alert color="yellow">{t("worktree.unknown")}</Alert>}
						{canInspect && (
							<Button
								variant="default"
								onClick={() => {
									setOpened(false);
									void openList(true);
								}}
							>
								{t("worktree.inspectExisting")}
							</Button>
						)}
						{state.residuals &&
							(state.residuals.branchExists || state.residuals.destinationExists) && (
								<Alert color="yellow">{t("worktree.residuals", state.residuals)}</Alert>
							)}
						{state.unknown && (
							<Button variant="light" disabled={state.busy} onClick={() => void flow.reconcile()}>
								{t("worktree.verify")}
							</Button>
						)}
						{state.createdPath && !state.error && !state.busy && state.step !== "done" && (
							<Alert color="blue">{t("worktree.verifiedCreated")}</Alert>
						)}
						{state.createdPath ? (
							<Button disabled={state.busy || !canSwitch} onClick={() => void flow.switchCreated()}>
								{t(state.error ? "worktree.retrySwitch" : "worktree.continueSwitch")}
							</Button>
						) : (
							<Button type="submit" loading={state.busy} disabled={!canCreate || state.unknown}>
								{state.error ? t("worktree.retry") : t("worktree.createSwitch")}
							</Button>
						)}
					</Stack>
				</form>
			</Modal>
			<WorktreeRemovalDialog
				opened={removalPath !== null}
				narratorId={narratorId}
				worktreePath={removalPath}
				workspaceKey={context?.git?.workspaceKey ?? ""}
				onClose={() => setRemovalPath(null)}
				onRemoved={(result) => {
					setRemovalPath(null);
					retainWorktreeFirstPage(queryClient, listKey);
					void queryClient.invalidateQueries({ queryKey: ["narratorWorktrees"] });
					// The requesting session may itself have been moved out of the checkout.
					void queryClient.invalidateQueries({ queryKey: workspaceContextKey(narratorId) });
					setRemovalNotice(
						result.outcome === "removed"
							? result.relocatedTo
								? t("worktree.removeSuccessRelocated", { path: result.relocatedTo })
								: t("worktree.removeSuccess")
							: t("worktree.removeAlreadyAbsent"),
					);
				}}
			/>
		</>
	);
}

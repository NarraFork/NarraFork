import { useCurrentUser } from "@frontend/hooks/useAuth";
import {
	useSwitchWorkspaceContext,
	useWorkspaceContext,
} from "@frontend/hooks/useWorkspaceContext";
import { ApiError, api } from "@frontend/lib/api";
import { formatLocaleDateTime } from "@frontend/lib/intl-format";
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
} from "@mantine/core";
import { IconGitFork, IconSwitchHorizontal } from "@tabler/icons-react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { nanoid } from "nanoid";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DirectoryPicker } from "../../common/DirectoryPicker";
import { type WorktreeDraft, WorktreeFlow, type WorktreeFlowState } from "./worktree-flow";
import { type WorktreeSort, worktreeDirectoryLabel, worktreeLabel } from "./worktree-list-view";
import {
	draftFingerprint,
	RECEIPT_SCOPE_LIMIT,
	type ReceiptScope,
	WorktreeReceiptStore,
} from "./worktree-receipt-store";

const EMPTY_DRAFT: WorktreeDraft = {
	name: "",
	requirement: "",
	branchOverride: "",
	destinationPath: "",
	baseRef: "",
};

/** Kept in the Git strip, not chapter creation: name OR requirement is sufficient. */
export function NarratorWorktreeControls({
	narratorId,
	onRequirement,
}: {
	narratorId: string;
	onRequirement?: (text: string) => void;
}) {
	const { data: user } = useCurrentUser();
	const { data: context } = useWorkspaceContext(narratorId);
	if (!user?.id || !context?.git) return null;
	const scope: ReceiptScope = {
		userId: user.id,
		narratorId,
		deviceId: context.deviceId,
		repositoryKey: context.git.repositoryKey,
	};
	return (
		<ScopedWorktreeControls
			key={JSON.stringify(scope)}
			narratorId={narratorId}
			onRequirement={onRequirement}
			scope={scope}
		/>
	);
}

function ScopedWorktreeControls({
	narratorId,
	onRequirement,
	scope,
}: {
	narratorId: string;
	onRequirement?: (text: string) => void;
	scope: ReceiptScope;
}) {
	const { t } = useTranslation("narrator");
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
				create: (input) => {
					assertActive();
					return api.createNarratorWorktree(narratorId, input);
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
				reconcile: (input) => api.reconcileNarratorWorktree(narratorId, input),
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
	// Revisiting old conditions must not restore/refetch their entire cached cursor chain.
	const listScope = useMemo(
		() => ({
			narratorId,
			workspaceKey: context?.git?.workspaceKey,
			query: listQuery,
			generation: nanoid(),
		}),
		[narratorId, context?.git?.workspaceKey, listQuery],
	);
	const listKey = useMemo(
		() => [
			"narratorWorktrees",
			listScope.narratorId,
			listScope.workspaceKey,
			listScope.query,
			listScope.generation,
		],
		[listScope],
	);
	const worktrees = useInfiniteQuery({
		queryKey: listKey,
		initialPageParam: undefined as string | undefined,
		queryFn: ({ signal, pageParam }) =>
			api.listNarratorWorktrees(narratorId, context?.git?.workspaceKey ?? "", signal, {
				...listQuery,
				cursor: pageParam,
			}),
		getNextPageParam: (page) => (page.hasMore ? (page.nextCursor ?? undefined) : undefined),
		enabled: canList,
		gcTime: 0, // Inactive generations have no reuse value; release their accumulated pages.
		retry: false,
		staleTime: 5_000,
		refetchOnWindowFocus: false,
	});
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
		if (cursorExpired) {
			// Reset the entire chain: refetching old pageParams would reuse expired cursors.
			void queryClient.resetQueries({ queryKey: listKey, exact: true });
		}
	}, [cursorExpired, queryClient, listKey]);
	const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
	const sentinel = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const target = sentinel.current;
		if (
			!menuOpened ||
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
		menuOpened,
		viewport,
		worktrees.hasNextPage,
		worktrees.isFetching,
		worktrees.isFetchNextPageError,
		worktrees.fetchNextPage,
		worktrees.data,
		search,
		debouncedSearch,
	]);
	const formatTime = (timestamp: number | null | undefined) =>
		timestamp == null || !Number.isFinite(timestamp)
			? t("worktree.unknownTime")
			: formatLocaleDateTime(timestamp);
	const pendingLimit = pendingReceipts.current.size >= RECEIPT_SCOPE_LIMIT;
	const canCreate =
		canSwitch &&
		canList &&
		firstPage?.capabilities.create === true &&
		!pendingLimit &&
		!storageError;
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
						onClick={() => {
							setSearch("");
							setMenuOpened(true);
							// Reopening refreshes from page one, never replaying all saved cursors.
							if (canList && debouncedSearch === "" && !worktrees.isFetching && !cursorExpired)
								void queryClient.resetQueries({ queryKey: listKey, exact: true });
						}}
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
									<Button
										key={entry.path}
										data-worktree-path={entry.path}
										variant={entry.path === context?.cwd ? "light" : "subtle"}
										fullWidth
										justify="flex-start"
										h="auto"
										py="xs"
										styles={{ label: { display: "block", width: "100%", textAlign: "left" } }}
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
												{t(sort === "createdAt" ? "worktree.createdTime" : "worktree.lastCommit")}:{" "}
												{formatTime(entry[sort])}
											</Text>
										)}
									</Button>
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
						{switchError && <Alert color="red">{switchError}</Alert>}
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
										: state.error}
							</Alert>
						)}
						{state.unknown && <Alert color="yellow">{t("worktree.unknown")}</Alert>}
						{canInspect && (
							<Button
								variant="default"
								onClick={() => {
									setOpened(false);
									setMenuOpened(true);
									void worktrees.refetch();
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
		</>
	);
}

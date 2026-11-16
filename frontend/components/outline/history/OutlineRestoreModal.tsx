/**
 * Restore a block's subtree (or the whole space) to an earlier point (pageless outline, F2, on
 * H3's routes), as owner rule D58 says: only what was under it then is touched, and the WHOLE
 * change list is shown before anything is written.
 *
 *   preview ──(whole list read)── Restore ──▶ running (call after call, Stop) ──▶ done (result)
 *      ▲   │ Move back (a moved-away block): the list is worked out again
 *      └───┴── a conflict or a stale preview: Preview again (what was written stays said)
 *
 * The list is grouped by what happens (deleted, brought back, moved back out with what goes
 * along, put back, left as it is with why, moved away with its own "Move back"). Restore is
 * offered only once every page of the list has been read ("Show the whole list" reads them,
 * one bounded server read each, stoppable) and no move-back is in flight. Restoring the whole
 * space asks once more, with the counts. Everything it says comes from the server's preview;
 * nothing here decides what a restore does.
 *
 * The host keeps this dialog mounted with the target captured when it opened
 * ({@link OutlineRestoreTarget}): moving through history or the address bar meanwhile does not
 * change what it restores, and a running restore keeps going and shows its result. Leaving the
 * page while it runs asks first (`lib/page-leave.ts`).
 */
import {
	Alert,
	Anchor,
	Box,
	Button,
	Group,
	Loader,
	Modal,
	Progress,
	Stack,
	Text,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { blockTitle } from "@shared/outline";
import type { OutlineRestoreEntry, OutlineRestoreSkip } from "@shared/outline-restore-api";
import { IconCheck } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { invalidateOutlineSpace } from "../../../hooks/useOutline";
import { api } from "../../../lib/api";
import { holdPageLeave } from "../../../lib/page-leave";
import { MOBILE_VIEWPORT_MEDIA_QUERY } from "../../../lib/responsive";
import classes from "../Outline.module.css";
import { entryLine, OutlineDiffMark, problemText } from "./HistoryParts";
import {
	canRetry,
	groupPreview,
	type MoveBackState,
	needsNewPreview,
	type PreviewGroup,
	type RestoreIO,
	RestoreRun,
	type RestoreState,
	SKIP_REASONS,
} from "./history-model";

/** The app's requests of a restore of one space. */
export function restoreIO(spaceId: string): RestoreIO {
	return {
		preview: (body) => api.previewOutlineRestore(spaceId, body),
		restore: (body) => api.restoreOutlineSubtree(spaceId, body),
		moveBack: (blockId, thenSeq) => api.moveOutlineBlockBack(spaceId, blockId, thenSeq),
	};
}

/** What a restore dialog restores, captured when it opens. */
export interface OutlineRestoreTarget {
	spaceId: string;
	/** The block whose subtree is restored; null: the whole space. */
	rootId: string | null;
	thenSeq: number;
}

export function OutlineRestoreModal({
	target,
	onClose,
	onFinished,
	io,
}: {
	/** Open on this target; null: closed. */
	target: OutlineRestoreTarget | null;
	onClose: () => void;
	/** The restore is done and the reader closed its result (the host goes back to now). */
	onFinished?: () => void;
	/** Requests (tests); the app's API when absent. */
	io?: RestoreIO;
}) {
	const { t } = useTranslation("outline");
	const mobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const queryClient = useQueryClient();
	// One run per opening. Made in the effect (not during render), so that a mount run twice
	// (React's strict mode) disposes the first run and previews with a live second one.
	const [run, setRun] = useState<RestoreRun | null>(null);
	useEffect(() => {
		if (!target) {
			setRun(null);
			return;
		}
		const made = new RestoreRun(io ?? restoreIO(target.spaceId), target.rootId, target.thenSeq);
		setRun(made);
		void made.preview();
		return () => made.dispose();
	}, [target, io]);
	const state = useSyncExternalStore(
		run?.subscribe ?? noSubscribe,
		run?.getState ?? noState,
		run?.getState ?? noState,
	);
	// What it wrote is shown everywhere: the current views, timelines and comparisons are stale.
	const spaceId = target?.spaceId ?? null;
	const wrote = state ? state.progress.commits.length + state.earlier.commits : 0;
	const moved = state ? Object.values(state.moveBack).filter((m) => m.state === "moved").length : 0;
	useEffect(() => {
		if (!spaceId || (wrote === 0 && moved === 0)) return;
		invalidateOutlineSpace(queryClient, spaceId);
		queryClient.removeQueries({ queryKey: ["outline", "diff", spaceId] });
	}, [wrote, moved, queryClient, spaceId]);
	const running = state?.phase === "running";
	// Leaving the page while it runs asks first (what was written stays; the rest would not be).
	useEffect(() => (running ? holdPageLeave() : undefined), [running]);
	const close = () => {
		if (running) return;
		const finished = state?.phase === "done";
		onClose();
		if (finished) onFinished?.();
	};
	const whole = target?.rootId === null;
	const seq = target?.thenSeq ?? 0;
	return (
		<Modal
			opened={target !== null}
			onClose={close}
			title={t(whole ? "restore.titleSpace" : "restore.title", { seq })}
			size="lg"
			fullScreen={mobile}
			closeOnClickOutside={!running}
			closeOnEscape={!running}
			withCloseButton={!running}
			data-testid="outline-restore"
		>
			{run && state && target && (
				<RestoreBody run={run} state={state} target={target} onClose={close} />
			)}
		</Modal>
	);
}

const noSubscribe = () => () => {};
const noState = () => null;

function RestoreBody({
	run,
	state,
	target,
	onClose,
}: {
	run: RestoreRun;
	state: RestoreState;
	target: OutlineRestoreTarget;
	onClose: () => void;
}) {
	const { t } = useTranslation("outline");
	const { phase, progress, problem, earlier } = state;
	const thenSeq = target.thenSeq;
	const whole = target.rootId === null;
	const groups = useMemo(() => groupPreview(state.entries), [state.entries]);
	const movedAway = useMemo(
		() => state.entries.filter((entry) => entry.action === "none"),
		[state.entries],
	);
	const changes = state.entries.length - movedAway.length;
	const summary = t("restore.summary", {
		changed: progress.changed,
		commits: progress.commits.length,
	});
	// Restoring the whole space asks once more, with the counts.
	const [sure, setSure] = useState(false);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new list asks again
	useEffect(() => setSure(false), [state.entries]);
	// The keyboard follows the phase: Stop while it runs, the result's heading when it is done.
	const stopRef = useRef<HTMLButtonElement>(null);
	const headingRef = useRef<HTMLParagraphElement>(null);
	useEffect(() => {
		if (phase === "running") stopRef.current?.focus();
		else if (phase === "done") headingRef.current?.focus();
	}, [phase]);
	// The result names every moved-away block: read whatever of the list is still unread.
	useEffect(() => {
		if (phase === "done" && state.more && !state.loadingAll) void run.moreAll();
	}, [phase, state.more, state.loadingAll, run]);
	const written = earlier.changed > 0 && (
		<Alert color="yellow" variant="light" py={6} data-testid="outline-restore-earlier">
			<Text size="sm">{t("restore.earlier", { changed: earlier.changed })}</Text>
		</Alert>
	);

	if (phase === "loading") {
		return (
			<Stack gap="sm" data-restore-phase="loading">
				{written}
				<Group gap="xs">
					<Loader size="sm" />
					<Text size="sm">{t("restore.loading")}</Text>
				</Group>
			</Stack>
		);
	}

	if (phase === "running" || phase === "stopped") {
		return (
			<Stack gap="sm" data-restore-phase={phase}>
				{written}
				<Text size="sm" role="status" data-testid="outline-restore-progress">
					{phase === "running"
						? t("restore.running", { changed: progress.changed })
						: t("restore.stopped")}
				</Text>
				{phase === "running" && <Progress value={100} animated striped size="sm" />}
				<Text size="xs" c="dimmed">
					{summary}
				</Text>
				<Group justify="flex-end" gap="xs">
					{phase === "running" ? (
						<Button
							ref={stopRef}
							variant="default"
							onClick={() => run.stop()}
							data-testid="outline-restore-stop"
						>
							{t("restore.stop")}
						</Button>
					) : (
						<>
							<Button variant="default" onClick={onClose}>
								{t("restore.close")}
							</Button>
							<Button
								color="orange"
								disabled={!run.canConfirm()}
								onClick={() => void run.confirm()}
								data-testid="outline-restore-continue"
							>
								{t("restore.continue")}
							</Button>
						</>
					)}
				</Group>
			</Stack>
		);
	}

	if (phase === "done") {
		const skipped = [...progress.skipped].sort(
			(a, b) => SKIP_REASONS.indexOf(a.reason) - SKIP_REASONS.indexOf(b.reason),
		);
		const movedAwayCount = Math.max(progress.movedAway, movedAway.length);
		return (
			<Stack gap="sm" data-restore-phase="done" data-testid="outline-restore-result">
				<Alert
					color={skipped.length > 0 ? "yellow" : "green"}
					variant="light"
					icon={<IconCheck size={16} />}
				>
					<Text
						ref={headingRef}
						tabIndex={-1}
						size="sm"
						fw={500}
						data-testid="outline-restore-done"
					>
						{t(whole ? "restore.doneSpace" : "restore.done", { seq: thenSeq })}
					</Text>
					<Text size="sm">{progress.changed > 0 ? summary : t("restore.doneNothing")}</Text>
					{earlier.changed > 0 && (
						<Text size="sm">{t("restore.earlier", { changed: earlier.changed })}</Text>
					)}
					{progress.pending && (
						<Text size="sm">{t("restore.pendingHeld", { label: progress.pending.label })}</Text>
					)}
				</Alert>
				{skipped.length > 0 && (
					<Box data-testid="outline-restore-skipped">
						<Text size="sm" fw={500} mb={4}>
							{t("restore.skippedTitle", { count: skipped.length })}
						</Text>
						<SkipList skipped={skipped} entries={state.entries} spaceId={target.spaceId} />
						{progress.skippedTruncated && (
							<Text size="xs" c="dimmed" mt={4}>
								{t("restore.skippedMore")}
							</Text>
						)}
					</Box>
				)}
				{movedAwayCount > 0 && (
					<Box data-testid="outline-restore-moved-away" data-count={movedAwayCount}>
						<Text size="sm" fw={500} mb={4}>
							{t("restore.movedAwayTitle", { count: movedAwayCount })}
						</Text>
						<Stack gap={2}>
							{movedAway.map((entry) => (
								<EntryRow key={entry.blockId} entry={entry} run={run} state={state} />
							))}
						</Stack>
						{state.loadingAll && <Loader size={12} mt={4} />}
					</Box>
				)}
				<Group justify="flex-end">
					<Button onClick={onClose} data-testid="outline-restore-close">
						{t("asOf.backToNow")}
					</Button>
				</Group>
			</Stack>
		);
	}

	if (phase === "failed") {
		const fresh = problem ? needsNewPreview(problem) : true;
		return (
			<Stack gap="sm" data-restore-phase="failed">
				<Alert
					color={problem?.kind === "conflict" ? "orange" : "red"}
					variant="light"
					data-testid="outline-restore-problem"
					data-problem={problem?.kind}
					data-own={problem?.kind === "conflict" && problem.own ? "" : undefined}
				>
					<Text size="sm">{problem ? problemText(problem, t) : null}</Text>
					{progress.changed + earlier.changed > 0 && (
						<Text size="sm" mt={4} data-testid="outline-restore-partial">
							{t("restore.partial", { changed: progress.changed + earlier.changed })}
						</Text>
					)}
				</Alert>
				{movedAway.length > 0 && (
					<Stack gap={2}>
						{movedAway.map((entry) => (
							<EntryRow key={entry.blockId} entry={entry} run={run} state={state} />
						))}
					</Stack>
				)}
				<Group justify="flex-end" gap="xs">
					<Button variant="default" onClick={onClose}>
						{t("restore.close")}
					</Button>
					{fresh ? (
						<Button onClick={() => void run.preview()} data-testid="outline-restore-again">
							{t("restore.previewAgain")}
						</Button>
					) : (
						problem &&
						canRetry(problem) && (
							<Button onClick={() => void run.retry()} data-testid="outline-restore-retry">
								{t("restore.retry")}
							</Button>
						)
					)}
				</Group>
			</Stack>
		);
	}

	// The change list.
	const empty = changes === 0 && !state.more;
	const moving = Object.values(state.moveBack).some((m) => m.state === "moving");
	const ready = run.canConfirm();
	return (
		<Stack gap="sm" data-restore-phase="preview" data-testid="outline-restore-preview">
			{written}
			<Text size="sm" c="dimmed">
				{t(whole ? "restore.introSpace" : "restore.intro", { seq: thenSeq })}
			</Text>
			{state.refreshed > 0 && (
				<Text size="xs" c="dimmed" role="status" data-testid="outline-restore-refreshed">
					{t("restore.refreshed")}
				</Text>
			)}
			{empty && (
				<Text size="sm" data-testid="outline-restore-nothing">
					{t("restore.nothing", { seq: thenSeq })}
				</Text>
			)}
			{groups.map(({ group, entries }) => (
				<Box key={group} data-restore-group={group} data-count={entries.length}>
					<Group gap={6} mb={4} wrap="nowrap">
						<Text size="sm" fw={500}>
							{t(`restore.group.${group}`)}
						</Text>
						<Text size="xs" c="dimmed">
							{entries.length}
						</Text>
					</Group>
					<Stack gap={2}>
						{entries.map((entry) => (
							<EntryRow key={entry.blockId} entry={entry} group={group} run={run} state={state} />
						))}
					</Stack>
				</Box>
			))}
			{state.skippedElsewhere.length > 0 && (
				<SkipList
					skipped={state.skippedElsewhere}
					entries={state.entries}
					spaceId={target.spaceId}
				/>
			)}
			{state.problem && (
				<Alert color="red" variant="light" py={6}>
					<Text size="sm">{problemText(state.problem, t)}</Text>
				</Alert>
			)}
			{state.more && (
				<Box data-testid="outline-restore-incomplete">
					<Text size="sm" mb={4}>
						{t("restore.listIncomplete", { count: changes })}
					</Text>
					{state.loadingAll ? (
						<Group gap="xs">
							<Loader size={14} />
							<Anchor
								component="button"
								type="button"
								size="sm"
								onClick={() => run.stopList()}
								data-testid="outline-restore-all-stop"
							>
								{t("restore.stop")}
							</Anchor>
						</Group>
					) : (
						<Button
							size="compact-sm"
							variant="light"
							onClick={() => void run.moreAll()}
							data-testid="outline-restore-all"
						>
							{t("restore.wholeList")}
						</Button>
					)}
				</Box>
			)}
			{whole && sure && (
				<Alert color="orange" variant="light" data-testid="outline-restore-space-sure">
					<Text size="sm">
						{t("restore.spaceSure", {
							count: changes,
							groups: groups
								.filter((g) => g.group !== "moved-away" && g.group !== "kept")
								.map((g) => `${t(`restore.group.${g.group}`)} ${g.entries.length}`)
								.join(" · "),
						})}
					</Text>
				</Alert>
			)}
			<Group justify="flex-end" gap="xs" className={classes.restoreActions}>
				<Button variant="default" onClick={onClose}>
					{t("restore.cancel")}
				</Button>
				{whole && !sure ? (
					<Button
						color="orange"
						disabled={!ready}
						title={moving ? t("restore.waitMoveBack") : undefined}
						onClick={() => setSure(true)}
						data-testid="outline-restore-confirm"
					>
						{t("restore.confirmSpace")}
					</Button>
				) : (
					<Button
						color="orange"
						disabled={!ready}
						title={moving ? t("restore.waitMoveBack") : undefined}
						onClick={() => void run.confirm()}
						data-testid={whole ? "outline-restore-confirm-space" : "outline-restore-confirm"}
					>
						{t(whole ? "restore.confirmSpaceSure" : "restore.confirm")}
					</Button>
				)}
			</Group>
		</Stack>
	);
}

/** One block of the change list: what happens to it, and (moved away) its own "Move back". */
function EntryRow({
	entry,
	group,
	run,
	state,
}: {
	entry: OutlineRestoreEntry;
	group?: PreviewGroup;
	run: RestoreRun;
	state: RestoreState;
}) {
	const { t } = useTranslation("outline");
	const notes: string[] = [];
	if (entry.action === "delete-unless-holds" && !entry.skip) notes.push(t("restore.unlessHolds"));
	if (entry.action === "move-out" && entry.carries) {
		notes.push(
			t(entry.carriesMore ? "restore.carriesMore" : "restore.carries", { count: entry.carries }),
		);
	}
	if (entry.action === "put-back" && entry.skip) notes.push(t("restore.staysPut"));
	if ((group ?? "") === "kept" && entry.skip) notes.push(t(`restore.skip.${entry.skip}`));
	if (entry.deletedSince) notes.push(t("restore.deletedSince"));
	const kindLabel = entry.deletedSince ? t("diff.movedAwayDeleted") : t(`diff.kind.${entry.kind}`);
	return (
		<Group
			gap={6}
			wrap="nowrap"
			align="flex-start"
			className={classes.historyEntry}
			data-restore-entry={entry.blockId}
			data-restore-action={entry.action}
		>
			{/* What happened since, muted: the group's heading says what the restore does. */}
			<OutlineDiffMark kind={entry.kind} label={kindLabel} muted />
			<Box style={{ minWidth: 0, flex: 1 }}>
				<Text size="sm" className={classes.ellipsis}>
					{entryLine(entry, t)}
				</Text>
				{notes.length > 0 && (
					<Text size="xs" c="dimmed">
						{notes.join(" · ")}
					</Text>
				)}
			</Box>
			{entry.action === "none" && (
				<MoveBack entry={entry} state={state.moveBack[entry.blockId]} run={run} />
			)}
		</Group>
	);
}

function MoveBack({
	entry,
	state,
	run,
}: {
	entry: OutlineRestoreEntry;
	state: MoveBackState | undefined;
	run: RestoreRun;
}) {
	const { t } = useTranslation("outline");
	if (state?.state === "moved") {
		return (
			<Text size="xs" c="green" data-testid="outline-moved-back" style={{ flexShrink: 0 }}>
				{t(state.restored ? "restore.movedBackRestored" : "restore.movedBack")}
			</Text>
		);
	}
	if (entry.canMoveBack === false) {
		return (
			<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
				{t("restore.cannotMoveBack")}
			</Text>
		);
	}
	return (
		<Stack gap={2} align="flex-end" style={{ flexShrink: 0, maxWidth: "50%" }}>
			<Button
				size="compact-xs"
				variant="light"
				loading={state?.state === "moving"}
				onClick={() => void run.moveBack(entry.blockId)}
				data-testid="outline-move-back"
				data-block={entry.blockId}
			>
				{t("restore.moveBack")}
			</Button>
			{state?.state === "failed" && (
				<Text size="xs" c="red" ta="right" data-testid="outline-move-back-problem">
					{problemText(state.problem, t)}
				</Text>
			)}
		</Stack>
	);
}

/** Blocks left alone, each with why in plain words. */
function SkipList({
	skipped,
	entries,
	spaceId,
}: {
	skipped: readonly OutlineRestoreSkip[];
	entries: readonly OutlineRestoreEntry[];
	spaceId: string;
}) {
	const { t } = useTranslation("outline");
	const byId = useMemo(() => new Map(entries.map((entry) => [entry.blockId, entry])), [entries]);
	return (
		<Stack gap={2}>
			{skipped.map((skip) => {
				const entry = byId.get(skip.blockId);
				return (
					<Box
						key={skip.blockId}
						className={classes.historyEntry}
						data-restore-skip={skip.reason}
						data-block={skip.blockId}
					>
						<Text size="sm" className={classes.ellipsis}>
							{entry ? entryLine(entry, t) : <BlockName spaceId={spaceId} blockId={skip.blockId} />}
						</Text>
						<Text size="xs" c="dimmed">
							{t(`restore.skip.${skip.reason}`)}
						</Text>
					</Box>
				);
			})}
		</Stack>
	);
}

/** A block the change list did not name: its first line, read now (never a bare short id). */
function BlockName({ spaceId, blockId }: { spaceId: string; blockId: string }) {
	const { t } = useTranslation("outline");
	const read = useQuery({
		queryKey: ["outline", "block-name", spaceId, blockId],
		queryFn: () => api.getOutlineSubtree(spaceId, blockId, { view: "all", blocks: 1 }),
		retry: false,
		staleTime: 60_000,
	});
	if (read.isLoading) return <Loader size={10} />;
	const block = read.data?.blocks.find((b) => b.id === blockId);
	const line = block ? blockTitle(block.content).trim() : "";
	return <>{line || (block ? t("diff.untitled") : t("restore.blockUnreadable"))}</>;
}

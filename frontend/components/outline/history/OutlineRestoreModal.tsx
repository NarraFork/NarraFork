/**
 * Restore a block's subtree (or the whole space) to an earlier point (pageless outline, F2, on
 * H3's routes), as owner rule D58 says: only what was under it then is touched, and the change
 * list is shown before anything is written.
 *
 *   preview (paged) ──Restore──▶ running (one call after another, Stop) ──▶ done (result)
 *        ▲   │ Move back (a moved-away block): the list is worked out again
 *        └───┴── a conflict or a stale preview: Preview again
 *
 * The list is grouped by what happens (deleted, brought back, moved back out with what goes
 * along, put back, left as it is with why, moved away with its own "Move back"). Everything it
 * says comes from the server's preview; nothing here decides what a restore does.
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
import type { OutlineRestoreEntry, OutlineRestoreSkip } from "@shared/outline-restore-api";
import { IconCheck } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { invalidateOutlineSpace } from "../../../hooks/useOutline";
import { api } from "../../../lib/api";
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

export function OutlineRestoreModal({
	spaceId,
	rootId,
	thenSeq,
	opened,
	onClose,
	onFinished,
	io,
}: {
	spaceId: string;
	/** The block whose subtree is restored; null: the whole space. */
	rootId: string | null;
	thenSeq: number;
	opened: boolean;
	onClose: () => void;
	/** The restore is done and the reader closed its result (the host goes back to now). */
	onFinished?: () => void;
	/** Requests (tests); the app's API when absent. */
	io?: RestoreIO;
}) {
	const { t } = useTranslation("outline");
	const mobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const queryClient = useQueryClient();
	// One run per opening: a new preview each time the dialog opens.
	const [nonce, setNonce] = useState(0);
	// Made in the effect (not during render), so that a mount run twice (React's strict mode)
	// disposes the first run and previews with a live second one.
	const [run, setRun] = useState<RestoreRun | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new nonce is a new run
	useEffect(() => {
		if (!opened) {
			setRun(null);
			return;
		}
		const made = new RestoreRun(io ?? restoreIO(spaceId), rootId, thenSeq);
		setRun(made);
		void made.preview();
		return () => made.dispose();
	}, [opened, nonce, spaceId, rootId, thenSeq, io]);
	const state = useSyncExternalStore(
		run?.subscribe ?? noSubscribe,
		run?.getState ?? noState,
		run?.getState ?? noState,
	);
	// What it wrote is shown everywhere: the current views, timelines and comparisons are stale.
	const wrote = state?.progress.commits.length ?? 0;
	const moved = state ? Object.values(state.moveBack).filter((m) => m.state === "moved").length : 0;
	useEffect(() => {
		if (wrote === 0 && moved === 0) return;
		invalidateOutlineSpace(queryClient, spaceId);
		queryClient.removeQueries({ queryKey: ["outline", "diff", spaceId] });
	}, [wrote, moved, queryClient, spaceId]);
	const running = state?.phase === "running";
	const close = () => {
		if (running) return;
		const finished = state?.phase === "done";
		onClose();
		if (finished) onFinished?.();
	};
	return (
		<Modal
			opened={opened}
			onClose={close}
			title={t("restore.title", { seq: thenSeq })}
			size="lg"
			fullScreen={mobile}
			closeOnClickOutside={!running}
			closeOnEscape={!running}
			withCloseButton={!running}
			data-testid="outline-restore"
		>
			{run && state && (
				<RestoreBody
					run={run}
					state={state}
					thenSeq={thenSeq}
					onClose={close}
					onAgain={() => setNonce((n) => n + 1)}
				/>
			)}
		</Modal>
	);
}

const noSubscribe = () => () => {};
const noState = () => null;

function RestoreBody({
	run,
	state,
	thenSeq,
	onClose,
	onAgain,
}: {
	run: RestoreRun;
	state: RestoreState;
	thenSeq: number;
	onClose: () => void;
	onAgain: () => void;
}) {
	const { t } = useTranslation("outline");
	const { phase, progress, problem } = state;
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

	if (phase === "loading") {
		return (
			<Group gap="xs" data-restore-phase="loading">
				<Loader size="sm" />
				<Text size="sm">{t("restore.loading")}</Text>
			</Group>
		);
	}

	if (phase === "running" || phase === "stopped") {
		return (
			<Stack gap="sm" data-restore-phase={phase}>
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
						<Button variant="default" onClick={() => run.stop()} data-testid="outline-restore-stop">
							{t("restore.stop")}
						</Button>
					) : (
						<>
							<Button variant="default" onClick={onClose}>
								{t("restore.close")}
							</Button>
							<Button
								color="orange"
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
		return (
			<Stack gap="sm" data-restore-phase="done" data-testid="outline-restore-result">
				<Alert
					color={skipped.length > 0 ? "yellow" : "green"}
					variant="light"
					icon={<IconCheck size={16} />}
				>
					<Text size="sm" fw={500}>
						{t("restore.done", { seq: thenSeq })}
					</Text>
					<Text size="sm">{progress.changed > 0 ? summary : t("restore.doneNothing")}</Text>
					{progress.pending && (
						<Text size="sm">{t("restore.pendingHeld", { label: progress.pending.label })}</Text>
					)}
				</Alert>
				{skipped.length > 0 && (
					<Box data-testid="outline-restore-skipped">
						<Text size="sm" fw={500} mb={4}>
							{t("restore.skippedTitle", { count: skipped.length })}
						</Text>
						<SkipList skipped={skipped} entries={state.entries} />
						{progress.skippedTruncated && (
							<Text size="xs" c="dimmed" mt={4}>
								{t("restore.skippedMore")}
							</Text>
						)}
					</Box>
				)}
				{movedAway.length > 0 && (
					<Box>
						<Text size="sm" fw={500} mb={4}>
							{t("restore.movedAwayTitle", { count: movedAway.length })}
						</Text>
						<Stack gap={2}>
							{movedAway.map((entry) => (
								<EntryRow key={entry.blockId} entry={entry} run={run} state={state} />
							))}
						</Stack>
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
				>
					<Text size="sm">{problem ? problemText(problem, t) : null}</Text>
					{progress.changed > 0 && (
						<Text size="sm" mt={4}>
							{t("restore.partial", { changed: progress.changed })}
						</Text>
					)}
				</Alert>
				<Group justify="flex-end" gap="xs">
					<Button variant="default" onClick={onClose}>
						{t("restore.close")}
					</Button>
					{fresh ? (
						<Button onClick={onAgain} data-testid="outline-restore-again">
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
	return (
		<Stack gap="sm" data-restore-phase="preview" data-testid="outline-restore-preview">
			<Text size="sm" c="dimmed">
				{t("restore.intro", { seq: thenSeq })}
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
				<Box key={group} data-restore-group={group}>
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
				<SkipList skipped={state.skippedElsewhere} entries={state.entries} />
			)}
			{state.problem && (
				<Alert color="red" variant="light" py={6}>
					<Text size="sm">{problemText(state.problem, t)}</Text>
				</Alert>
			)}
			{state.more && (
				<Box>
					<Anchor
						component="button"
						type="button"
						size="sm"
						onClick={() => void run.more()}
						disabled={state.loadingMore}
						data-testid="outline-restore-more"
					>
						{t("restore.moreList")}
					</Anchor>
					{state.loadingMore && <Loader size={12} ml={6} />}
					<Text size="xs" c="dimmed" mt={2}>
						{t("restore.listIncomplete")}
					</Text>
				</Box>
			)}
			<Group justify="flex-end" gap="xs" className={classes.restoreActions}>
				<Button variant="default" onClick={onClose}>
					{t("restore.cancel")}
				</Button>
				<Button
					color="orange"
					disabled={empty || (changes === 0 && !state.more)}
					onClick={() => void run.confirm()}
					data-testid="outline-restore-confirm"
				>
					{t("restore.confirm")}
				</Button>
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
			<OutlineDiffMark kind={entry.kind} label={kindLabel} />
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
}: {
	skipped: readonly OutlineRestoreSkip[];
	entries: readonly OutlineRestoreEntry[];
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
							{entry ? entryLine(entry, t) : skip.sid}
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

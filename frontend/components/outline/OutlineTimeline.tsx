import {
	ActionIcon,
	Box,
	Button,
	Group,
	List,
	Modal,
	ScrollArea,
	Stack,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type {
	OutlineBlockViewResponse,
	OutlineCommitSummary,
	OutlineRevertResponse,
} from "@shared/outline-api";
import {
	IconArrowBackUp,
	IconChevronsLeft,
	IconMessageCircle,
	IconPlayerTrackNext,
	IconPlayerTrackPrev,
} from "@tabler/icons-react";
import type { TFunction } from "i18next";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNarratorReadable } from "../../hooks/useNarratorReadable";
import { useOutlineTimeline, useRevertOutlineCommit } from "../../hooks/useOutline";
import { describeApiError } from "../../lib/api-error";
import { formatFullLocaleDateTime, formatSmartTime } from "../../lib/format";
import { timelineOldestFirst, timelinePosition } from "../../lib/outline-view";
import classes from "./Outline.module.css";
import { useOutlineHost } from "./outline-host";

/** Who wrote a commit, as a short label. */
export function commitActorLabel(commit: OutlineCommitSummary, t: TFunction): string {
	if (commit.actorKind === "human") {
		return commit.actorName ?? t("timeline.actor.unknown", { ns: "outline" });
	}
	if (commit.actorKind === "agent") {
		return commit.responsibleName
			? t("timeline.actor.agentFor", { ns: "outline", name: commit.responsibleName })
			: t("timeline.actor.agent", { ns: "outline" });
	}
	return t("timeline.actor.system", { ns: "outline" });
}

function commitTitle(commit: OutlineCommitSummary, t: TFunction): string {
	return [
		t("timeline.commit", { ns: "outline", seq: commit.seq }),
		t(`timeline.kind.${commit.kind}`, { ns: "outline" }),
		commitActorLabel(commit, t),
		formatFullLocaleDateTime(commit.createdAt),
		commit.summary,
	]
		.filter(Boolean)
		.join(" · ");
}

function revertMessage(result: OutlineRevertResponse, t: TFunction): string {
	const lines = [
		result.commit
			? t("timeline.revertChanged", { ns: "outline", count: result.changed })
			: t("timeline.revertedNothing", { ns: "outline" }),
	];
	if (result.skipped.length > 0) {
		lines.push(t("timeline.revertSkipped", { ns: "outline", count: result.skipped.length }));
		for (const skip of result.skipped.slice(0, 3)) {
			lines.push(`${skip.address}: ${t(`timeline.skipReason.${skip.reason}`, { ns: "outline" })}`);
		}
	}
	return lines.join("\n");
}

/**
 * Open the session that wrote an agent's commit, beside the outline. Offered only where the host
 * can open sessions, and enabled only when the person can read that session (its detail route
 * answers); otherwise disabled, saying why.
 */
function OpenCommitSession({
	narratorId,
	open,
}: {
	narratorId: string;
	open: (narratorId: string) => void;
}) {
	const { t } = useTranslation("outline");
	const { readable, loading } = useNarratorReadable(narratorId);
	const button = (
		<Button
			size="compact-xs"
			variant="subtle"
			leftSection={<IconMessageCircle size={12} />}
			disabled={!readable}
			loading={loading}
			onClick={() => open(narratorId)}
			data-testid="outline-open-commit-session"
		>
			{t("timeline.openSession")}
		</Button>
	);
	if (readable || loading) return button;
	return (
		<Tooltip label={t("timeline.sessionUnavailable")}>
			<span>{button}</span>
		</Tooltip>
	);
}

/**
 * The strip at the bottom of a page: every commit that touched the page, oldest to newest
 * (older ones loaded on demand). Picking one shows the page as of it; "Now" goes back to the
 * current state. People who may write the space can revert the picked commit.
 */
export function OutlineTimeline({
	view,
	asOf,
	onSelect,
}: {
	view: OutlineBlockViewResponse;
	asOf: number | undefined;
	onSelect: (seq: number | undefined) => void;
}) {
	const { t } = useTranslation("outline");
	const host = useOutlineHost();
	const timeline = useOutlineTimeline(view.space.id, view.pageId);
	const commits = useMemo(() => timelineOldestFirst(timeline.data?.pages ?? []), [timeline.data]);
	const { selected, previous, next } = timelinePosition(commits, asOf);
	const revert = useRevertOutlineCommit(view.space.id);
	const [confirming, setConfirming] = useState<OutlineCommitSummary | null>(null);
	const viewport = useRef<HTMLDivElement>(null);
	const selectedSeq = selected?.seq;

	// Keep the picked commit in view (the newest one when showing the current state).
	useEffect(() => {
		if (selectedSeq === undefined) return;
		const tick = viewport.current?.querySelector<HTMLElement>(`[data-seq="${selectedSeq}"]`);
		tick?.scrollIntoView({ block: "nearest", inline: "nearest" });
	}, [selectedSeq]);

	const confirmRevert = (commit: OutlineCommitSummary) => {
		revert.mutate(commit.id, {
			onSuccess: (result) => {
				setConfirming(null);
				notifications.show({
					color: result.skipped.length > 0 ? "yellow" : "green",
					title: t("timeline.reverted", { seq: commit.seq }),
					message: <span style={{ whiteSpace: "pre-line" }}>{revertMessage(result, t)}</span>,
				});
				onSelect(undefined);
			},
			onError: (error) => {
				notifications.show({
					color: "red",
					title: t("timeline.revertFailed"),
					message: describeApiError(error, t).message,
				});
			},
		});
	};

	return (
		<Box className={classes.timeline} role="region" aria-label={t("timeline.label")}>
			<Group gap={6} wrap="nowrap">
				<Tooltip label={t("timeline.previous")}>
					<ActionIcon
						variant="subtle"
						color="gray"
						size="sm"
						disabled={!previous}
						aria-label={t("timeline.previous")}
						onClick={() => previous && onSelect(previous.seq)}
					>
						<IconPlayerTrackPrev size={14} />
					</ActionIcon>
				</Tooltip>
				<ScrollArea
					type="auto"
					scrollbarSize={4}
					className={classes.ticksViewport}
					viewportRef={viewport}
				>
					<div className={classes.ticks}>
						{timeline.hasNextPage && (
							<Tooltip label={t("timeline.older")}>
								<ActionIcon
									variant="subtle"
									color="gray"
									size="sm"
									loading={timeline.isFetchingNextPage}
									aria-label={t("timeline.older")}
									onClick={() => void timeline.fetchNextPage()}
								>
									<IconChevronsLeft size={14} />
								</ActionIcon>
							</Tooltip>
						)}
						{commits.map((commit) => (
							<Tooltip key={commit.id} label={commitTitle(commit, t)} multiline maw={320}>
								<UnstyledButton
									className={classes.tick}
									data-seq={commit.seq}
									data-actor={commit.actorKind}
									data-kind={commit.kind}
									data-selected={selected?.seq === commit.seq}
									aria-current={selected?.seq === commit.seq ? "true" : undefined}
									aria-label={commitTitle(commit, t)}
									onClick={() => onSelect(commit.seq)}
								/>
							</Tooltip>
						))}
						{timeline.isSuccess && commits.length === 0 && (
							<Text size="xs" c="dimmed">
								{t("timeline.empty")}
							</Text>
						)}
					</div>
				</ScrollArea>
				<Tooltip label={t("timeline.next")}>
					<ActionIcon
						variant="subtle"
						color="gray"
						size="sm"
						disabled={!next || asOf === undefined}
						aria-label={t("timeline.next")}
						onClick={() => next && onSelect(next.seq)}
					>
						<IconPlayerTrackNext size={14} />
					</ActionIcon>
				</Tooltip>
				<Button
					size="compact-xs"
					variant={asOf === undefined ? "filled" : "light"}
					onClick={() => onSelect(undefined)}
				>
					{t("timeline.now")}
				</Button>
			</Group>
			{selected && (
				<Group gap="xs" wrap="nowrap" mt={4} justify="space-between">
					<Text
						size="xs"
						c="dimmed"
						className={classes.commitLine}
						title={commitTitle(selected, t)}
					>
						{[
							t("timeline.commit", { seq: selected.seq }),
							commitActorLabel(selected, t),
							formatSmartTime(selected.createdAt),
							selected.summary,
						].join(" · ")}
					</Text>
					<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
						{host.openSession && selected.actorKind === "agent" && selected.narratorId && (
							<OpenCommitSession narratorId={selected.narratorId} open={host.openSession} />
						)}
						{view.space.canWrite && (
							<Button
								size="compact-xs"
								variant="subtle"
								color="orange"
								leftSection={<IconArrowBackUp size={12} />}
								onClick={() => setConfirming(selected)}
							>
								{t("timeline.revert")}
							</Button>
						)}
					</Group>
				</Group>
			)}
			<Modal
				opened={confirming !== null}
				onClose={() => setConfirming(null)}
				title={t("timeline.revertTitle", { seq: confirming?.seq ?? 0 })}
				size="md"
			>
				{confirming && (
					<Stack gap="sm">
						<Text size="sm">{t("timeline.revertConfirm")}</Text>
						<List size="sm" spacing={2}>
							<List.Item>{commitTitle(confirming, t)}</List.Item>
						</List>
						<Group justify="flex-end" gap="xs">
							<Button variant="default" onClick={() => setConfirming(null)}>
								{t("timeline.cancel")}
							</Button>
							<Button
								color="orange"
								loading={revert.isPending}
								onClick={() => confirmRevert(confirming)}
							>
								{t("timeline.revertAction")}
							</Button>
						</Group>
					</Stack>
				)}
			</Modal>
		</Box>
	);
}

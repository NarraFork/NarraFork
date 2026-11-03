/**
 * Locks and changes waiting for confirmation, in the side panel of a focused block (design §2.2,
 * §2.6; P2 PR 6):
 *
 *   - `OutlineLockSection`: on a focused task, who locked its plan and who confirms on their
 *     behalf, with Unlock for those who may; or Lock, with an optional session to confirm for the
 *     person (one of the project's sessions; the server checks the person may write it). Only
 *     people lock (owner decision Q5).
 *   - `OutlinePendingList`: the open changes of the page that concern the focused block, each with
 *     its diff (as proposed against, as proposed, as it is now) and, for the person who locked the
 *     plan, Confirm and Reject (with a reason the agent reads). The inbox (plan PR 7) reuses the
 *     diff.
 */
import {
	Alert,
	Badge,
	Button,
	Group,
	Loader,
	Paper,
	Select,
	Stack,
	Text,
	Textarea,
	UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type {
	OutlineBlockViewResponse,
	OutlineLockView,
	OutlinePendingDiffEntry,
	OutlinePendingSummary,
} from "@shared/outline-api";
import { IconLock, IconLockOpen } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useDecideOutlinePending,
	useOutlineLock,
	useOutlinePendingDetail,
} from "../../hooks/useOutline";
import { ApiError, api } from "../../lib/api";
import { formatSmartTime } from "../../lib/format";
import classes from "./Outline.module.css";

type Translate = ReturnType<typeof useTranslation>["t"];

function sessionName(t: Translate, title: string | null | undefined): string {
	return title ? t("lock.session", { title }) : t("lock.untitledSession");
}

function lockerName(t: Translate, lock: Pick<OutlineLockView, "by">): string {
	if (lock.by.kind === "human") return lock.by.name ?? t("lock.someone");
	return sessionName(t, lock.by.name);
}

function errorText(error: unknown): string {
	if (error instanceof ApiError) return error.message;
	return error instanceof Error ? error.message : String(error);
}

/** Sessions that may confirm on the person's behalf: the project's (or the session's own). */
function useDelegateOptions(view: OutlineBlockViewResponse, enabled: boolean) {
	const projectId = view.space.kind === "project" ? view.space.projectId : null;
	const query = useQuery({
		queryKey: ["outline", "lock-delegates", projectId],
		queryFn: () => api.listNarratorsPaginated({ projectId: projectId as string, limit: 30 }),
		enabled: enabled && projectId !== null,
		staleTime: 30_000,
	});
	if (view.space.kind === "session" && view.space.narratorId) {
		return [{ value: view.space.narratorId, label: view.space.label ?? view.space.narratorId }];
	}
	return (query.data?.items ?? [])
		.filter((n: { type?: string }) => n.type !== "subagent")
		.map((n: { id: string; title?: string | null }) => ({ value: n.id, label: n.title || n.id }));
}

/** The lock of the focused task: who, and Unlock; or Lock with an optional delegate. */
export function OutlineLockSection({ view }: { view: OutlineBlockViewResponse }) {
	const { t } = useTranslation("outline");
	const root = view.blocks.find((b) => b.id === view.rootId);
	const [delegate, setDelegate] = useState<string | null>(null);
	const lock = useOutlineLock(view.space.id);
	const canWrite = view.space.canWrite;
	const options = useDelegateOptions(view, canWrite && !root?.lock);
	if (!root?.task || !view.current) return null;
	const current = root.lock;
	const run = (input: { lock: boolean; delegate?: string | null }) =>
		lock.mutate(
			{ blockId: root.id, ...input },
			{
				onSuccess: () =>
					notifications.show({
						color: "indigo",
						message: t(input.lock ? "lock.lockedNotice" : "lock.unlockedNotice"),
					}),
				onError: (error) =>
					notifications.show({ color: "red", title: t("lock.failed"), message: errorText(error) }),
			},
		);
	return (
		<Paper withBorder p="xs" mb="xs" data-testid="outline-lock-section">
			<Group gap={6} mb={4} wrap="nowrap">
				{current ? <IconLock size={14} /> : <IconLockOpen size={14} />}
				<Text size="sm" fw={500}>
					{current ? t("lock.lockedBy", { name: lockerName(t, current) }) : t("lock.section")}
				</Text>
			</Group>
			{current ? (
				<>
					{current.delegate && (
						<Text size="xs" c="dimmed">
							{t("lock.delegate", { name: sessionName(t, current.delegate.title) })}
						</Text>
					)}
					<Text size="xs" c="dimmed" mt={4}>
						{t("lock.explainLocked")}
					</Text>
					{current.canUnlock && (
						<Group gap="xs" mt="xs">
							<Button
								size="compact-xs"
								variant="light"
								color="gray"
								leftSection={<IconLockOpen size={12} />}
								loading={lock.isPending}
								onClick={() => run({ lock: false })}
								data-testid="outline-unlock"
							>
								{t("lock.unlock")}
							</Button>
							<Text size="xs" c="dimmed">
								{t("lock.unlockHint")}
							</Text>
						</Group>
					)}
				</>
			) : (
				<>
					<Text size="xs" c="dimmed">
						{t("lock.explainUnlocked")}
					</Text>
					{canWrite && (
						<Stack gap={6} mt="xs">
							<Select
								size="xs"
								label={t("lock.delegateLabel")}
								placeholder={t("lock.delegatePlaceholder")}
								data={options}
								value={delegate}
								onChange={setDelegate}
								clearable
								searchable
								comboboxProps={{ withinPortal: true }}
								data-testid="outline-lock-delegate"
							/>
							<Button
								size="compact-xs"
								leftSection={<IconLock size={12} />}
								loading={lock.isPending}
								onClick={() => run({ lock: true, delegate })}
								data-testid="outline-lock"
							>
								{t("lock.lock")}
							</Button>
						</Stack>
					)}
				</>
			)}
		</Paper>
	);
}

/**
 * The open changes of the page that concern the focused block: the focused block is the page,
 * the locked task, or a block the change touches (or shown under the focus).
 */
export function pendingFor(
	view: OutlineBlockViewResponse,
	pending: readonly OutlinePendingSummary[],
): OutlinePendingSummary[] {
	if (view.rootId === view.pageId) return [...pending];
	const shown = new Set(view.blocks.map((b) => b.id));
	return pending.filter(
		(p) =>
			p.rootBlockId === view.rootId ||
			(p.rootBlockId !== null && shown.has(p.rootBlockId)) ||
			p.blockIds.includes(view.rootId) ||
			p.addedUnder.includes(view.rootId),
	);
}

/** The changes waiting for confirmation that concern the focused block, each with its diff. */
export function OutlinePendingList({
	spaceId,
	pending,
}: {
	spaceId: string;
	pending: readonly OutlinePendingSummary[];
}) {
	const { t } = useTranslation("outline");
	const [open, setOpen] = useState<string | null>(
		pending.length === 1 ? (pending[0]?.id ?? null) : null,
	);
	if (pending.length === 0) {
		return (
			<Text size="sm" c="dimmed">
				{t("pending.none")}
			</Text>
		);
	}
	return (
		<Stack gap={6} data-testid="outline-pending-list">
			{pending.map((p) => (
				<Paper key={p.id} withBorder p={6} data-testid="outline-pending-item">
					<UnstyledButton
						className={classes.listItem}
						onClick={() => setOpen(open === p.id ? null : p.id)}
						aria-expanded={open === p.id}
					>
						<Group gap={6} wrap="nowrap">
							<Badge size="xs" variant="light" color="orange" tt="none">
								{p.label}
							</Badge>
							<Text size="sm" className={classes.ellipsis}>
								{p.summary || t("pending.changes", { count: p.ops })}
							</Text>
						</Group>
						<Text size="xs" c="dimmed" className={classes.ellipsis}>
							{[
								t("pending.proposedBy", { name: sessionName(t, p.proposer.title) }),
								formatSmartTime(p.updatedAt),
							].join(" · ")}
						</Text>
					</UnstyledButton>
					{open === p.id && <PendingDetail spaceId={spaceId} summary={p} />}
				</Paper>
			))}
		</Stack>
	);
}

export function PendingDetail({
	spaceId,
	summary,
}: {
	spaceId: string;
	summary: OutlinePendingSummary;
}) {
	const { t } = useTranslation("outline");
	const detail = useOutlinePendingDetail(summary.id);
	const decide = useDecideOutlinePending(spaceId);
	const [reason, setReason] = useState("");
	const decider = summary.decider;
	const by = lockerName(t, decider);
	const run = (decision: "confirm" | "reject") =>
		decide.mutate(
			{ pendingId: summary.id, decision, reason },
			{
				onSuccess: () =>
					notifications.show({
						color: decision === "confirm" ? "green" : "gray",
						message: t(decision === "confirm" ? "pending.confirmed" : "pending.rejected", {
							label: summary.label,
						}),
					}),
				onError: (error) =>
					notifications.show({
						color: "red",
						title: t("pending.failed", { label: summary.label }),
						message: errorText(error),
					}),
			},
		);
	return (
		<Stack gap={6} mt={6}>
			<Text size="xs" c="dimmed">
				{decider.delegate
					? t("pending.deciderWithDelegate", {
							name: by,
							delegate: sessionName(t, decider.delegate.title),
						})
					: t("pending.decider", { name: by })}
			</Text>
			{summary.changedSince && (
				<Alert variant="light" color="yellow" py={4}>
					<Text size="xs">{t("pending.changedSince")}</Text>
				</Alert>
			)}
			{detail.isLoading && <Loader size="xs" />}
			{detail.data?.entries.map((entry) => (
				<DiffEntry key={`${entry.kind}:${entry.blockId}`} entry={entry} />
			))}
			{detail.data?.truncated && (
				<Text size="xs" c="dimmed">
					{t("pending.truncated")}
				</Text>
			)}
			{summary.canDecide ? (
				<Stack gap={4}>
					<Textarea
						size="xs"
						autosize
						minRows={1}
						maxRows={4}
						placeholder={t("pending.reasonPlaceholder")}
						value={reason}
						onChange={(e) => setReason(e.currentTarget.value)}
						data-testid="outline-pending-reason"
					/>
					<Group gap="xs">
						<Button
							size="compact-xs"
							color="green"
							loading={decide.isPending && decide.variables?.decision === "confirm"}
							onClick={() => run("confirm")}
							data-testid="outline-pending-confirm"
						>
							{t("pending.confirm")}
						</Button>
						<Button
							size="compact-xs"
							variant="light"
							color="red"
							loading={decide.isPending && decide.variables?.decision === "reject"}
							onClick={() => run("reject")}
							data-testid="outline-pending-reject"
						>
							{t("pending.reject")}
						</Button>
					</Group>
				</Stack>
			) : (
				<Text size="xs" c="dimmed">
					{t("pending.notYours")}
				</Text>
			)}
		</Stack>
	);
}

/** One block of a pending change: before, proposed, and now when it changed since. */
export function DiffEntry({ entry }: { entry: OutlinePendingDiffEntry }) {
	const { t } = useTranslation("outline");
	const lines: Array<{ label: string; text: string; tone: string }> = [];
	if (entry.base !== null && entry.kind !== "insert")
		lines.push({ label: t("pending.base"), text: entry.base, tone: "dimmed" });
	if (entry.proposed !== null && (entry.kind === "update" || entry.kind === "insert"))
		lines.push({ label: t("pending.proposed"), text: entry.proposed, tone: "green" });
	if (entry.changedSince && entry.now !== null)
		lines.push({ label: t("pending.now"), text: entry.now, tone: "yellow" });
	const task = entry.task;
	return (
		<Paper withBorder p={6} radius="sm" data-testid="outline-pending-entry">
			<Group gap={6} mb={2}>
				<Badge size="xs" variant="outline" tt="none">
					{t(`pending.kind.${entry.kind}`)}
				</Badge>
				{(entry.kind === "move" || entry.kind === "insert") && entry.parentTitle !== undefined && (
					<Text size="xs" c="dimmed">
						{entry.parentTitle
							? t("pending.under", { title: entry.parentTitle })
							: t("pending.topLevel")}
					</Text>
				)}
			</Group>
			{lines.map((line) => (
				<Text key={line.label} size="xs" c={line.tone} className={classes.diffText}>
					<b>{line.label}:</b> {line.text}
				</Text>
			))}
			{entry.kind === "delete" && (entry.changedUnder ?? 0) > 0 && (
				<Text size="xs" c="yellow" data-testid="outline-pending-changed-under">
					{t("pending.changedUnder", { count: entry.changedUnder })}
				</Text>
			)}
			{entry.kind === "delete" && entry.subtreeUnchecked && (
				<Text size="xs" c="dimmed" data-testid="outline-pending-subtree-unchecked">
					{t(
						entry.subtreeUnchecked === "writers"
							? "pending.subtreeUncheckedWriters"
							: "pending.subtreeUnchecked",
					)}
				</Text>
			)}
			{entry.kind === "task" && (
				<Text size="xs">
					{task === null
						? t("pending.taskRemoved")
						: [
								task?.status
									? t("pending.taskStatus", { status: t(`page.task.${task.status}`) })
									: null,
								task?.due ? t("pending.taskDue", { date: task.due }) : null,
								task?.assignee ? t("pending.taskAssignee", { name: task.assignee }) : null,
							]
								.filter(Boolean)
								.join(" · ")}
				</Text>
			)}
		</Paper>
	);
}

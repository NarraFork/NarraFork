/**
 * One report shown (汇报, P2 PR 11; design §5): its sections, every item with its links back (the
 * block now, the page as of the commit, the session), and undo for the decisions made in the
 * reader's name. The page shows a report in full; the inbox row shows it `compact`: every
 * section's count, the first few items of each, and every decision made in the reader's name.
 *
 * Links to blocks go through the host's link renderer (`outline-nav.tsx`); links to a commit (the
 * reference route) and to a session are app paths the host opens (`OutlineHrefLink`). `onOpen`
 * runs on any link, so a drawer can close.
 */
import {
	Alert,
	Anchor,
	Badge,
	Button,
	Group,
	Paper,
	Stack,
	Text,
	VisuallyHidden,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type {
	OutlineDelegatedKind,
	OutlineDigestActor,
	OutlineDigestDelegatedView,
	OutlineDigestDetailResponse,
	OutlineDigestKnowledgeView,
	OutlineDigestNames,
	OutlineDigestOtherView,
	OutlineDigestPlanView,
	OutlineDigestQuestionView,
	OutlineDigestSection,
	OutlineDigestSpaceView,
	OutlineDigestTaskView,
} from "@shared/outline-digest";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../../hooks/useAuth";
import { useUndoOutlineDecision, wasUndoneHere } from "../../../hooks/useOutlineReports";
import { formatLocaleTime } from "../../../lib/intl-format";
import { reportLineDisplay } from "../../../lib/outline-report-line";
import { OutlineStatusChip } from "../OutlineStatusIcon";
import { OutlineHrefLink, OutlineLink, type OutlineTarget } from "../outline-nav";
import {
	commitPath,
	type DigestItemLinks,
	type DigestSectionEntry,
	type DigestUndoRefusal,
	digestModel,
	itemLinks,
	sessionPath,
	undoRefusalOf,
} from "./digest-model";

type Translate = ReturnType<typeof useTranslation>["t"];

/** What every item needs to say who did what, and when. */
interface ItemContext {
	t: Translate;
	names: OutlineDigestNames;
	readerId: string | null;
	timeZone: string;
	lang: string;
	/** The item's space, when the view shows more than one. */
	spaceOf: (spaceId: string) => string | null;
	onOpen?: () => void;
}

const SYSTEM_ACTORS = new Set([
	"plan-review",
	"outline-lease",
	"outline-delegate",
	"outline-report",
]);

function actorName(ctx: ItemContext, actor: OutlineDigestActor | null): string | null {
	const { t } = ctx;
	if (!actor) return null;
	if (actor.kind === "human")
		return actor.id === ctx.readerId
			? t("report.actor.you")
			: (ctx.names.users[actor.id] ?? t("report.actor.someone"));
	if (actor.kind === "agent") {
		if (!(actor.id in ctx.names.sessions)) return t("report.actor.hiddenSession");
		return ctx.names.sessions[actor.id] || t("report.actor.untitledSession");
	}
	return SYSTEM_ACTORS.has(actor.id)
		? t(`report.actor.system.${actor.id}`)
		: t("report.actor.systemOther", { name: actor.id });
}

/** A session the reader may open, from an actor (null otherwise). */
function actorSession(ctx: ItemContext, actor: OutlineDigestActor | null): string | null {
	return actor?.kind === "agent" && actor.id in ctx.names.sessions ? actor.id : null;
}

function timeOf(ctx: ItemContext, at: string): string {
	return formatLocaleTime(
		at,
		{ hour: "numeric", minute: "2-digit", timeZone: ctx.timeZone },
		ctx.lang,
	);
}

/** The label of a report's space: its project's or session's name, or what kind it is. */
export function useDigestSpaceLabel(): (
	space: Pick<OutlineDigestSpaceView, "kind" | "label">,
) => string {
	const { t } = useTranslation("outline");
	return (space) => {
		if (space.kind === "personal") return t("space.personalMine");
		if (!space.label)
			return t(space.kind === "project" ? "space.projectUnnamed" : "space.sessionUnnamed");
		return t(space.kind === "project" ? "space.project" : "space.session", { name: space.label });
	};
}

const wrap = { overflowWrap: "anywhere", minWidth: 0 } as const;

/**
 * A block's title as the report shows it. A subagent report's container line reads in the
 * reader's language and time zone, as on the page it links to; any other title is as it is.
 */
function blockTitle(ctx: ItemContext, title: string | null): string {
	if (!title) return ctx.t("report.untitled");
	return reportLineDisplay(title, { t: ctx.t as never, locale: ctx.lang }) ?? title;
}

function TitleLink({
	ctx,
	title,
	target,
}: {
	ctx: ItemContext;
	title: string | null;
	target: OutlineTarget | null;
}) {
	const text = blockTitle(ctx, title);
	if (!target)
		return (
			<Text size="sm" fw={500} style={wrap}>
				{text}
			</Text>
		);
	return (
		<Anchor
			component={OutlineLink}
			to={target}
			size="sm"
			fw={500}
			style={wrap}
			onClick={() => ctx.onOpen?.()}
			data-testid="outline-report-block-link"
		>
			{text}
		</Anchor>
	);
}

/** The links of an item besides its title: the page as of the commit, the session. */
function ItemLinks({ ctx, links }: { ctx: ItemContext; links: DigestItemLinks }) {
	if (!links.commit && !links.session) return null;
	return (
		<Group gap="sm" wrap="wrap">
			{links.commit && (
				<Anchor
					component={OutlineHrefLink}
					path={commitPath(links.commit)}
					size="xs"
					onClick={() => ctx.onOpen?.()}
					data-testid="outline-report-commit-link"
				>
					{ctx.t("report.asOf")}
				</Anchor>
			)}
			{links.session && (
				<Anchor
					component={OutlineHrefLink}
					path={sessionPath(links.session)}
					size="xs"
					onClick={() => ctx.onOpen?.()}
					data-testid="outline-report-session-link"
				>
					{ctx.t("report.session")}
				</Anchor>
			)}
		</Group>
	);
}

function ItemRow({
	ctx,
	testId,
	badges,
	title,
	target,
	deleted,
	meta,
	links,
	space,
	body,
	children,
}: {
	ctx: ItemContext;
	testId: string;
	badges: ReactNode;
	title: string | null;
	target: OutlineTarget | null;
	deleted: boolean;
	meta: Array<string | null | false>;
	links: DigestItemLinks;
	/** The item's space id (named when the view shows several spaces). */
	space: string;
	/** Shown under the title (a page's blocks). */
	body?: ReactNode;
	/** Shown last (undo). */
	children?: ReactNode;
}) {
	const line = [ctx.spaceOf(space), ...meta].filter(Boolean).join(" · ");
	return (
		<Paper withBorder p="xs" radius="sm" data-testid={testId} style={{ minWidth: 0 }}>
			<Stack gap={4}>
				<Group gap={6} wrap="wrap" align="center" style={{ minWidth: 0 }}>
					{badges}
					<TitleLink ctx={ctx} title={title} target={target} />
					{deleted && (
						<Badge size="xs" variant="outline" color="gray" tt="none">
							{ctx.t("report.deleted")}
						</Badge>
					)}
				</Group>
				{body}
				{line && (
					<Text size="xs" c="dimmed" style={wrap}>
						{line}
					</Text>
				)}
				<ItemLinks ctx={ctx} links={links} />
				{children}
			</Stack>
		</Paper>
	);
}

function Tag({ color, children }: { color: string; children: ReactNode }) {
	return (
		<Badge size="xs" variant="light" color={color} tt="none">
			{children}
		</Badge>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Undo (Q5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How an outcome is told, exactly once: by moving focus to it (the reader is in this control), in
 * a hidden polite live region (their focus is elsewhere), or by a toast (the drawer's list it is
 * in may go once it is undone).
 */
type Announce = "focus" | "live" | "toast";

type UndoOutcome = (
	| { kind: "undone"; skipped: number }
	| { kind: "refused"; reason: DigestUndoRefusal }
) & { announce: Announce };

/**
 * Undo of a decision made in the reader's name: offered only while the API says it can be (it
 * still stands and the reader may write); asks before it undoes; says why the server refused, in
 * the reader's language. The outcome stays shown while the report is read again around it.
 *
 * Focus: opening the question moves to its explanation (never to the destructive button, so a
 * repeated Enter cannot confirm), Cancel back to Undo. The outcome is told once (`Announce`);
 * focus moves to it only while focus is in this control or nowhere.
 */
export function DecisionUndo({
	commitId,
	spaceId,
	kind,
	stands,
	canUndo,
	onUndone,
}: {
	commitId: string | null;
	spaceId: string;
	kind: OutlineDelegatedKind;
	stands: boolean;
	canUndo: boolean;
	/** It was undone here (the drawer's list it is in may drop it: a toast tells it). */
	onUndone?: () => void;
}) {
	const { t } = useTranslation("outline");
	const undo = useUndoOutlineDecision();
	const [confirming, setConfirming] = useState(false);
	const [outcome, setOutcome] = useState<UndoOutcome | null>(() =>
		wasUndoneHere(commitId) ? { kind: "undone", skipped: 0, announce: "focus" } : null,
	);
	const root = useRef<HTMLDivElement>(null);
	const undoButton = useRef<HTMLButtonElement>(null);
	const explanation = useRef<HTMLParagraphElement>(null);
	const outcomeBox = useRef<HTMLDivElement>(null);
	// Where focus goes once the next render is on screen.
	const focusNext = useRef<"explanation" | "undo" | "outcome" | null>(null);
	useEffect(() => {
		const next = focusNext.current;
		if (!next) return;
		focusNext.current = null;
		const target = next === "explanation" ? explanation : next === "undo" ? undoButton : outcomeBox;
		target.current?.focus();
	});
	/** Focus is in this control, or nowhere: moving it to the outcome takes it from no one. */
	const holdsFocus = () => {
		const active = document.activeElement;
		return !active || active === document.body || (root.current?.contains(active) ?? false);
	};
	const outcomeText = (o: UndoOutcome) =>
		o.kind === "undone"
			? o.skipped > 0
				? t("report.undo.doneSkipped", { count: o.skipped })
				: t("report.undo.done")
			: `${t("report.undo.refused")}: ${t(`report.undo.${o.reason}`)}`;
	const run = () => {
		if (!commitId) return;
		undo.mutate(
			{ commitId, spaceId },
			{
				onSuccess: (result) => {
					const announce: Announce = onUndone ? "toast" : holdsFocus() ? "focus" : "live";
					setOutcome({ kind: "undone", skipped: result.skipped, announce });
					if (announce === "focus") focusNext.current = "outcome";
					if (announce === "toast")
						notifications.show({
							color: "teal",
							title: t("report.undo.done"),
							message: t(`report.kind.${kind}`),
						});
					onUndone?.();
				},
				onError: (error) => {
					const announce: Announce = holdsFocus() ? "focus" : "live";
					setOutcome({ kind: "refused", reason: undoRefusalOf(error), announce });
					if (announce === "focus") focusNext.current = "outcome";
				},
				onSettled: () => setConfirming(false),
			},
		);
	};
	const undone = outcome?.kind === "undone" ? outcome : null;
	const refused = outcome?.kind === "refused" ? outcome : null;
	const offered = !undone && stands && canUndo && commitId !== null;
	return (
		<Stack ref={root} gap={4}>
			{!undone && !stands && (
				<Group>
					<Badge
						size="sm"
						variant="light"
						color="gray"
						tt="none"
						data-testid="outline-report-not-standing"
					>
						{t("report.notStanding")}
					</Badge>
				</Group>
			)}
			{!undone && stands && !offered && !refused && (
				<Text size="xs" c="dimmed" data-testid="outline-report-read-only">
					{t("report.undo.readOnlyHint")}
				</Text>
			)}
			{offered &&
				(confirming ? (
					<Paper withBorder p="xs" radius="sm" data-testid="outline-report-undo-confirm">
						<Text
							ref={explanation}
							tabIndex={-1}
							size="xs"
							style={{ ...wrap, outline: "none" }}
							id={`undo-explain-${commitId}`}
							data-testid="outline-report-undo-explain"
						>
							{t(`report.undo.explain.${kind}`)}
						</Text>
						<Group gap="xs" mt={6} wrap="wrap">
							<Button
								size="compact-xs"
								color="red"
								loading={undo.isPending}
								onClick={run}
								aria-describedby={`undo-explain-${commitId}`}
								data-testid="outline-report-undo-yes"
							>
								{t("report.undo.confirm")}
							</Button>
							<Button
								size="compact-xs"
								variant="subtle"
								color="gray"
								disabled={undo.isPending}
								onClick={() => {
									focusNext.current = "undo";
									setConfirming(false);
								}}
								data-testid="outline-report-undo-cancel"
							>
								{t("report.undo.cancel")}
							</Button>
						</Group>
					</Paper>
				) : (
					<Group>
						<Button
							ref={undoButton}
							size="compact-xs"
							variant="light"
							color="red"
							onClick={() => {
								setOutcome(null);
								focusNext.current = "explanation";
								setConfirming(true);
							}}
							data-testid="outline-report-undo"
						>
							{t("report.undo.button")}
						</Button>
					</Group>
				))}
			{/* What is shown; told by focus or a toast, never by a live role of its own. */}
			<div
				ref={outcomeBox}
				tabIndex={-1}
				style={{ outline: "none" }}
				data-testid="outline-report-undo-outcome"
			>
				{undone && (
					<Badge
						size="sm"
						variant="light"
						color="teal"
						tt="none"
						data-testid="outline-report-undone"
					>
						{outcomeText(undone)}
					</Badge>
				)}
				{refused && (
					<Alert
						role="none"
						color="red"
						variant="light"
						p="xs"
						title={t("report.undo.refused")}
						data-testid="outline-report-undo-refused"
						data-reason={refused.reason}
					>
						<Text size="xs">{t(`report.undo.${refused.reason}`)}</Text>
					</Alert>
				)}
			</div>
			{/* Told here only while the reader's focus is elsewhere. */}
			<VisuallyHidden aria-live="polite" data-testid="outline-report-undo-live">
				{outcome?.announce === "live" ? outcomeText(outcome) : ""}
			</VisuallyHidden>
		</Stack>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Items
// ─────────────────────────────────────────────────────────────────────────────

function DelegatedItem({ ctx, item }: { ctx: ItemContext; item: OutlineDigestDelegatedView }) {
	const { t } = ctx;
	const session = item.session.hidden
		? t("report.actor.hiddenSession")
		: item.session.narratorId
			? item.session.title || t("report.actor.untitledSession")
			: null;
	const links = itemLinks(item.link, { view: "all", deleted: item.deleted });
	return (
		<ItemRow
			ctx={ctx}
			testId={`outline-report-delegated-${item.link.commitId}`}
			space={item.link.spaceId}
			badges={<Tag color="orange">{t(`report.kind.${item.kind}`)}</Tag>}
			title={item.title}
			target={links.block}
			deleted={item.deleted}
			meta={[
				session && t("report.by", { name: session }),
				item.round !== null && t("report.round", { round: item.round }),
				!!item.questions && t("report.questionCount", { count: item.questions }),
				timeOf(ctx, item.at),
			]}
			links={links}
		>
			<DecisionUndo
				commitId={item.link.commitId}
				spaceId={item.link.spaceId}
				kind={item.kind}
				stands={item.stands}
				canUndo={item.canUndo}
			/>
		</ItemRow>
	);
}

function KnowledgeItem({ ctx, item }: { ctx: ItemContext; item: OutlineDigestKnowledgeView }) {
	const { t } = ctx;
	const links = itemLinks(item.link, { deleted: item.deleted });
	return (
		<ItemRow
			ctx={ctx}
			testId={`outline-report-knowledge-${item.link.blockId}`}
			space={item.link.spaceId}
			badges={
				<>
					{item.created > 0 && (
						<Tag color="blue">{t("report.knowledge.created", { count: item.created })}</Tag>
					)}
					{item.changed > 0 && (
						<Tag color="indigo">{t("report.knowledge.changed", { count: item.changed })}</Tag>
					)}
				</>
			}
			title={item.title}
			target={links.block}
			deleted={item.deleted}
			meta={[timeOf(ctx, item.at)]}
			links={links}
			body={
				item.blocks.length > 0 && (
					<Stack
						gap={2}
						pl="xs"
						style={{ borderInlineStart: "2px solid var(--mantine-color-default-border)" }}
					>
						{item.blocks.map((block) => {
							const target = itemLinks(block.link, { deleted: block.deleted }).block;
							return (
								<Group key={block.link.blockId} gap={6} wrap="wrap" style={{ minWidth: 0 }}>
									{target ? (
										<Anchor
											component={OutlineLink}
											to={target}
											size="xs"
											style={wrap}
											onClick={() => ctx.onOpen?.()}
											data-testid="outline-report-block-link"
										>
											{blockTitle(ctx, block.title)}
										</Anchor>
									) : (
										<Text size="xs" style={wrap}>
											{blockTitle(ctx, block.title)}
										</Text>
									)}
									{block.deleted && (
										<Badge size="xs" variant="outline" color="gray" tt="none">
											{t("report.deleted")}
										</Badge>
									)}
								</Group>
							);
						})}
					</Stack>
				)
			}
		/>
	);
}

const TASK_COLOR = {
	reopened: "yellow",
	assigned: "violet",
} as const;

function TaskItem({ ctx, item }: { ctx: ItemContext; item: OutlineDigestTaskView }) {
	const { t } = ctx;
	const links = itemLinks(item.link, { view: "all", deleted: item.deleted });
	const executor = actorName(ctx, item.executor);
	const manager =
		item.manager && item.manager.id !== ctx.readerId ? actorName(ctx, item.manager) : null;
	return (
		<ItemRow
			ctx={ctx}
			testId={`outline-report-task-${item.link.blockId}-${item.link.seq}`}
			space={item.link.spaceId}
			badges={
				<>
					{item.event === "done" || item.event === "cancelled" ? (
						// A task's state: the outline's chip for it (the state's icon, then the words).
						<OutlineStatusChip status={item.event}>
							{t(`report.task.${item.event}`)}
						</OutlineStatusChip>
					) : (
						<Tag color={TASK_COLOR[item.event]}>{t(`report.task.${item.event}`)}</Tag>
					)}
					{item.newlyDoneForYou && (
						<OutlineStatusChip
							status="newly_done"
							variant="filled"
							data-testid="outline-report-newly-done"
						>
							{t("report.task.newlyDone")}
						</OutlineStatusChip>
					)}
					{item.forYou && item.event !== "assigned" && (
						<Tag color="grape">{t("report.task.yours")}</Tag>
					)}
					{item.goal && <Tag color="gray">{t("report.task.goal")}</Tag>}
				</>
			}
			title={item.title}
			target={links.block}
			deleted={item.deleted}
			meta={[
				executor && t("report.task.executor", { name: executor }),
				manager && t("report.task.manager", { name: manager }),
				timeOf(ctx, item.at),
			]}
			links={{ ...links, session: links.session ?? actorSession(ctx, item.executor) }}
		/>
	);
}

function PlanItem({ ctx, item }: { ctx: ItemContext; item: OutlineDigestPlanView }) {
	const { t } = ctx;
	const links = itemLinks(item.link, { view: "all", deleted: item.deleted });
	const session = item.session.hidden
		? t("report.actor.hiddenSession")
		: item.session.narratorId
			? item.session.title || t("report.actor.untitledSession")
			: null;
	const approvedBy = actorName(ctx, item.approvedBy);
	return (
		<ItemRow
			ctx={ctx}
			testId={`outline-report-plan-${item.link.blockId}-${item.link.seq}`}
			space={item.link.spaceId}
			badges={<Tag color="cyan">{t(`report.plan.${item.event}`)}</Tag>}
			title={item.title}
			target={links.block}
			deleted={item.deleted}
			meta={[
				item.round > 0 && t("report.round", { round: item.round }),
				session && t("report.by", { name: session }),
				approvedBy && t("report.plan.approvedBy", { name: approvedBy }),
				timeOf(ctx, item.at),
			]}
			links={links}
		/>
	);
}

function QuestionItem({ ctx, item }: { ctx: ItemContext; item: OutlineDigestQuestionView }) {
	const { t } = ctx;
	const links = itemLinks(item.link, { view: "all", deleted: item.deleted });
	const to =
		!item.toYou && item.to ? (ctx.names.users[item.to] ?? t("report.actor.someone")) : null;
	const by = item.event === "answered" ? actorName(ctx, item.by) : null;
	return (
		<ItemRow
			ctx={ctx}
			testId={`outline-report-question-${item.link.blockId}-${item.link.seq}`}
			space={item.link.spaceId}
			badges={
				<>
					<Tag color="teal">{t(`report.question.${item.event}`)}</Tag>
					{item.toYou && <Tag color="grape">{t("report.question.toYou")}</Tag>}
				</>
			}
			title={item.title}
			target={links.block}
			deleted={item.deleted}
			meta={[
				to && t("report.question.to", { name: to }),
				by && t("report.question.answeredBy", { name: by }),
				item.event === "answered" && item.relayed && t("report.question.relayed"),
				item.event === "answered" &&
					t(item.adopted ? "report.question.adopted" : "report.question.notAdopted"),
				timeOf(ctx, item.at),
			]}
			links={links}
		/>
	);
}

function OtherItem({ ctx, item }: { ctx: ItemContext; item: OutlineDigestOtherView }) {
	const { t } = ctx;
	const links = itemLinks(item.link, { view: "all", deleted: item.deleted });
	const actor = actorName(ctx, item.actor);
	return (
		<ItemRow
			ctx={ctx}
			testId={`outline-report-other-${item.link.spaceId}-${item.link.seq}`}
			space={item.link.spaceId}
			badges={<Tag color="gray">{t(`report.other.${item.event}`)}</Tag>}
			title={item.link.blockId ? item.title : t("report.other.blocks", { count: item.blocks })}
			target={links.block}
			deleted={item.deleted}
			meta={[
				actor && t("report.by", { name: actor }),
				!!item.link.blockId && t("report.other.blocks", { count: item.blocks }),
				timeOf(ctx, item.at),
			]}
			links={{ ...links, session: links.session ?? actorSession(ctx, item.actor) }}
		/>
	);
}

function SectionItems({ ctx, entry }: { ctx: ItemContext; entry: DigestSectionEntry }) {
	switch (entry.section) {
		case "delegated":
			return entry.items.map((item) => (
				<DelegatedItem key={`${item.link.commitId}`} ctx={ctx} item={item} />
			));
		case "knowledge":
			return entry.items.map((item) => (
				<KnowledgeItem key={`${item.link.spaceId}/${item.link.blockId}`} ctx={ctx} item={item} />
			));
		case "tasks":
			return entry.items.map((item) => (
				<TaskItem
					key={`${item.link.blockId}/${item.link.seq}/${item.event}`}
					ctx={ctx}
					item={item}
				/>
			));
		case "plans":
			return entry.items.map((item) => (
				<PlanItem key={`${item.link.blockId}/${item.link.seq}`} ctx={ctx} item={item} />
			));
		case "questions":
			return entry.items.map((item) => (
				<QuestionItem
					key={`${item.link.blockId}/${item.link.seq}/${item.event}`}
					ctx={ctx}
					item={item}
				/>
			));
		case "other":
			return entry.items.map((item) => (
				<OtherItem key={`${item.link.spaceId}/${item.link.seq}`} ctx={ctx} item={item} />
			));
	}
}

const SECTION_COLOR: Record<OutlineDigestSection, string> = {
	delegated: "orange",
	knowledge: "blue",
	tasks: "green",
	plans: "cyan",
	questions: "teal",
	other: "gray",
};

function Section({
	ctx,
	entry,
	compact,
}: {
	ctx: ItemContext;
	entry: DigestSectionEntry;
	compact: boolean;
}) {
	const { t } = ctx;
	return (
		<Stack
			gap={6}
			data-testid={`outline-report-section-${entry.section}`}
			data-count={entry.count}
			style={{ minWidth: 0 }}
		>
			<Group gap={6} wrap="nowrap">
				<Text fw={600} size="sm">
					{t(`report.sections.${entry.section}`)}
				</Text>
				<Badge size="sm" variant="light" color={SECTION_COLOR[entry.section]}>
					{entry.count}
				</Badge>
			</Group>
			{entry.section === "delegated" && !compact && (
				<Text size="xs" c="dimmed">
					{t("report.delegatedIntro")}
				</Text>
			)}
			<SectionItems ctx={ctx} entry={entry} />
			{entry.hidden > 0 && (
				<Text size="xs" c="dimmed" data-testid="outline-report-hidden">
					{t("report.hidden", { count: entry.hidden })}
				</Text>
			)}
		</Stack>
	);
}

export interface OutlineDigestViewProps {
	detail: OutlineDigestDetailResponse;
	/** Only this space's items (the page's filter). */
	spaceId?: string | null;
	/** The inbox row: counts and the first few items of each section, every decision. */
	compact?: boolean;
	/** A link was followed (a drawer closes). */
	onOpen?: () => void;
}

export function OutlineDigestView({
	detail,
	spaceId = null,
	compact = false,
	onOpen,
}: OutlineDigestViewProps) {
	const { t, i18n } = useTranslation("outline");
	const me = useCurrentUser();
	const spaceLabel = useDigestSpaceLabel();
	const model = digestModel(detail, { spaceId, compact });
	const ctx: ItemContext = {
		t,
		names: detail.names,
		readerId: typeof me.data?.id === "string" ? me.data.id : null,
		timeZone: detail.digest.timeZone,
		lang: i18n.language,
		spaceOf: (id) => {
			if (spaceId !== null || detail.spaces.length < 2) return null;
			const space = detail.spaces.find((s) => s.id === id);
			return space ? spaceLabel(space) : null;
		},
		onOpen,
	};
	const { tallies } = model;
	const summary = [
		!compact && tallies.commits > 0 && t("report.tally.commits", { count: tallies.commits }),
		!compact &&
			tallies.tasksCreated > 0 &&
			t("report.tally.tasksCreated", { count: tallies.tasksCreated }),
		!compact &&
			tallies.tasksStarted > 0 &&
			t("report.tally.tasksStarted", { count: tallies.tasksStarted }),
		!compact &&
			tallies.leaseReturned > 0 &&
			t("report.tally.leaseReturned", { count: tallies.leaseReturned }),
		!compact &&
			tallies.deletedFacts > 0 &&
			t("report.tally.deletedFacts", { count: tallies.deletedFacts }),
		!compact &&
			tallies.reviewComments > 0 &&
			t("report.tally.reviewComments", { count: tallies.reviewComments }),
		tallies.ownEdits > 0 && t("report.ownEdits", { count: tallies.ownEdits }),
		model.moreSpaces > 0 && t("report.moreSpaces", { count: model.moreSpaces }),
	].filter(Boolean);
	const listed = model.sections.filter((entry) => entry.count > 0);
	return (
		<Stack
			gap="md"
			style={{ minWidth: 0 }}
			data-testid="outline-report"
			data-report-id={detail.digest.id}
			data-compact={compact ? "true" : "false"}
		>
			{compact && (
				<Group gap={6} wrap="wrap" data-testid="outline-report-counts">
					{model.sections.map((entry) => (
						<Badge
							key={entry.section}
							size="sm"
							variant="light"
							tt="none"
							color={entry.count > 0 ? SECTION_COLOR[entry.section] : "gray"}
							data-section={entry.section}
							data-count={entry.count}
						>
							{t(`report.sections.${entry.section}`)} {entry.count}
						</Badge>
					))}
				</Group>
			)}
			{summary.length > 0 && (
				<Text size="xs" c="dimmed" style={wrap} data-testid="outline-report-summary">
					{summary.join(" · ")}
				</Text>
			)}
			{!compact && tallies.truncated.length > 0 && (
				<Alert color="yellow" variant="light" p="xs" data-testid="outline-report-truncated">
					<Text size="xs" style={wrap}>
						{t("report.truncated", {
							spaces: new Intl.ListFormat(i18n.language, { style: "short" }).format(
								tallies.truncated.map(spaceLabel),
							),
						})}
					</Text>
				</Alert>
			)}
			{listed.length === 0 ? (
				<Text size="sm" c="dimmed" data-testid="outline-report-empty">
					{t(spaceId ? "report.emptySpace" : "report.empty")}
				</Text>
			) : (
				listed.map((entry) => (
					<Section key={entry.section} ctx={ctx} entry={entry} compact={compact} />
				))
			)}
		</Stack>
	);
}

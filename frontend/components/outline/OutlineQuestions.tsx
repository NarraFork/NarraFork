/**
 * Questions put to people (`Ask`, P2 PR 7; design §3.3) and the outline rows of the inbox:
 *
 *   - `OutlineQuestionsForm`: the questions under one block (with their sub-questions), answered at
 *     once. Each open question put to the viewer starts on the asker's recommendation (the
 *     defaults the design asks for); "Adopt all recommendations" answers every one of them with
 *     its recommendation in one request, "Answer" sends what is chosen or written.
 *   - `OutlineQuestionsSection`: that form in the side panel of a focused block, when questions
 *     are under it (an `Ask` card's link opens the block there).
 *   - `OutlineAttentionDetail`: an inbox row of the outline expanded: the questions form, a
 *     change waiting for the person's confirmation (the diff and confirm or reject, from the
 *     pending panel), or the digest row: the latest unread report in short and what agents
 *     confirmed on the person's behalf, each decision undoable (`digest/OutlineDigestInbox.tsx`).
 */
import {
	Alert,
	Badge,
	Button,
	Group,
	Loader,
	Paper,
	Radio,
	Stack,
	Text,
	Textarea,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { HumanAttentionItem } from "@shared/human-attention";
import { parseOriginLabel } from "@shared/message-origin";
import type {
	OutlineAnswerHttpInput,
	OutlineBlockViewResponse,
	OutlineQuestionView,
} from "@shared/outline-api";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useAnswerOutlineQuestions,
	useOutlinePendingDetail,
	useOutlineQuestions,
} from "../../hooks/useOutline";
import { ApiError } from "../../lib/api";
import { formatSmartTime } from "../../lib/format";
import { OpenInOutline } from "./OpenInOutline";
import { OutlineDigestRow } from "./OutlineDigestRow";
import { PendingDetail } from "./OutlinePendingPanel";

type Translate = ReturnType<typeof useTranslation>["t"];

function errorText(error: unknown): string {
	if (error instanceof ApiError) return error.message;
	return error instanceof Error ? error.message : String(error);
}

/** What the viewer has chosen for one question: an option, words, or both. */
interface Draft {
	option: number | null;
	text: string;
}

function hasRecommendation(q: OutlineQuestionView): boolean {
	return q.recommend.option !== null || !!q.recommend.text;
}

function recommendationText(t: Translate, q: OutlineQuestionView): string | null {
	const rec =
		q.recommend.option !== null
			? (q.options[q.recommend.option - 1] ?? `#${q.recommend.option}`)
			: q.recommend.text;
	if (!rec) return null;
	return q.recommend.reason
		? t("questions.recommendedWhy", { choice: rec, reason: q.recommend.reason })
		: t("questions.recommended", { choice: rec });
}

function answerText(t: Translate, q: OutlineQuestionView): string {
	const a = q.answer;
	if (!a) return "";
	const choice = [a.option !== null ? (q.options[a.option - 1] ?? `#${a.option}`) : null, a.text]
		.filter(Boolean)
		.join(" · ");
	const by = a.by.name ?? a.by.userId;
	// Relayed from a gateway or an OAuth client: who actually typed (review N-1).
	const via = a.relayedVia ? parseOriginLabel(a.relayedVia) : null;
	const door = via ? (via.detail ?? via.source ?? via.raw) : null;
	return t(
		a.relayed
			? door
				? "questions.answeredRelayedVia"
				: "questions.answeredRelayed"
			: "questions.answeredBy",
		{ choice: choice || t("questions.theRecommendation"), name: by, via: door },
	);
}

function QuestionCard({
	q,
	sub,
	draft,
	onDraft,
	busy,
}: {
	q: OutlineQuestionView;
	/** A sub-question of the question above it. */
	sub: boolean;
	draft: Draft | undefined;
	onDraft: (draft: Draft) => void;
	busy: boolean;
}) {
	const { t } = useTranslation("outline");
	const rec = recommendationText(t, q);
	return (
		<Paper
			withBorder
			p="xs"
			ml={sub ? "md" : 0}
			data-testid={`outline-question-${q.blockId}`}
			data-state={q.state}
		>
			<Stack gap={6}>
				<Group gap={6} wrap="nowrap" align="flex-start">
					{q.alias && (
						<Badge size="xs" variant="light" color="teal">
							{q.alias}
						</Badge>
					)}
					<Text size="sm" fw={500} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
						{q.text}
					</Text>
				</Group>
				<Text size="xs" c="dimmed">
					{[
						q.to.name ? t("questions.askedOf", { name: q.to.name }) : null,
						q.askedBy.hidden
							? t("questions.askedByHidden")
							: q.askedBy.title
								? t("questions.askedBy", { title: q.askedBy.title })
								: null,
						q.createdAt ? formatSmartTime(q.createdAt) : null,
						q.proceed ? t("questions.proceeded") : null,
					]
						.filter(Boolean)
						.join(" · ")}
				</Text>
				{rec && (
					<Text size="xs" c="teal" data-testid="outline-question-recommendation">
						{rec}
					</Text>
				)}
				{q.state !== "open" ? (
					<Badge
						size="sm"
						variant="light"
						color={q.state === "answered" ? "green" : "gray"}
						style={{ alignSelf: "flex-start", textTransform: "none" }}
						data-testid="outline-question-answer"
					>
						{q.state === "answered" ? answerText(t, q) : t("questions.withdrawn")}
					</Badge>
				) : draft ? (
					<Stack gap={4}>
						{q.options.length > 0 && (
							<Radio.Group
								value={draft.option === null ? "" : String(draft.option)}
								onChange={(value) => onDraft({ ...draft, option: value ? Number(value) : null })}
							>
								<Stack gap={4}>
									{q.options.map((option, i) => (
										<Radio
											// Two choices may read the same (review N9).
											// biome-ignore lint/suspicious/noArrayIndexKey: the choices are positional
											key={i}
											size="xs"
											value={String(i + 1)}
											disabled={busy}
											data-testid={`outline-question-option-${i + 1}`}
											label={
												i + 1 === q.recommend.option
													? `${option} ${t("questions.recommendedMark")}`
													: option
											}
										/>
									))}
								</Stack>
							</Radio.Group>
						)}
						<Textarea
							size="xs"
							autosize
							minRows={1}
							maxRows={4}
							disabled={busy}
							placeholder={
								q.options.length > 0
									? t("questions.notePlaceholder")
									: (q.recommend.text ?? t("questions.answerPlaceholder"))
							}
							value={draft.text}
							onChange={(e) => onDraft({ ...draft, text: e.currentTarget.value })}
							data-testid="outline-question-text"
						/>
					</Stack>
				) : (
					<Text size="xs" c="dimmed">
						{t("questions.waitingFor", { name: q.to.name ?? q.to.userId ?? "?" })}
					</Text>
				)}
			</Stack>
		</Paper>
	);
}

/**
 * The questions under `blockId`, answered at once. `onOpen` runs when the person follows the link
 * into the outline (the inbox closes then).
 */
export function OutlineQuestionsForm({
	blockId,
	onOpen,
	showOpenLink = true,
}: {
	blockId: string;
	onOpen?: () => void;
	showOpenLink?: boolean;
}) {
	const { t } = useTranslation("outline");
	const query = useOutlineQuestions(blockId);
	const group = query.data;
	const answer = useAnswerOutlineQuestions(group?.group.spaceId ?? null);
	const answerable = useMemo(() => (group?.questions ?? []).filter((q) => q.canAnswer), [group]);
	const ids = useMemo(() => new Set((group?.questions ?? []).map((q) => q.blockId)), [group]);
	const [drafts, setDrafts] = useState<Record<string, Draft>>({});
	const draftOf = (q: OutlineQuestionView): Draft =>
		drafts[q.blockId] ?? { option: q.recommend.option, text: "" };

	if (query.isLoading) return <Loader size="xs" />;
	if (query.isError || !group)
		return (
			<Alert color="red" variant="light">
				<Text size="xs">{query.error ? errorText(query.error) : t("questions.loadFailed")}</Text>
			</Alert>
		);
	if (group.questions.length === 0)
		return (
			<Text size="xs" c="dimmed">
				{t("questions.none")}
			</Text>
		);

	const send = (adoptAll: boolean) => {
		const answers = answerable.flatMap((q): OutlineAnswerHttpInput[] => {
			// The version read goes with each answer: a question changed since is refused (S3).
			const adopt: OutlineAnswerHttpInput[] = hasRecommendation(q)
				? [{ blockId: q.blockId, adopt: true, versionSeq: q.versionSeq }]
				: [];
			if (adoptAll) return adopt;
			const d = draftOf(q);
			const text = d.text.trim();
			if (d.option === null && !text) return adopt;
			return [
				{
					blockId: q.blockId,
					...(d.option !== null ? { option: d.option } : {}),
					...(text ? { text } : {}),
					versionSeq: q.versionSeq,
				},
			];
		});
		if (answers.length === 0) {
			notifications.show({ color: "yellow", message: t("questions.nothingToSend") });
			return;
		}
		answer.mutate(answers, {
			onSuccess: (done) =>
				notifications.show({
					color: "green",
					message: t("questions.answered", { count: done.answered.length }),
				}),
			onError: (error) => {
				// Changed since it was read: the group is read again (the mutation refreshes it) and
				// the choices start over from what it says now.
				if (error instanceof ApiError && error.data?.code === "OUTLINE_QUESTION_CHANGED") {
					setDrafts({});
					notifications.show({
						color: "yellow",
						title: t("questions.changedTitle"),
						message: errorText(error),
					});
					return;
				}
				notifications.show({
					color: "red",
					title: t("questions.answerFailed"),
					message: errorText(error),
				});
			},
		});
	};
	const withRecommendation = answerable.filter(hasRecommendation).length;

	return (
		<Stack gap="xs" data-testid="outline-questions" data-block-id={blockId}>
			<Group justify="space-between" gap="xs" wrap="nowrap">
				<Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>
					{group.group.isQuestion
						? t("questions.single")
						: t("questions.under", { title: group.group.title || group.group.blockId })}
				</Text>
				{showOpenLink && (
					<OpenInOutline
						spaceId={group.group.spaceId}
						blockId={group.group.blockId}
						onOpen={onOpen}
					/>
				)}
			</Group>
			{group.questions.map((q) => (
				<QuestionCard
					key={q.blockId}
					q={q}
					sub={q.parentId !== null && ids.has(q.parentId)}
					draft={q.canAnswer ? draftOf(q) : undefined}
					onDraft={(d) => setDrafts((all) => ({ ...all, [q.blockId]: d }))}
					busy={answer.isPending}
				/>
			))}
			{group.truncated && (
				<Text size="xs" c="dimmed">
					{t("questions.truncated")}
				</Text>
			)}
			{answerable.length > 0 && (
				<Group gap="xs">
					<Button
						size="compact-sm"
						color="teal"
						disabled={withRecommendation === 0}
						loading={answer.isPending && answer.variables?.every((a) => "adopt" in a && a.adopt)}
						onClick={() => send(true)}
						data-testid="outline-questions-adopt-all"
					>
						{t("questions.adoptAll", { count: withRecommendation })}
					</Button>
					<Button
						size="compact-sm"
						variant="light"
						loading={answer.isPending}
						onClick={() => send(false)}
						data-testid="outline-questions-submit"
					>
						{t("questions.submit")}
					</Button>
				</Group>
			)}
		</Stack>
	);
}

/** The questions under the focused block, in its side panel, when there are any. */
export function OutlineQuestionsSection({ view }: { view: OutlineBlockViewResponse }) {
	const { t } = useTranslation("outline");
	const root = view.blocks.find((b) => b.id === view.rootId);
	// A question itself, or a block with questions (or tasks: they may hold some) under it.
	const maybe = !!root && (!!root.question || root.openTasks > 0 || root.childIds.length > 0);
	const query = useOutlineQuestions(view.current && maybe ? view.rootId : null);
	if (!query.data || query.data.questions.length === 0) return null;
	return (
		<Paper withBorder p="xs" mb="xs" data-testid="outline-questions-section">
			<Text size="xs" fw={600} mb={6}>
				{t("questions.title")}
			</Text>
			<OutlineQuestionsForm blockId={view.rootId} showOpenLink={false} />
		</Paper>
	);
}

/** A change waiting for the person's confirmation: its diff, confirm and reject. */
function OutlinePendingAttention({
	spaceId,
	pendingId,
	blockId,
	onOpen,
}: {
	spaceId: string;
	pendingId: string;
	blockId: string | null;
	onOpen?: () => void;
}) {
	const detail = useOutlinePendingDetail(pendingId);
	if (detail.isLoading) return <Loader size="xs" />;
	if (!detail.data) return null;
	return (
		<Stack gap={4}>
			{blockId && <OpenInOutline spaceId={spaceId} blockId={blockId} onOpen={onOpen} />}
			<PendingDetail spaceId={spaceId} summary={detail.data.pending} />
		</Stack>
	);
}

/** An outline row of the inbox, expanded. */
export function OutlineAttentionDetail({
	item,
	onOpen,
}: {
	item: HumanAttentionItem;
	onOpen?: () => void;
}) {
	const ref = item.outline;
	if (!ref) return null;
	if (ref.what === "questions" && ref.blockId)
		return <OutlineQuestionsForm blockId={ref.blockId} onOpen={onOpen} />;
	if (ref.what === "pending" && ref.pendingId && ref.spaceId)
		return (
			<OutlinePendingAttention
				spaceId={ref.spaceId}
				pendingId={ref.pendingId}
				blockId={ref.blockId}
				onOpen={onOpen}
			/>
		);
	if (ref.what === "digest")
		return <OutlineDigestRow reportIds={ref.reportIds ?? []} onOpen={onOpen} />;
	return null;
}

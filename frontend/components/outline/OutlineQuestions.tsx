/** One answering surface for messages, outline pages and the notification inbox. */
import { Alert, Button, Group, Loader, Paper, Radio, Stack, Text, Textarea } from "@mantine/core";
import type { HumanAttentionItem } from "@shared/human-attention";
import { parseOriginLabel } from "@shared/message-origin";
import type { OutlineBlockViewResponse, OutlineQuestionView } from "@shared/outline-api";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useAnswerOutlineQuestions,
	useOutlinePendingDetail,
	useOutlineQuestionGroups,
	useOutlineQuestions,
	useOutlineQuestionsLive,
} from "../../hooks/useOutline";
import { ApiError } from "../../lib/api";
import { OpenInOutline } from "./OpenInOutline";
import { OutlineDigestRow } from "./OutlineDigestRow";
import { PendingDetail } from "./OutlinePendingPanel";
import {
	type OutlineAnswerDraft,
	outlineAnswerInput,
	useOutlineAnswerDrafts,
} from "./outline-answer-draft";

type Translate = ReturnType<typeof useTranslation>["t"];

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function answerText(t: Translate, q: OutlineQuestionView): string {
	const a = q.answer;
	if (!a) return "";
	const choice = [a.option !== null ? (q.options[a.option - 1] ?? `#${a.option}`) : null, a.text]
		.filter(Boolean)
		.join(" · ");
	const via = a.relayedVia ? parseOriginLabel(a.relayedVia) : null;
	const door = via ? (via.detail ?? via.source ?? via.raw) : null;
	return t(
		a.relayed
			? door
				? "questions.answeredRelayedVia"
				: "questions.answeredRelayed"
			: "questions.answeredBy",
		{
			choice: choice || t("questions.theRecommendation"),
			name: a.by.name ?? a.by.userId,
			via: door,
		},
	);
}

function QuestionCard({
	q,
	sub,
	draft,
	onDraft,
	busy,
	hideTitle,
}: {
	q: OutlineQuestionView;
	sub: boolean;
	draft: OutlineAnswerDraft | undefined;
	onDraft: (draft: OutlineAnswerDraft) => void;
	busy: boolean;
	hideTitle: boolean;
}) {
	const { t } = useTranslation("outline");
	const custom = !!draft?.text.trim();
	return (
		<Stack
			gap="xs"
			ml={sub ? "md" : 0}
			data-testid={`outline-question-${q.blockId}`}
			data-state={q.state}
		>
			{!hideTitle && (
				<Text size="sm" fw={500} style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
					{q.text}
				</Text>
			)}
			{q.state !== "open" ? (
				<Text
					size="sm"
					c={q.state === "answered" ? "teal" : "dimmed"}
					style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
					data-testid="outline-question-answer"
				>
					{q.state === "answered" ? answerText(t, q) : t("questions.withdrawn")}
				</Text>
			) : draft ? (
				<>
					{q.proceed && (
						<Text size="xs" c="dimmed">
							{t("questions.proceeded")}
						</Text>
					)}
					{q.options.length > 0 && (
						<Radio.Group
							value={custom || draft.option === null ? "" : String(draft.option)}
							onChange={(value) => onDraft({ ...draft, option: Number(value) })}
							aria-label={q.text}
						>
							<Stack gap="xs">
								{q.options.map((option, i) => (
									<Radio
										// biome-ignore lint/suspicious/noArrayIndexKey: options are positional
										key={i}
										size="sm"
										value={String(i + 1)}
										disabled={busy || custom}
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
					{(q.recommend.text || q.recommend.reason) && (
						<Text size="xs" c="dimmed" data-testid="outline-question-recommendation">
							{q.recommend.text ? t("questions.recommended", { choice: q.recommend.text }) : null}
							{q.recommend.text && q.recommend.reason ? " · " : null}
							{q.recommend.reason}
						</Text>
					)}
					<Textarea
						size="sm"
						autosize
						minRows={1}
						maxRows={8}
						disabled={busy}
						placeholder={t(
							q.options.length ? "questions.notePlaceholder" : "questions.answerPlaceholder",
						)}
						aria-label={t("questions.answerPlaceholder")}
						value={draft.text}
						onChange={(e) => onDraft({ ...draft, text: e.currentTarget.value })}
						data-testid="outline-question-text"
					/>
				</>
			) : (
				<Text size="xs" c="dimmed">
					{t("questions.waitingFor", { name: q.to.name ?? q.to.userId ?? "?" })}
				</Text>
			)}
		</Stack>
	);
}

export function OutlineQuestionsForm({
	blockId,
	questionRootIds,
	questionIds,
	readOnly = false,
	onOpen,
	showOpenLink = true,
	hideQuestionTitle = false,
}: {
	blockId: string;
	questionRootIds?: readonly string[];
	questionIds?: readonly string[];
	readOnly?: boolean;
	onOpen?: () => void;
	showOpenLink?: boolean;
	hideQuestionTitle?: boolean;
}) {
	const { t } = useTranslation("outline");
	const queries = useOutlineQuestionGroups(questionRootIds ?? [blockId]);
	const groups = queries.flatMap((query) => (query.data ? [query.data] : []));
	useOutlineQuestionsLive(groups);
	const group = groups[0]?.group;
	const questions = [
		...new Map(groups.flatMap((g) => g.questions).map((q) => [q.blockId, q])).values(),
	].filter((q) => !questionIds || questionIds.includes(q.blockId));
	const answerable = questions.filter((q) => q.canAnswer && q.state === "open" && !readOnly);
	const answer = useAnswerOutlineQuestions(group?.spaceId ?? null);
	const drafts = useOutlineAnswerDrafts(answerable.map((q) => q.blockId));
	const [submitError, setSubmitError] = useState<string | null>(null);
	const inputs = answerable.map((q) => outlineAnswerInput(q, drafts.get(q.blockId)));
	const canSubmit = inputs.length > 0 && inputs.every((a) => a !== null);
	const busy = answer.isPending;
	const loading = queries.some((q) => q.isLoading);
	const loadError = queries.find((q) => q.isError)?.error;
	if (loading) return <Loader size="xs" />;
	if (!group || (loadError && groups.length !== queries.length))
		return (
			<Alert color="red" variant="light">
				{loadError ? errorText(loadError) : t("questions.loadFailed")}
			</Alert>
		);
	if (questions.length === 0) return null;

	const send = () => {
		if (!canSubmit || busy) return;
		const answers = inputs.filter((a) => a !== null);
		setSubmitError(null);
		answer.mutate(answers, {
			onSuccess: (done) => {
				drafts.clear(done.answered);
			},
			onError: (error) => {
				const changed =
					error instanceof ApiError && error.data?.code === "OUTLINE_QUESTION_CHANGED";
				// A changed option order must not silently change the meaning; keep all authored text.
				if (changed) drafts.resetChoices(answerable.map((q) => q.blockId));
				setSubmitError(changed ? t("questions.changedTitle") : errorText(error));
			},
		});
	};
	const ids = new Set(questions.map((q) => q.blockId));
	return (
		<Stack gap="md" data-testid="outline-questions" data-block-id={blockId}>
			{questions.map((q) => (
				<QuestionCard
					key={q.blockId}
					q={q}
					sub={q.parentId !== null && ids.has(q.parentId)}
					draft={answerable.includes(q) ? drafts.get(q.blockId) : undefined}
					onDraft={(draft) =>
						drafts.change(q.blockId, { ...draft, versionSeq: draft.versionSeq ?? q.versionSeq })
					}
					busy={busy}
					hideTitle={hideQuestionTitle && q.blockId === blockId}
				/>
			))}
			{groups.some((g) => g.truncated) && (
				<Text size="xs" c="dimmed">
					{t("questions.truncated")}
				</Text>
			)}
			{submitError && (
				<Text size="xs" c="red" role="alert">
					{submitError}
				</Text>
			)}
			{(answerable.length > 0 || showOpenLink) && (
				<Group gap="xs" justify="space-between">
					{answerable.length > 0 && (
						<Button
							size="xs"
							disabled={!canSubmit || busy}
							loading={busy}
							onClick={send}
							data-testid="outline-questions-submit"
						>
							{t("questions.submit")}
						</Button>
					)}
					{showOpenLink && (
						<OpenInOutline spaceId={group.spaceId} blockId={group.blockId} onOpen={onOpen} />
					)}
				</Group>
			)}
		</Stack>
	);
}

/** Questions are part of the outline's body, not hidden in its auxiliary side panel. */
export function OutlineQuestionsSection({
	view,
	hideQuestionTitle = false,
}: {
	view: OutlineBlockViewResponse;
	hideQuestionTitle?: boolean;
}) {
	const root = view.blocks.find((b) => b.id === view.rootId);
	const maybe = !!root && (!!root.question || root.openTasks > 0 || root.childIds.length > 0);
	const query = useOutlineQuestions(view.current && maybe ? view.rootId : null);
	if (!view.current || !query.data?.questions.length) return null;
	return (
		<Paper withBorder p="sm" my="sm" data-testid="outline-questions-section">
			<OutlineQuestionsForm
				blockId={view.rootId}
				showOpenLink={false}
				hideQuestionTitle={hideQuestionTitle}
			/>
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

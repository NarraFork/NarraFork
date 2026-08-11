/**
 * SideCarNotice.tsx — System injections (side-cars), on the CHUNKED render path.
 *
 * The visual counterpart of the exact list's `RenderSidecar`. Same story, told with
 * CSS flow instead of measured geometry: a footnote per injection — no card, no
 * border, no background, no accent rail — with the source name carrying one of three
 * tones and the structured body indented beneath it.
 *
 * ## What changed, and why it is not just a restyle
 *
 * It used to aggregate: ONE "System injections ×N" header that unfolded into a list
 * of coloured `Paper` cards, each with an info icon, a source badge, a raw
 * `tool_result` / `user_message` badge and a whitespace-collapsed preview. Three
 * problems, all fixed here:
 *
 *   - Aggregation forced all-or-nothing reading. A turn can inject a progress
 *     reminder, a finished background task and a teammate's message at once; folding
 *     them together means opening all three to read one. Each is now its own footnote
 *     with its own fold.
 *   - The skin was the heaviest in the list (solid tint + 2px rail) around the least
 *     important content, in one of six hues.
 *   - The `target` badge painted a raw machine field the reader has no use for — its
 *     position on the card already says where it is attached.
 *
 * ## Structure comes from the producer, not from parsing
 *
 * The body is projected by `presentSideCarBody` from the structured `SideCarBody` the
 * server now emits, so the reader sees real lines (a task digest's entries as
 * bullets, a sender as a heading) instead of the model-facing string — XML wrappers,
 * `[System]` prefixes and instruction boilerplate included. A row written before
 * bodies existed has none, and is shown VERBATIM (`presentRawSideCar`); there is
 * deliberately no parsing that tries to recover structure from an old string.
 *
 * Both paths share the projection with the exact list, so the two never drift.
 */

import {
	ActionIcon,
	Box,
	CopyButton,
	Group,
	Stack,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import {
	presentRawSideCar,
	presentSideCarBody,
	readSideCarBody,
	type SideCarLine,
	type SideCarPresentation,
	type SideCarTone,
} from "@shared/sidecar-body";
import { IconCheck, IconChevronDown, IconChevronRight, IconCopy } from "@tabler/icons-react";
import { memo, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SideCarRecord } from "../../lib/api";

/** Cap on the verbatim body of an unstructured (historical) row. */
const SIDECAR_RAW_MAX_CHARS = 120_000;
/** Body lines an `open` footnote shows before it needs asking (mirrors the vlist). */
const INLINE_MAX_LINES = 10;

/**
 * True when at least one side-car has non-empty content.
 *
 * Call sites use this to skip rendering entirely, avoiding this component's hooks for
 * the common null case (most messages and tools have no injections). `content` stays
 * the emptiness test even for structured rows: it is the one field every producer
 * sets, and an injection with no text was never shown to the model either.
 */
export function hasVisibleSideCars(sideCars?: SideCarRecord[] | null): boolean {
	if (!sideCars || sideCars.length === 0) return false;
	for (const sideCar of sideCars) {
		if (sideCar.content?.trim()) return true;
	}
	return false;
}

/** Tone → the colour of the source NAME (three groups, not one hue per source). */
function toneColor(tone: SideCarTone): string {
	switch (tone) {
		case "peer":
			return "var(--mantine-color-grape-text)";
		case "background":
			return "var(--mantine-color-blue-text)";
		default:
			return "var(--mantine-color-dimmed)";
	}
}

/** Source tag → i18n key under `sidecar.sources.*`. */
const SOURCE_LABEL_KEYS: Record<string, string> = {
	silent_progress: "silent_progress",
	todo_reminder: "todo_reminder",
	living_work_spec: "todo_reminder",
	relaxed_plan: "relaxed_plan",
	knowledge_base_hint: "knowledge_base_hint",
	bg_agent: "bg_agent",
	bg_bash: "bg_bash",
	team_message: "team_message",
	buffered_user: "buffered_user",
	group_message: "group_message",
	subagent_message: "subagent_message",
	spec_update: "spec_update",
	// Both pushed by the server since forever, neither mapped until now — they used to
	// render as their raw snake_case tags.
	behavior_fence: "behavior_fence",
	pipeline_exit_confirmation: "pipeline_exit_confirmation",
};

function sourceLabel(t: (key: string) => string, source: string): string {
	const key = SOURCE_LABEL_KEYS[source];
	if (key) return t(`sidecar.sources.${key}`);
	return source || t("sidecar.unknownSource");
}

function sideCarKey(sideCar: SideCarRecord, index: number): string {
	return [sideCar.id, sideCar.source, sideCar.toolUseId ?? "message", sideCar.orderIndex ?? index]
		.filter((part) => part !== undefined && part !== null)
		.join(":");
}

/** Cap a raw body, appending the localized truncation label as its last line. */
function rawText(content: string, truncatedLabel: string): string {
	if (content.length <= SIDECAR_RAW_MAX_CHARS) return content;
	return `${content.slice(0, SIDECAR_RAW_MAX_CHARS)}\n\n${truncatedLabel}`;
}

/**
 * The reader-facing copy for `presentSideCarBody`.
 *
 * Deliberately NOT the model-facing wording (which lives in `server/lib/i18n.ts`):
 * the model is told "keep tasks.json to only text/status/protected…", the reader is
 * told "3 open tasks". Same keys the exact list injects, from the same JSON.
 */
function usePresentationLabels(t: (key: string, params?: Record<string, unknown>) => string) {
	return useMemo<Record<string, string>>(
		() => ({
			noticeSilentProgress: t("sidecar.body.noticeSilentProgress", { count: "{count}" }),
			noticeRelaxedPlan: t("sidecar.body.noticeRelaxedPlan"),
			noticePipelineExit: t("sidecar.body.noticePipelineExit"),
			tasksCurrent: t("sidecar.body.tasksCurrent", { n: "{n}" }),
			tasksEmptyNever: t("sidecar.body.tasksEmptyNever"),
			tasksEmptyDone: t("sidecar.body.tasksEmptyDone"),
			tasksTooMany: t("sidecar.body.tasksTooMany", { n: "{n}" }),
			taskRoleDoing: t("sidecar.body.taskRoleDoing"),
			taskRoleNext: t("sidecar.body.taskRoleNext"),
			taskRoleTodo: t("sidecar.body.taskRoleTodo"),
			taskRoleBlocked: t("sidecar.body.taskRoleBlocked"),
			taskProtected: t("sidecar.body.taskProtected"),
			knowledgeHeading: t("sidecar.body.knowledgeHeading", { n: "{n}" }),
			tasksDoneAgentHeading: t("sidecar.body.tasksDoneAgentHeading", { n: "{n}" }),
			tasksDoneBashHeading: t("sidecar.body.tasksDoneBashHeading", { n: "{n}" }),
			tasksDoneTruncated: t("sidecar.body.tasksDoneTruncated"),
			messagesHeading: t("sidecar.body.messagesHeading", { n: "{n}" }),
			messageFromUnknown: t("sidecar.body.messageFromUnknown"),
			messageBroadcast: t("sidecar.body.messageBroadcast"),
			specUpdatesHeading: t("sidecar.body.specUpdatesHeading", { n: "{n}" }),
			proseFenceHeading: t("sidecar.body.proseFenceHeading"),
			empty: t("sidecar.body.empty"),
		}),
		[t],
	);
}

/** One body line. `bullet` markers are aria-hidden + unselectable (copy hygiene). */
function BodyLine({ line }: { line: SideCarLine }) {
	const color =
		line.kind === "heading" ? "var(--mantine-color-text)" : "var(--mantine-color-dimmed)";
	return (
		<Group gap={4} wrap="nowrap" align="flex-start" style={{ opacity: line.dimmed ? 0.75 : 1 }}>
			{line.kind === "bullet" ? (
				<Text
					aria-hidden
					size="xs"
					c="dimmed"
					style={{ flexShrink: 0, opacity: 0.6, userSelect: "none", lineHeight: 1.4 }}
				>
					·
				</Text>
			) : null}
			<Text
				size="xs"
				c={color}
				fw={line.kind === "heading" ? 500 : undefined}
				style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", minWidth: 0, flex: 1 }}
			>
				{line.text}
			</Text>
		</Group>
	);
}

/** One injection, as a footnote. */
function SideCarFootnote({ sideCar, detail }: { sideCar: SideCarRecord; detail?: boolean }) {
	const { t } = useTranslation("narrator");
	const labels = usePresentationLabels(t as never);
	const content = sideCar.content ?? "";
	const presentation: SideCarPresentation = useMemo(() => {
		const body = readSideCarBody(sideCar);
		return body
			? presentSideCarBody(sideCar.source, body, labels)
			: presentRawSideCar(sideCar.source, rawText(content, t("sidecar.truncated")));
	}, [sideCar, content, labels, t]);

	// `detail` (the inspector view) shows everything; otherwise the tone decides
	// whether the body starts visible. A folded footnote opens on click; an `open`
	// one only needs a toggle when its body was capped.
	const [opened, setOpened] = useState(detail === true);
	const isOpenForm = presentation.form === "open";
	const capped = !detail && isOpenForm && presentation.lines.length > INLINE_MAX_LINES;
	const showsBody = detail === true || opened || isOpenForm;
	const visibleLines =
		showsBody && capped && !opened
			? presentation.lines.slice(0, INLINE_MAX_LINES)
			: presentation.lines;
	const foldable =
		!detail && presentation.lines.length > 0 && (presentation.form === "folded" || capped);

	const label = sourceLabel(t, sideCar.source);
	const nameColor = toneColor(presentation.tone);
	const header = (
		<Group gap={6} wrap="nowrap" align="center">
			<Text size="xs" fw={500} c={nameColor} style={{ flexShrink: 0 }}>
				{label}
			</Text>
			{/* The headline stands in for a hidden body. When the body shows, repeating
			    its first line above it would be noise. */}
			{!showsBody ? (
				<Text size="xs" c="dimmed" lineClamp={1} style={{ flex: 1, minWidth: 0 }}>
					{presentation.headline}
				</Text>
			) : (
				<Box style={{ flex: 1, minWidth: 0 }} />
			)}
			{/* Copy yields what the MODEL saw, not this projection. */}
			<CopyButton value={content} timeout={1500}>
				{({ copied, copy }) => (
					<Tooltip label={copied ? t("sidecar.copied") : t("sidecar.copy")}>
						<ActionIcon
							variant="subtle"
							color={copied ? "green" : "gray"}
							size="xs"
							aria-label={copied ? t("sidecar.copied") : t("sidecar.copy")}
							onClick={(event) => {
								event.stopPropagation();
								copy();
							}}
						>
							{copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
						</ActionIcon>
					</Tooltip>
				)}
			</CopyButton>
			{foldable ? (
				opened ? (
					<IconChevronDown size={12} style={{ flexShrink: 0, opacity: 0.6 }} />
				) : (
					<IconChevronRight size={12} style={{ flexShrink: 0, opacity: 0.6 }} />
				)
			) : null}
		</Group>
	);

	return (
		<Box>
			{foldable ? (
				<UnstyledButton
					onClick={(event) => {
						event.stopPropagation();
						setOpened((value) => !value);
					}}
					style={{ width: "100%" }}
					aria-expanded={opened}
					aria-label={label}
				>
					{header}
				</UnstyledButton>
			) : (
				header
			)}
			{showsBody && visibleLines.length > 0 ? (
				<Stack gap={2} pl={10} mt={2}>
					{visibleLines.map((line, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: projected lines are a stable ordered list derived from this record's body
						<BodyLine key={index} line={line} />
					))}
				</Stack>
			) : null}
		</Box>
	);
}

const SideCarNoticeImpl = function SideCarNotice({
	sideCars,
	mode = "inline",
}: {
	sideCars?: SideCarRecord[] | null;
	mode?: "inline" | "detail";
	/**
	 * Retained for call-site compatibility. The aggregate wrapper this used to open
	 * is gone (each record folds on its own), so it no longer has anything to do.
	 */
	initiallyOpen?: boolean;
}) {
	const visibleSideCars = useMemo(
		() => (sideCars ?? []).filter((sideCar) => sideCar.content?.trim()),
		[sideCars],
	);
	if (visibleSideCars.length === 0) return null;

	return (
		<Stack gap={4} mt={6} onClick={(event) => event.stopPropagation()}>
			{visibleSideCars.map((sideCar, index) => (
				<SideCarFootnote
					key={sideCarKey(sideCar, index)}
					sideCar={sideCar}
					detail={mode === "detail"}
				/>
			))}
		</Stack>
	);
};

export const SideCarNotice = memo(SideCarNoticeImpl);

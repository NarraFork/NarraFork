/**
 * SystemInjectionNotice.tsx — reader-facing card for server-authored injected
 * content (`system_injection`), in the chunked message path.
 *
 * ## What it renders and why not the row's text
 *
 * An injection row carries two projections of one truth (see
 * `server/services/narrator-injection.ts`):
 *
 *   - a `text` block — the MODEL-facing copy, instruction boilerplate included
 *     ("keep tasks.json to only text/status/protected", "do not add IDs…")
 *   - a `system_injection` block holding the STRUCTURED body
 *
 * This card renders the second. Showing the first is what made the retired side-car
 * cards shout prompt engineering at the reader; `sideCarBodyToMarkdown` drops it and
 * keeps only what is worth reading.
 *
 * The projection runs HERE rather than on the server because the reader-facing wording
 * lives in this side's message tables (`sidecar.body.*`). Projecting at write time
 * would freeze a translation into the row forever.
 *
 * Visually this is deliberately the same low-contrast card as `SystemOriginNotice`
 * (`Paper p="xs"` + xs dimmed text): an injection is a note inside the conversation,
 * not a participant in it. The vlist path reaches the same result through the
 * `origin_notice` measured kind.
 */

import { Group, Paper, Text } from "@mantine/core";
import {
	rawSideCarToMarkdown,
	type SideCarBody,
	sideCarBodyToMarkdown,
} from "@shared/sidecar-body";
import { IconInfoCircle } from "@tabler/icons-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { MarkdownContent } from "./MarkdownContent";

const SYSTEM_MESSAGE_BG = "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))";

/**
 * Producer tag → its `sidecar.sources.*` message key.
 *
 * Reuses the keys the side-car cards already resolve, so a producer needs no new copy
 * to migrate and the two cannot disagree on its name while both exist.
 */
const SOURCE_LABEL_KEYS: Record<string, string> = {
	silent_progress: "silent_progress",
	living_work_spec: "todo_reminder",
	relaxed_plan: "relaxed_plan",
	knowledge_base_hint: "knowledge_base_hint",
	bg_agent: "bg_agent",
	bg_bash: "bg_bash",
	team_message: "team_message",
	buffered_user: "buffered_user",
	subagent_message: "subagent_message",
	spec_update: "spec_update",
	behavior_fence: "behavior_fence",
	pipeline_exit_confirmation: "pipeline_exit_confirmation",
};

/** Today → `HH:mm`, otherwise `MM/DD HH:mm`. Mirrors SystemOriginNotice. */
function formatNoticeTime(createdAt: string): string {
	const d = new Date(createdAt);
	if (Number.isNaN(d.getTime())) return "";
	const now = new Date();
	const isToday =
		d.getFullYear() === now.getFullYear() &&
		d.getMonth() === now.getMonth() &&
		d.getDate() === now.getDate();
	const pad = (n: number) => String(n).padStart(2, "0");
	const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	return isToday ? time : `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${time}`;
}

export function SystemInjectionNotice({
	source,
	body,
	fallbackText,
	createdAt,
}: {
	source: string;
	body?: SideCarBody;
	/**
	 * The row's model-facing text, used only when the producer supplied no structured
	 * body. Shown verbatim — deliberately never parsed, because guessing at a
	 * producer's discarded structure is the complexity this redesign removes.
	 */
	fallbackText: string;
	createdAt?: string | null;
}) {
	const { t } = useTranslation("narrator");

	const labels = useMemo(
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

	const markdown = useMemo(() => {
		const projected = body ? sideCarBodyToMarkdown(source, body, labels) : "";
		return projected || rawSideCarToMarkdown(fallbackText);
	}, [body, source, labels, fallbackText]);

	const sourceKey = SOURCE_LABEL_KEYS[source];
	// An unmapped producer falls back to the generic system label rather than leaking
	// its internal tag: a producer added after this table is a naming gap, not
	// something to show a reader.
	const heading = sourceKey ? t(`sidecar.sources.${sourceKey}`) : t("origin.kind.system");

	return (
		<Paper p="xs" radius="sm" style={{ backgroundColor: SYSTEM_MESSAGE_BG }}>
			<Group gap={6} wrap="nowrap" mb={markdown.trim() ? 4 : 0}>
				<IconInfoCircle size={13} stroke={1.6} style={{ color: "var(--mantine-color-dimmed)" }} />
				<Text size="xs" c="dimmed" fw={600} style={{ whiteSpace: "nowrap" }}>
					{heading}
				</Text>
				{createdAt ? (
					<Text size="xs" c="dimmed" ml="auto" style={{ whiteSpace: "nowrap" }}>
						{formatNoticeTime(createdAt)}
					</Text>
				) : null}
			</Group>
			{markdown.trim() ? (
				<Text size="xs" c="dimmed" component="div">
					<MarkdownContent text={markdown} />
				</Text>
			) : null}
		</Paper>
	);
}

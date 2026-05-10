import {
	ActionIcon,
	Avatar,
	Badge,
	Card,
	Group,
	Loader,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import {
	IconArchive,
	IconArchiveOff,
	IconBox,
	IconTargetArrow,
	IconTerminal2,
	IconTrash,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { MouseEvent, PointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { FOLLOW_DEFAULT_MODEL } from "../../lib/constants";
import { formatSmartTime } from "../../lib/format";
import { highlightSearchText } from "../../lib/search-utils";
import { getEffectiveNarratorDisplay } from "../../lib/status-registry";
import { UserAvatar } from "../UserAvatar";

const ATTENTION_TAG_PRIORITY = [
	"error",
	"compacting",
	"background_compacting",
	"suspended",
	"manual_override",
	"reflecting",
	"interrupted",
	"unread",
] as const;

const MAX_NARRATOR_LIST_TITLE_CHARS = 500;
const MAX_NARRATOR_LIST_META_CHARS = 1_000;
const MAX_NARRATOR_LIST_VIEWER_TOOLTIP_ITEMS = 20;
const MAX_NARRATOR_LIST_VIEWER_TOOLTIP_CHARS = 2_000;

function clampNarratorListText(value: string | null | undefined, maxChars: number): string {
	if (!value) return "";
	return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

function formatViewerTooltip(viewers: NarratorListViewer[]): string {
	let text = "";
	let hidden = Math.max(0, viewers.length - MAX_NARRATOR_LIST_VIEWER_TOOLTIP_ITEMS);
	for (const viewer of viewers.slice(0, MAX_NARRATOR_LIST_VIEWER_TOOLTIP_ITEMS)) {
		const username = clampNarratorListText(viewer.username, MAX_NARRATOR_LIST_TITLE_CHARS);
		const prefix = text ? ", " : "";
		if (text.length + prefix.length + username.length > MAX_NARRATOR_LIST_VIEWER_TOOLTIP_CHARS) {
			hidden += 1;
			break;
		}
		text += `${prefix}${username}`;
	}
	return hidden > 0 ? `${text}, … (+${hidden})` : text;
}

export interface NarratorListViewer {
	userId: string;
	username: string;
	avatarColor: string | null;
	avatarImageId: string | null;
}

export interface NarratorListChapter {
	id: string;
	title: string;
	projectId: string;
	projectName: string | null;
	status: string;
	role: string;
}

export interface NarratorListItem {
	id: string;
	title?: string | null;
	model?: string | null;
	status: string;
	substatus?: string[] | null;
	cwd?: string | null;
	messageCount?: number | null;
	createdAt: string;
	lastMessageAt?: string | null;
	activeTerminalCount?: number | null;
	containerCount?: number | null;
	runningContainerCount?: number | null;
	hasActiveGoal?: boolean | null;
	chapter?: NarratorListChapter | null;
	viewers?: NarratorListViewer[] | null;
}

interface BaseNarratorListCardProps {
	narrator: NarratorListItem;
	localQuery: string;
	defaultModelValue: string;
}

interface ActiveNarratorListCardProps extends BaseNarratorListCardProps {
	variant: "active";
	dimmed?: boolean;
	onOpen: (narratorId: string) => void;
	onArchive: (narratorId: string) => void;
}

interface ArchivedNarratorListCardProps extends BaseNarratorListCardProps {
	variant: "archived";
	unarchiveLoading?: boolean;
	onUnarchive: (narratorId: string) => void;
	onDelete: (narrator: NarratorListItem) => void;
}

type NarratorListCardProps = ActiveNarratorListCardProps | ArchivedNarratorListCardProps;

/** Compute the status badge display for a narrator in the list view. */
function getNarratorBadgeInfo(
	status: string,
	substatus?: string[] | null,
): { color: string; labelKey: string } | null {
	const display = getEffectiveNarratorDisplay(status, substatus ?? undefined);
	const activeSubstatus = ATTENTION_TAG_PRIORITY.find((tag) => substatus?.includes(tag));
	const showBadge =
		!!activeSubstatus ||
		(status !== "idle" && status !== "working") ||
		(status === "working" && substatus?.includes("planning"));
	if (!showBadge) return null;
	const labelKey = activeSubstatus
		? `status_${activeSubstatus}`
		: substatus?.includes("planning")
			? "status_planning"
			: `status_${status}`;
	return { color: display.color, labelKey };
}

function NarratorTitle({
	narrator,
	localQuery,
}: {
	narrator: NarratorListItem;
	localQuery: string;
}) {
	const { t } = useTranslation("narrators");
	const title = clampNarratorListText(
		narrator.title || t("narratorId", { id: narrator.id.slice(0, 8) }),
		MAX_NARRATOR_LIST_TITLE_CHARS,
	);
	return <>{highlightSearchText(title, localQuery)}</>;
}

function NarratorMeta({
	narrator,
	defaultModelValue,
	size = "sm",
}: {
	narrator: NarratorListItem;
	defaultModelValue: string;
	size?: "xs" | "sm";
}) {
	const { t } = useTranslation("narrators");
	const modelLabel = clampNarratorListText(
		narrator.model === FOLLOW_DEFAULT_MODEL
			? t("followDefault", {
					model: clampNarratorListText(defaultModelValue, MAX_NARRATOR_LIST_META_CHARS),
				})
			: narrator.model,
		MAX_NARRATOR_LIST_META_CHARS,
	);
	return (
		<Text size={size} c="dimmed" truncate>
			{t("narratorMeta", {
				model: modelLabel,
				count: narrator.messageCount ?? 0,
			})}
		</Text>
	);
}

function NarratorBadges({
	narrator,
	mobile = false,
}: {
	narrator: NarratorListItem;
	mobile?: boolean;
}) {
	const { t } = useTranslation("narrators");
	const activeTerminals = narrator.activeTerminalCount ?? 0;
	const containers = narrator.containerCount ?? 0;
	const runningContainers = narrator.runningContainerCount ?? 0;
	return (
		<>
			{narrator.hasActiveGoal && (
				<Badge
					size="xs"
					variant="light"
					color="teal"
					leftSection={<IconTargetArrow size={10} />}
					style={mobile ? { flexShrink: 0 } : undefined}
				>
					{t("activeGoal")}
				</Badge>
			)}
			{activeTerminals > 0 && (
				<Badge
					size="xs"
					variant="light"
					color="teal"
					leftSection={<IconTerminal2 size={10} />}
					style={mobile ? { flexShrink: 0 } : undefined}
				>
					{activeTerminals}
				</Badge>
			)}
			{containers > 0 && (
				<Badge
					size="xs"
					variant="light"
					color={runningContainers > 0 ? "green" : "gray"}
					leftSection={<IconBox size={10} />}
					style={mobile ? { flexShrink: 0 } : undefined}
				>
					{runningContainers}/{containers}
				</Badge>
			)}
		</>
	);
}

function ProjectCwdLine({ narrator }: { narrator: NarratorListItem }) {
	const { t } = useTranslation("narrators");
	const chapter = narrator.chapter;
	if (!chapter?.projectName && !narrator.cwd) return null;
	const parts = [
		chapter?.projectName &&
			t("projectLabel", {
				name: clampNarratorListText(chapter.projectName, MAX_NARRATOR_LIST_META_CHARS),
			}),
		narrator.cwd &&
			t("cwdLabel", {
				path: clampNarratorListText(narrator.cwd, MAX_NARRATOR_LIST_META_CHARS),
			}),
	].filter(Boolean);
	return (
		<Text size="xs" c="dimmed" truncate>
			{clampNarratorListText(parts.join(" · "), MAX_NARRATOR_LIST_META_CHARS)}
		</Text>
	);
}

function ViewerAvatars({ narrator }: { narrator: NarratorListItem }) {
	const { t } = useTranslation("narrators");
	const viewers = narrator.viewers ?? [];
	if (viewers.length === 0) return null;
	return (
		<Tooltip label={`${t("viewingNow")}: ${formatViewerTooltip(viewers)}`}>
			<Avatar.Group spacing="xs">
				{viewers.slice(0, 3).map((v) => (
					<UserAvatar
						key={v.userId}
						username={clampNarratorListText(v.username, MAX_NARRATOR_LIST_TITLE_CHARS)}
						avatarColor={v.avatarColor}
						avatarImageId={v.avatarImageId}
						userId={v.userId}
						size="sm"
						showTooltip={false}
					/>
				))}
				{viewers.length > 3 && (
					<Avatar size="sm" radius="xl">
						+{viewers.length - 3}
					</Avatar>
				)}
			</Avatar.Group>
		</Tooltip>
	);
}

function CreatedLastMessageText({ narrator }: { narrator: NarratorListItem }) {
	const { t } = useTranslation("narrators");
	return (
		<>
			{t("createdAtLabel", { time: formatSmartTime(narrator.createdAt) })}
			{narrator.lastMessageAt &&
				` · ${t("lastMessageAtLabel", { time: formatSmartTime(narrator.lastMessageAt) })}`}
		</>
	);
}

function ActiveNarratorCard({
	narrator,
	localQuery,
	defaultModelValue,
	dimmed,
	onOpen,
	onArchive,
}: ActiveNarratorListCardProps) {
	const { t } = useTranslation("narrators");
	const { t: tn } = useTranslation("narrator");
	const substatus = Array.isArray(narrator.substatus) ? narrator.substatus : [];
	const badge = getNarratorBadgeInfo(narrator.status, substatus);

	return (
		<Card
			shadow="sm"
			padding="md"
			withBorder
			style={{
				cursor: "pointer",
				transition: "transform 80ms ease, opacity 150ms ease",
				opacity: dimmed ? 0.5 : 1,
				WebkitTapHighlightColor: "transparent",
			}}
			onClick={() => onOpen(narrator.id)}
			onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
				e.currentTarget.style.transform = "scale(0.985)";
			}}
			onPointerUp={(e: PointerEvent<HTMLDivElement>) => {
				e.currentTarget.style.transform = "";
			}}
			onPointerLeave={(e: PointerEvent<HTMLDivElement>) => {
				e.currentTarget.style.transform = "";
			}}
		>
			{/* ── Desktop card layout ── */}
			<Stack gap={4} visibleFrom="sm">
				<Group justify="space-between" wrap="nowrap">
					<Group gap="xs" style={{ minWidth: 0 }}>
						{narrator.status === "working" && (
							<Loader size={14} color={substatus.includes("planning") ? "green" : undefined} />
						)}
						{badge && (
							<Badge size="xs" color={badge.color}>
								{tn(badge.labelKey)}
							</Badge>
						)}
						<Text fw={500} truncate>
							<NarratorTitle narrator={narrator} localQuery={localQuery} />
						</Text>
					</Group>
					<Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
						<ViewerAvatars narrator={narrator} />
						<Tooltip label={t("archive")}>
							<ActionIcon
								size="sm"
								color="orange"
								variant="subtle"
								onPointerDown={(e: PointerEvent) => {
									e.stopPropagation();
								}}
								onClick={(e: MouseEvent) => {
									e.stopPropagation();
									onArchive(narrator.id);
								}}
							>
								<IconArchive size={16} />
							</ActionIcon>
						</Tooltip>
					</Group>
				</Group>
				<Group gap="xs" wrap="nowrap">
					<NarratorMeta narrator={narrator} defaultModelValue={defaultModelValue} />
					<NarratorBadges narrator={narrator} />
					<Text size="xs" c="dimmed" style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>
						<CreatedLastMessageText narrator={narrator} />
					</Text>
				</Group>
				<ProjectCwdLine narrator={narrator} />
			</Stack>

			{/* ── Mobile card layout ── */}
			<Stack gap={4} hiddenFrom="sm">
				<Group gap={6} wrap="nowrap" justify="space-between">
					<Group gap={6} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
						{narrator.status === "working" && (
							<Loader size={12} color={substatus.includes("planning") ? "green" : undefined} />
						)}
						{badge && (
							<Badge size="xs" color={badge.color}>
								{tn(badge.labelKey)}
							</Badge>
						)}
						<Text fw={500} truncate style={{ flex: 1, minWidth: 0 }}>
							<NarratorTitle narrator={narrator} localQuery={localQuery} />
						</Text>
					</Group>
					<Tooltip label={t("archive")}>
						<ActionIcon
							size="sm"
							color="orange"
							variant="subtle"
							style={{ flexShrink: 0 }}
							onPointerDown={(e: PointerEvent) => {
								e.stopPropagation();
							}}
							onClick={(e: MouseEvent) => {
								e.stopPropagation();
								onArchive(narrator.id);
							}}
						>
							<IconArchive size={16} />
						</ActionIcon>
					</Tooltip>
				</Group>
				<Group gap="xs" wrap="nowrap" style={{ overflow: "hidden" }}>
					<NarratorMeta narrator={narrator} defaultModelValue={defaultModelValue} size="xs" />
					<NarratorBadges narrator={narrator} mobile />
				</Group>
				<ProjectCwdLine narrator={narrator} />
				<Group gap="xs" wrap="nowrap" mt={2}>
					<ViewerAvatars narrator={narrator} />
					<Text size="xs" c="dimmed">
						{t("createdAtLabel", { time: formatSmartTime(narrator.createdAt) })}
					</Text>
				</Group>
				{narrator.lastMessageAt && (
					<Text size="xs" c="dimmed">
						{t("lastMessageAtLabel", { time: formatSmartTime(narrator.lastMessageAt) })}
					</Text>
				)}
			</Stack>
		</Card>
	);
}

function ArchivedNarratorCard({
	narrator,
	localQuery,
	defaultModelValue,
	unarchiveLoading,
	onUnarchive,
	onDelete,
}: ArchivedNarratorListCardProps) {
	const { t } = useTranslation("narrators");
	return (
		<Link
			to="/narrators/$narratorId"
			params={{ narratorId: narrator.id }}
			style={{ textDecoration: "none", color: "inherit" }}
		>
			<Card shadow="sm" padding="md" withBorder>
				<Group justify="space-between" wrap="nowrap" align="flex-start">
					<Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
						<Group gap="xs" wrap="nowrap">
							<Text fw={500} truncate>
								<NarratorTitle narrator={narrator} localQuery={localQuery} />
							</Text>
							<NarratorBadges narrator={narrator} />
						</Group>
						<NarratorMeta narrator={narrator} defaultModelValue={defaultModelValue} />
						<ProjectCwdLine narrator={narrator} />
						<Group gap="xs" wrap="nowrap">
							<ViewerAvatars narrator={narrator} />
							<Text size="xs" c="dimmed">
								<CreatedLastMessageText narrator={narrator} />
							</Text>
						</Group>
					</Stack>
					<Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
						<Tooltip label={t("unarchive")}>
							<ActionIcon
								size="sm"
								color="teal"
								variant="subtle"
								loading={unarchiveLoading}
								onClick={(e: MouseEvent) => {
									e.preventDefault();
									e.stopPropagation();
									onUnarchive(narrator.id);
								}}
							>
								<IconArchiveOff size={16} />
							</ActionIcon>
						</Tooltip>
						<Tooltip label={t("deleteNarrator")}>
							<ActionIcon
								size="sm"
								color="red"
								variant="subtle"
								onClick={(e: MouseEvent) => {
									e.preventDefault();
									e.stopPropagation();
									onDelete(narrator);
								}}
							>
								<IconTrash size={16} />
							</ActionIcon>
						</Tooltip>
					</Group>
				</Group>
			</Card>
		</Link>
	);
}

export function NarratorListCard(props: NarratorListCardProps) {
	if (props.variant === "active") return <ActiveNarratorCard {...props} />;
	return <ArchivedNarratorCard {...props} />;
}

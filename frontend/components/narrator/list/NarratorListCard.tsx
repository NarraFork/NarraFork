import { ActionIcon, Avatar, Badge, Card, Group, Stack, Text, Tooltip } from "@mantine/core";
import {
	IconArchive,
	IconArchiveOff,
	IconBox,
	IconServer,
	IconSubtask,
	IconTerminal2,
	IconTrash,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import type { MouseEvent, PointerEvent, ReactNode } from "react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { FOLLOW_DEFAULT_MODEL, FOLLOW_PARENT_MODEL } from "../../../lib/constants";
import { formatSmartTime } from "../../../lib/format";
import { startPointerDrag } from "../../../lib/panel-drag";
import { highlightSearchText } from "../../../lib/search-utils";
import { getEffectiveNarratorDisplay } from "../../../lib/status-registry";
import { NarratorStatusIcon } from "../../nav/NarratorStatusIcon";
import { UserAvatar } from "../../UserAvatar";
import { NarratorAvatar } from "../header/NarratorAvatar";

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
	/** Custom avatar image id; absent → the identicon derived from the narrator id. */
	avatarImageId?: string | null;
	createdAt: string;
	lastMessageAt?: string | null;
	activeTerminalCount?: number | null;
	activeBackgroundTaskCount?: number | null;
	activeBackgroundWorkCount?: number | null;
	activeBackgroundServiceCount?: number | null;
	containerCount?: number | null;
	runningContainerCount?: number | null;
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
	deleteSupported?: boolean;
	deleteUnsupportedReason?: string;
	onUnarchive: (narratorId: string) => void;
	onDelete: (narrator: NarratorListItem) => void;
}

type NarratorListCardProps = ActiveNarratorListCardProps | ArchivedNarratorListCardProps;

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
		narrator.model === FOLLOW_PARENT_MODEL
			? t("narrator:followParent")
			: narrator.model === FOLLOW_DEFAULT_MODEL
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
	const activeTerminals = narrator.activeTerminalCount ?? 0;
	const { t } = useTranslation("common");
	const activeBackgroundTasks =
		narrator.activeBackgroundWorkCount ?? narrator.activeBackgroundTaskCount ?? 0;
	const activeServices = narrator.activeBackgroundServiceCount ?? 0;
	const containers = narrator.containerCount ?? 0;
	const runningContainers = narrator.runningContainerCount ?? 0;
	return (
		<>
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
			{activeBackgroundTasks > 0 && (
				<Badge
					size="xs"
					variant="light"
					color="blue"
					leftSection={<IconSubtask size={10} />}
					style={mobile ? { flexShrink: 0 } : undefined}
				>
					{activeBackgroundTasks}
				</Badge>
			)}
			{activeServices > 0 && (
				<Tooltip label={t("activeBackgroundServices", { count: activeServices })}>
					<Badge
						size="xs"
						variant="light"
						color="teal"
						leftSection={<IconServer size={10} />}
						style={mobile ? { flexShrink: 0 } : undefined}
					>
						{activeServices}
					</Badge>
				</Tooltip>
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

/**
 * Icon wrapper that starts a cross-region drag of this narrator.
 *
 * The same handle the sidebar rows use (`RecentTabs`' `handleIconPointerDown`): the
 * `panel-drag` singleton takes ownership of the pointer, and the sidebar / workspace docks
 * pick the drag up from there.
 *
 * `preventDefault` on pointerdown is what keeps this from also navigating: it suppresses
 * the following mousedown/click, so the surrounding card's `onClick` never fires for a
 * gesture that started on the handle. A plain click below the singleton's 5px threshold is
 * dropped silently, so the handle is not a dead zone either — it just does not navigate.
 */
function NarratorDragHandle({
	narrator,
	children,
}: {
	narrator: NarratorListItem;
	children: ReactNode;
}) {
	const handlePointerDown = useCallback(
		(event: PointerEvent<HTMLSpanElement>) => {
			if (event.button !== 0) return;
			event.stopPropagation();
			event.preventDefault();
			startPointerDrag(
				narrator.id,
				narrator.title || narrator.id.slice(0, 8),
				event.clientX,
				event.clientY,
			);
		},
		[narrator.id, narrator.title],
	);

	return (
		<span
			onPointerDown={handlePointerDown}
			style={{
				display: "inline-flex",
				cursor: "grab",
				// Claim the touch gesture for the drag singleton; otherwise the browser
				// keeps vertical movement for scrolling and the drag never starts.
				touchAction: "none",
			}}
		>
			{children}
		</span>
	);
}

/**
 * The status icon, identical to the sidebar's recent-tabs icon (`NarratorStatusIcon`).
 * The list page does not track drafts or scheduled spawning, so those two corner
 * markers are simply absent here; the reasoning marker rides on `substatus` and DOES
 * appear, same as the sidebar. Colour, fill, background-work half-fill and the centre
 * shape all match the sidebar.
 */
function NarratorListStatusIcon({
	narrator,
	size,
	dragHint,
}: {
	narrator: NarratorListItem;
	size: number;
	dragHint?: string;
}) {
	const { t } = useTranslation("common");
	const display = getEffectiveNarratorDisplay(narrator.status, narrator.substatus ?? undefined);
	const statusLabel = t(display.i18nKey);
	return (
		<Tooltip
			label={dragHint ? `${statusLabel} · ${dragHint}` : statusLabel}
			openDelay={500}
			position="top"
			events={{ hover: true, focus: true, touch: true }}
		>
			<span role="img" aria-label={statusLabel} style={{ display: "inline-flex" }}>
				<NarratorStatusIcon
					size={size}
					status={narrator.status}
					substatus={narrator.substatus}
					activeBackgroundWorkCount={narrator.activeBackgroundWorkCount}
					activeBackgroundTaskCount={narrator.activeBackgroundTaskCount}
				/>
			</span>
		</Tooltip>
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
						{/* Desktop only: the mobile sidebar is a drawer, so there is nowhere
						    to drop and the handle would just break tapping the icon. */}
						<NarratorDragHandle narrator={narrator}>
							<NarratorListStatusIcon narrator={narrator} size={20} dragHint={t("dragToSidebar")} />
						</NarratorDragHandle>
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
						<NarratorListStatusIcon narrator={narrator} size={18} />
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
	deleteSupported = true,
	deleteUnsupportedReason,
	onUnarchive,
	onDelete,
}: ArchivedNarratorListCardProps) {
	const { t } = useTranslation("narrators");
	const deleteTooltip = deleteSupported
		? t("deleteNarrator")
		: (deleteUnsupportedReason ?? t("deleteNarratorUnsupported"));
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
							<NarratorAvatar
								narratorId={narrator.id}
								avatarImageId={narrator.avatarImageId}
								title={narrator.title}
								size={20}
								showTooltip={false}
							/>
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
						<Tooltip label={deleteTooltip}>
							<ActionIcon
								size="sm"
								color="red"
								variant="subtle"
								aria-disabled={!deleteSupported}
								title={deleteTooltip}
								style={!deleteSupported ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
								onClick={(e: MouseEvent) => {
									e.preventDefault();
									e.stopPropagation();
									if (!deleteSupported) return;
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

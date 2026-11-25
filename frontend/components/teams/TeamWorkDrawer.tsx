/**
 * The work item drawer (the redesign R), on the right: the title and its review verdict; the
 * branch → base and how many commits it is ahead; the worker's session; the changed files with
 * `+/-` (a file's diff is read only when it is opened, capped server-side); the review rounds
 * (agents' reviews and people's returns); this item's own timeline; and a fixed bottom bar with
 * 退回 / 合并到 <base>.
 *
 * D: when the item waits for others, a 「依赖」 list (each with its state; a title opens that item
 * here) and a warning when one was cancelled; items waiting for this one are listed under
 * 「被依赖」. Read-only: only the coordinator changes dependencies.
 *
 * 退回 expands in place into a required one-line reason: the item goes back to in progress and
 * the coordinator relays the reason to the worker. The server never merges, so 合并 is disabled
 * and the bar says how an item becomes merged (its branch landing in the base is noticed).
 */
import { useReturnWorkItem, useTeamWorkDiff, useTeamWorkItem } from "@frontend/hooks/useTeams";
import { describeApiError } from "@frontend/lib/api-error";
import { formatSmartTime } from "@frontend/lib/format";
import {
	ActionIcon,
	Alert,
	Anchor,
	Badge,
	Box,
	Button,
	Drawer,
	Group,
	Loader,
	ScrollArea,
	Stack,
	Text,
	Textarea,
	Title,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	dependencyBlockers,
	type TeamWorkDependencyRef,
	type TeamWorkFileChange,
	type TeamWorkItemDetail,
} from "@shared/project-teams";
import {
	IconAlertTriangle,
	IconArrowBackUp,
	IconArrowRight,
	IconCheck,
	IconChevronRight,
	IconExternalLink,
	IconGitBranch,
	IconGitMerge,
	IconX,
} from "@tabler/icons-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActivityLine } from "./TeamActivity";
import {
	diffLineKind,
	findingsNeedToggle,
	itemMarks,
	liveWorkerStatus,
	REVIEW_FINDINGS_CLAMP_LINES,
	returnErrorKey,
	returnReason,
	showsStat,
} from "./team-page-model";
import { ATTENTION_BG, ATTENTION_TEXT, DiffCount, MONO, StatusDot, TABULAR } from "./team-page-ui";

const DIFF_COLOR = {
	add: {
		background: "color-mix(in srgb, var(--mantine-color-green-6) 14%, transparent)",
		color: undefined,
	},
	del: {
		background: "color-mix(in srgb, var(--mantine-color-red-6) 14%, transparent)",
		color: undefined,
	},
	hunk: { background: "var(--mantine-color-default-hover)", color: "var(--mantine-color-dimmed)" },
	meta: { background: undefined, color: "var(--mantine-color-dimmed)" },
	context: { background: undefined, color: undefined },
} as const;

/** A review round's findings: muted, clamped to a few lines, 「展开」 for the rest. */
export function ReviewFindings({ text, clipped }: { text: string | null; clipped: boolean }) {
	const { t } = useTranslation("projects");
	const [open, setOpen] = useState(false);
	// A guess first (also what a static render shows), then what the clamped text really does.
	const [overflows, setOverflows] = useState(() => !!text && findingsNeedToggle(text));
	const textRef = useRef<HTMLParagraphElement | null>(null);
	useLayoutEffect(() => {
		const element = textRef.current;
		if (!element || open) return;
		setOverflows(element.scrollHeight > element.clientHeight + 1);
	}, [open]);
	const toggle = !!text && (open || overflows);
	return (
		<Box data-testid="team-review-findings">
			{text && (
				<Text
					ref={textRef}
					size="sm"
					c="dimmed"
					lineClamp={open ? undefined : REVIEW_FINDINGS_CLAMP_LINES}
					style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}
				>
					{text}
				</Text>
			)}
			{clipped && (
				<Text size="xs" c="dimmed" fs="italic">
					{t("teams.page.drawer.findingsClipped")}
				</Text>
			)}
			{toggle && (
				<Anchor
					component="button"
					type="button"
					size="xs"
					onClick={() => setOpen((value) => !value)}
					data-testid="team-review-findings-toggle"
				>
					{t(open ? "teams.page.drawer.findingsLess" : "teams.page.drawer.findingsMore")}
				</Anchor>
			)}
		</Box>
	);
}

function FileDiff({
	projectId,
	teamId,
	itemId,
	path,
}: {
	projectId: string;
	teamId: string;
	itemId: string;
	path: string;
}) {
	const { t } = useTranslation("projects");
	const diff = useTeamWorkDiff(projectId, teamId, itemId, path);
	if (diff.isLoading) return <Loader size="xs" m="xs" />;
	if (diff.isError || !diff.data)
		return (
			<Text size="xs" c="red" p="xs">
				{t("teams.page.drawer.diffFailed")}
			</Text>
		);
	// Headers repeat what the row says; the hunks start at the first `@@`.
	const lines = diff.data.text.split("\n");
	const start = Math.max(
		0,
		lines.findIndex((line) => line.startsWith("@@")),
	);
	return (
		<Box
			data-testid="team-file-diff"
			style={{
				border: "1px solid var(--mantine-color-default-border)",
				borderRadius: "var(--mantine-radius-sm)",
				overflow: "hidden",
			}}
		>
			<ScrollArea.Autosize mah={360} type="auto">
				<Box component="pre" m={0} py={4} style={{ ...MONO, fontSize: 12, lineHeight: 1.6 }}>
					{lines.slice(start).map((line, index) => {
						const kind = diffLineKind(line);
						return (
							<div
								// biome-ignore lint/suspicious/noArrayIndexKey: the lines of one diff, in order
								key={index}
								data-line-kind={kind}
								style={{
									padding: "0 10px",
									whiteSpace: "pre",
									background: DIFF_COLOR[kind].background,
									color: DIFF_COLOR[kind].color,
								}}
							>
								{line || " "}
							</div>
						);
					})}
				</Box>
			</ScrollArea.Autosize>
			{diff.data.truncated && (
				<Text size="xs" c="dimmed" px="sm" py={4}>
					{t("teams.page.drawer.diffTruncated")}
				</Text>
			)}
		</Box>
	);
}

function FileRow({
	file,
	open,
	onToggle,
	children,
	canOpen,
}: {
	file: TeamWorkFileChange;
	open: boolean;
	onToggle: () => void;
	children: ReactNode;
	canOpen: boolean;
}) {
	const slash = file.path.lastIndexOf("/");
	const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
	const name = slash >= 0 ? file.path.slice(slash + 1) : file.path;
	return (
		<Box data-testid="team-file" data-path={file.path}>
			<UnstyledButton
				onClick={onToggle}
				disabled={!canOpen}
				aria-expanded={open}
				style={{ width: "100%", padding: "5px 4px", borderRadius: 4 }}
			>
				<Group gap={6} wrap="nowrap">
					<IconChevronRight
						size={14}
						aria-hidden
						style={{
							flexShrink: 0,
							opacity: canOpen ? 0.6 : 0.2,
							transform: open ? "rotate(90deg)" : undefined,
						}}
					/>
					<Text size="sm" truncate style={{ ...MONO, flex: 1, minWidth: 0 }}>
						<span style={{ color: "var(--mantine-color-dimmed)" }}>{dir}</span>
						{name}
					</Text>
					{file.added === null ? (
						<Text size="xs" c="dimmed">
							bin
						</Text>
					) : (
						<DiffCount stat={{ added: file.added, removed: file.removed ?? 0 }} />
					)}
				</Group>
			</UnstyledButton>
			{open && (
				<Box pl={20} pb={6}>
					{children}
				</Box>
			)}
		</Box>
	);
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<Group gap="md" wrap="nowrap" align="flex-start">
			<Text size="sm" c="dimmed" style={{ width: 56, flexShrink: 0 }}>
				{label}
			</Text>
			<Box style={{ flex: 1, minWidth: 0 }}>{children}</Box>
		</Group>
	);
}

function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
	return (
		<Group justify="space-between" mb={6}>
			<Text size="sm" fw={600}>
				{children}
			</Text>
			{right}
		</Group>
	);
}

const DEPENDENCY_STATE_COLOR: Record<TeamWorkDependencyRef["state"], string> = {
	queued: "gray",
	in_progress: "blue",
	in_review: "blue",
	ready: "green",
	merged: "gray",
	cancelled: "red",
};

/** One dependency or dependent: its state, and its title opening it in this drawer. */
function DependencyRow({
	entry,
	onOpenItem,
}: {
	entry: TeamWorkDependencyRef;
	onOpenItem?: (itemId: string) => void;
}) {
	const { t } = useTranslation("projects");
	return (
		<Group gap={8} wrap="nowrap" data-testid="team-dependency" data-state={entry.state}>
			<Badge
				size="sm"
				radius="sm"
				variant="light"
				tt="none"
				color={DEPENDENCY_STATE_COLOR[entry.state]}
				style={{ flexShrink: 0 }}
			>
				{t(`teams.page.drawer.dependencyState.${entry.state}`)}
			</Badge>
			{onOpenItem ? (
				<Anchor
					component="button"
					size="sm"
					onClick={() => onOpenItem(entry.id)}
					style={{ minWidth: 0, textAlign: "left", overflowWrap: "anywhere" }}
					td={entry.state === "cancelled" ? "line-through" : undefined}
				>
					{entry.title}
				</Anchor>
			) : (
				<Text size="sm" style={{ minWidth: 0, overflowWrap: "anywhere" }}>
					{entry.title}
				</Text>
			)}
		</Group>
	);
}

/** The drawer's 「依赖」 and 「被依赖」 sections (exported for the component tests). */
export function DependencySections({
	detail,
	onOpenItem,
}: {
	detail: TeamWorkItemDetail;
	onOpenItem?: (itemId: string) => void;
}) {
	const { t } = useTranslation("projects");
	const dependsOn = detail.item.dependsOn ?? [];
	const dependents = detail.dependents ?? [];
	if (dependsOn.length === 0 && dependents.length === 0) return null;
	const cancelled = dependencyBlockers(dependsOn).filter((entry) => entry.state === "cancelled");
	const waits = detail.item.state === "queued";
	return (
		<Stack gap="md">
			{dependsOn.length > 0 && (
				<Box data-testid="team-drawer-dependencies">
					<SectionTitle>{t("teams.page.drawer.dependenciesTitle")}</SectionTitle>
					<Stack gap={6}>
						{waits &&
							cancelled.map((entry) => (
								<Alert
									key={entry.id}
									color="yellow"
									p="xs"
									icon={<IconAlertTriangle size={16} />}
									data-testid="team-dependency-cancelled"
								>
									{t("teams.page.drawer.dependencyCancelled", { title: entry.title })}
								</Alert>
							))}
						{dependsOn.map((entry) => (
							<DependencyRow key={entry.id} entry={entry} onOpenItem={onOpenItem} />
						))}
						{waits && cancelled.length === 0 && dependencyBlockers(dependsOn).length > 0 && (
							<Text size="xs" c="dimmed">
								{t("teams.page.drawer.dependencyNote", { base: detail.base })}
							</Text>
						)}
					</Stack>
				</Box>
			)}
			{dependents.length > 0 && (
				<Box data-testid="team-drawer-dependents">
					<SectionTitle>{t("teams.page.drawer.dependentsTitle")}</SectionTitle>
					<Stack gap={6}>
						{dependents.map((entry) => (
							<DependencyRow key={entry.id} entry={entry} onOpenItem={onOpenItem} />
						))}
						{detail.dependentsMore && (
							<Text size="xs" c="dimmed">
								{t("teams.page.drawer.dependentsMore")}
							</Text>
						)}
					</Stack>
				</Box>
			)}
		</Stack>
	);
}

function DrawerBody({
	projectId,
	teamId,
	detail,
	onOpenSession,
	onOpenItem,
}: {
	projectId: string;
	teamId: string;
	detail: TeamWorkItemDetail;
	onOpenSession?: (narratorId: string) => void;
	onOpenItem?: (itemId: string) => void;
}) {
	const { t } = useTranslation("projects");
	const { item } = detail;
	const [openFiles, setOpenFiles] = useState<Set<string>>(() => new Set());
	const toggle = (path: string) =>
		setOpenFiles((current) => {
			const next = new Set(current);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	const workerStatus = item.worker ? liveWorkerStatus(item.worker, undefined) : null;
	return (
		<Stack gap="lg">
			<Stack gap={8}>
				<Field label={t("teams.page.drawer.branch")}>
					{item.branch ? (
						<Group gap={6} wrap="wrap" style={{ rowGap: 2 }}>
							<IconGitBranch size={14} aria-hidden style={{ opacity: 0.6 }} />
							<Text size="sm" style={MONO} data-testid="team-drawer-branch">
								{item.branch}
							</Text>
							<IconArrowRight size={12} aria-hidden style={{ opacity: 0.5 }} />
							<Text size="sm" style={MONO}>
								{detail.base}
							</Text>
							{detail.aheadBy !== null && (
								<Text size="sm" c="dimmed" style={TABULAR}>
									· {t("teams.page.drawer.ahead", { count: detail.aheadBy })}
								</Text>
							)}
						</Group>
					) : (
						<Text size="sm" c="dimmed">
							{t("teams.page.drawer.noBranch")}
						</Text>
					)}
				</Field>
				<Field label={t("teams.page.drawer.worker")}>
					{item.worker ? (
						<Group gap={6} wrap="nowrap">
							<StatusDot
								tone={workerStatus === "working" || workerStatus === "waiting" ? "blue" : "hollow"}
							/>
							<Text size="sm" truncate>
								{item.worker.title ?? item.worker.id}
							</Text>
							{onOpenSession && (
								<Anchor
									component="button"
									size="sm"
									onClick={() => item.worker && onOpenSession(item.worker.id)}
									data-testid="team-drawer-worker-session"
								>
									<Group gap={4} wrap="nowrap">
										{t("teams.page.drawer.workerSession")}
										<IconExternalLink size={13} aria-hidden />
									</Group>
								</Anchor>
							)}
						</Group>
					) : (
						<Text size="sm" c="dimmed">
							{t("teams.page.drawer.noWorker")}
						</Text>
					)}
				</Field>
				<Field label={t("teams.page.drawer.changes")}>
					{detail.stat && !showsStat(detail.stat) ? (
						<Text size="sm" c="dimmed">
							{t("teams.page.drawer.noFiles")}
						</Text>
					) : detail.stat ? (
						<Group gap={8}>
							<DiffCount stat={detail.stat} size="sm" />
							<Text size="sm" c="dimmed" style={TABULAR}>
								{t("teams.page.attention.files", { count: detail.stat.files })}
							</Text>
						</Group>
					) : (
						<Text size="sm" c="dimmed">
							{t("teams.page.drawer.diffUnavailable")}
						</Text>
					)}
				</Field>
			</Stack>

			<DependencySections detail={detail} onOpenItem={onOpenItem} />

			<Box data-testid="team-drawer-files">
				<SectionTitle>{t("teams.page.drawer.filesTitle")}</SectionTitle>
				{detail.files.length === 0 ? (
					<Text size="sm" c="dimmed">
						{detail.stat ? t("teams.page.drawer.noFiles") : t("teams.page.drawer.diffUnavailable")}
					</Text>
				) : (
					<Stack gap={0}>
						{detail.files.map((file) => (
							<FileRow
								key={file.path}
								file={file}
								open={openFiles.has(file.path)}
								onToggle={() => toggle(file.path)}
								canOpen={detail.diffAvailable && file.added !== null}
							>
								{openFiles.has(file.path) && (
									<FileDiff
										projectId={projectId}
										teamId={teamId}
										itemId={item.id}
										path={file.path}
									/>
								)}
							</FileRow>
						))}
						{detail.filesMore && (
							<Text size="xs" c="dimmed" mt={4}>
								{t("teams.page.drawer.filesMore")}
							</Text>
						)}
					</Stack>
				)}
			</Box>

			<Box data-testid="team-drawer-reviews">
				<SectionTitle>{t("teams.page.drawer.reviewsTitle")}</SectionTitle>
				{detail.reviews.length === 0 ? (
					<Text size="sm" c="dimmed">
						{t("teams.page.drawer.noReviews")}
					</Text>
				) : (
					<Stack gap={10}>
						{detail.reviews.map((round) => {
							const returned = round.by === "person";
							return (
								<Stack key={round.eventId} gap={2} data-testid="team-review-round">
									<Group gap={8} wrap="nowrap">
										<Badge
											size="sm"
											radius="sm"
											variant="light"
											tt="none"
											color={round.verdict === "clear" ? "green" : returned ? "yellow" : "red"}
										>
											{t(
												round.verdict === "clear"
													? "teams.page.drawer.verdictClear"
													: returned
														? "teams.page.drawer.verdictReturned"
														: "teams.page.drawer.verdictBlocker",
											)}
										</Badge>
										<Text size="sm" style={{ flex: 1, minWidth: 0 }} truncate>
											{t("teams.page.drawer.round", {
												round: round.round,
												// An agent's round is the coordinator recording a reviewer's verdict.
												who:
													round.by === "person"
														? (round.actorName ?? t("teams.activity.unknownPerson"))
														: t("teams.page.drawer.reviewer"),
											})}
											{round.findings !== null && round.findings > 0 && (
												<Text component="span" inherit c="dimmed">
													{" · "}
													{t("teams.page.drawer.findings", { count: round.findings })}
												</Text>
											)}
										</Text>
										<Text size="xs" c="dimmed" style={TABULAR} title={round.at}>
											{formatSmartTime(round.at)}
										</Text>
									</Group>
									{round.reason && (
										<Text size="sm" c="dimmed" style={{ overflowWrap: "anywhere" }}>
											{round.reason}
										</Text>
									)}
									{(round.summary || round.summaryClipped) && (
										<ReviewFindings text={round.summary} clipped={!!round.summaryClipped} />
									)}
								</Stack>
							);
						})}
					</Stack>
				)}
			</Box>

			<Box data-testid="team-drawer-timeline">
				<SectionTitle>{t("teams.page.drawer.timelineTitle")}</SectionTitle>
				<Stack gap={0} ml={-10}>
					{detail.events.map((event) => (
						<ActivityLine key={event.id} event={event} showItem={false} coordinatorId={teamId} />
					))}
				</Stack>
				{detail.eventsMore && (
					<Text size="xs" c="dimmed" mt={4}>
						{t("teams.page.drawer.eventsMore")}
					</Text>
				)}
			</Box>
		</Stack>
	);
}

/** The fixed bottom bar: 退回 / 合并; 退回 opens the reason in place. */
function ReturnBar({
	projectId,
	teamId,
	detail,
	returning,
	setReturning,
}: {
	projectId: string;
	teamId: string;
	detail: TeamWorkItemDetail;
	returning: boolean;
	setReturning: (value: boolean) => void;
}) {
	const { t } = useTranslation("projects");
	const [reason, setReason] = useState("");
	const send = useReturnWorkItem(projectId, teamId);
	const returnErrorText = (error: unknown) => {
		const key = returnErrorKey(error);
		return key
			? t(key)
			: `${t("teams.page.drawer.returnFailed")} ${describeApiError(error, t).message}`;
	};
	const ready = returnReason(reason);
	const base = detail.base;
	const submit = () => {
		if (!ready) return;
		send.mutate(
			{ itemId: detail.item.id, reason: ready },
			{
				onSuccess: (result) => {
					setReason("");
					setReturning(false);
					notifications.show({
						color: result.delivered ? "green" : "yellow",
						message: t(
							result.delivered
								? "teams.page.drawer.returned"
								: "teams.page.drawer.returnedNotDelivered",
						),
					});
				},
			},
		);
	};
	if (returning)
		return (
			<Stack gap={8} data-testid="team-return-form">
				<Text size="sm" fw={600}>
					{t("teams.page.drawer.returnTitle")}
				</Text>
				<Textarea
					autoFocus
					autosize
					minRows={2}
					maxRows={6}
					required
					maxLength={2000}
					value={reason}
					onChange={(event) => setReason(event.currentTarget.value)}
					placeholder={t("teams.page.drawer.returnPlaceholder")}
					aria-label={t("teams.page.drawer.returnTitle")}
					data-testid="team-return-reason"
				/>
				{send.isError && (
					<Alert color="red" p="xs" data-testid="team-return-error">
						{returnErrorText(send.error)}
					</Alert>
				)}
				<Group justify="space-between" wrap="wrap" gap="sm" style={{ rowGap: 6 }}>
					<Text size="xs" c="dimmed" style={{ flex: "1 1 220px" }}>
						{t("teams.page.drawer.returnHint")}
					</Text>
					<Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
						<Button
							variant="subtle"
							color="gray"
							onClick={() => {
								setReturning(false);
								send.reset();
							}}
						>
							{t("teams.page.drawer.cancel")}
						</Button>
						<Button
							disabled={!ready}
							loading={send.isPending}
							onClick={submit}
							data-testid="team-return-confirm"
						>
							{t("teams.page.drawer.confirmReturn")}
						</Button>
					</Group>
				</Group>
			</Stack>
		);
	return (
		<Group justify="space-between" wrap="wrap" gap="sm" style={{ rowGap: 6 }}>
			<Text size="xs" c="dimmed" style={{ minWidth: 0, flex: "1 1 220px" }}>
				{t("teams.page.drawer.barNote", { base })}
			</Text>
			<Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
				<Button
					variant="default"
					leftSection={<IconArrowBackUp size={16} aria-hidden />}
					onClick={() => setReturning(true)}
					data-testid="team-drawer-return"
				>
					{t("teams.page.drawer.return")}
				</Button>
				<Tooltip
					label={t("teams.page.attention.mergeDisabled", { base })}
					withinPortal
					multiline
					maw={300}
				>
					<span>
						<Button
							disabled
							leftSection={<IconGitMerge size={16} aria-hidden />}
							data-testid="team-drawer-merge"
						>
							{t("teams.page.drawer.merge", { base })}
						</Button>
					</span>
				</Tooltip>
			</Group>
		</Group>
	);
}

export function TeamWorkDrawer({
	projectId,
	teamId,
	itemId,
	startReturning,
	phone,
	onClose,
	onOpenSession,
	onOpenItem,
}: {
	projectId: string;
	teamId: string;
	itemId: string | null;
	/** Opened from a card's 退回: the reason is open at once. */
	startReturning?: boolean;
	phone: boolean;
	onClose: () => void;
	onOpenSession?: (narratorId: string) => void;
	/** D: open another item of the team in this drawer (a dependency's link). */
	onOpenItem?: (itemId: string) => void;
}) {
	const { t } = useTranslation("projects");
	const detail = useTeamWorkItem(projectId, teamId, itemId);
	const [returning, setReturning] = useState(false);
	useEffect(() => {
		setReturning(!!startReturning && !!itemId);
	}, [itemId, startReturning]);
	const data = detail.data?.item.id === itemId ? detail.data : undefined;
	const item = data?.item;
	const showBar = !!data && data.canReturn;
	return (
		<Drawer
			opened={!!itemId}
			onClose={onClose}
			position="right"
			size={phone ? "100%" : 640}
			withCloseButton={false}
			padding={0}
			styles={{
				content: { display: "flex", flexDirection: "column" },
				body: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: 0 },
			}}
			data-testid="team-work-drawer"
		>
			<Box px="lg" pt="md" pb="sm">
				<Group justify="space-between" wrap="nowrap" align="flex-start">
					<Group gap={6}>
						{item?.state === "ready" && (
							<Badge
								size="sm"
								radius="sm"
								variant="light"
								tt="none"
								style={{ background: ATTENTION_BG, color: ATTENTION_TEXT }}
							>
								{t("teams.page.drawer.waitingAcceptance")}
							</Badge>
						)}
						{item && (
							<Badge
								size="sm"
								radius="sm"
								variant="light"
								tt="none"
								color={
									item.lastReview === "clear"
										? "green"
										: item.lastReview === "blocker"
											? "red"
											: "gray"
								}
								leftSection={item.lastReview === "clear" ? <IconCheck size={12} /> : undefined}
								data-testid="team-drawer-verdict"
							>
								{t(`teams.page.drawer.verdict.${item.lastReview ?? "none"}`)}
							</Badge>
						)}
						{item &&
							itemMarks(item).map((mark) => (
								<Badge
									key={mark}
									size="sm"
									radius="sm"
									variant="light"
									color="gray"
									tt="none"
									data-mark={mark}
								>
									{t(`teams.page.marks.${mark}`, { key: item.exclusiveKey ?? "" })}
								</Badge>
							))}
					</Group>
					<ActionIcon
						variant="subtle"
						color="gray"
						onClick={onClose}
						aria-label={t("teams.page.drawer.close")}
						data-testid="team-drawer-close"
					>
						<IconX size={18} />
					</ActionIcon>
				</Group>
				<Title
					order={3}
					mt={8}
					style={{ overflowWrap: "anywhere" }}
					data-testid="team-drawer-title"
				>
					{item?.title ?? ""}
				</Title>
			</Box>
			<ScrollArea style={{ flex: 1, minHeight: 0 }} type="auto">
				<Box px="lg" pb="lg">
					{detail.isLoading && <Loader size="sm" />}
					{detail.isError && <Alert color="red">{t("teams.page.drawer.loadFailed")}</Alert>}
					{data && (
						<DrawerBody
							projectId={projectId}
							teamId={teamId}
							detail={data}
							onOpenSession={onOpenSession}
							onOpenItem={onOpenItem}
						/>
					)}
				</Box>
			</ScrollArea>
			{showBar && data && (
				<Box
					px="lg"
					py="sm"
					data-testid="team-drawer-bar"
					style={{
						borderTop: "1px solid var(--mantine-color-default-border)",
						background: "var(--mantine-color-body)",
						paddingBottom: "max(var(--mantine-spacing-sm), env(safe-area-inset-bottom))",
					}}
				>
					<ReturnBar
						projectId={projectId}
						teamId={teamId}
						detail={data}
						returning={returning}
						setReturning={setReturning}
					/>
				</Box>
			)}
		</Drawer>
	);
}

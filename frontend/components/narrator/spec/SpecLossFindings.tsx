/**
 * Content a save from the old Spec panel may have swallowed (outline P2 PR 12c): the findings of
 * the background scan. The server attaches each to its file's imported page as a block of its
 * own (and shows it nowhere else); here people see where each finding stands and decide about
 * one at a time. Nothing of a page's own content is ever changed.
 *
 *   - {@link SpecLossFindings}: one status's findings a page at a time, of one session
 *     (`narratorId`) or of every session (the admin page; rows then name their session). Each row
 *     shows the file, when it was saved, what kinds of content were lost and, when it is not on
 *     the page, why; and offers: read the lost text, open its block, dismiss it (asked first when
 *     a block goes with it), reopen a dismissed one, or attach one the automatic attach left out.
 *     Rows wrap, so the list holds at a phone's width.
 *   - {@link SpecLossNotice}: the Spec panel's one line when the session has findings, opening
 *     the same list in place.
 */
import {
	Anchor,
	Badge,
	Box,
	Button,
	Chip,
	Collapse,
	Group,
	Loader,
	Paper,
	Stack,
	Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	OUTLINE_SPEC_LOSS_STATUSES,
	type OutlineSpecLossFinding,
	type OutlineSpecLossKind,
	type OutlineSpecLossStatus,
} from "@shared/outline-spec-import";
import {
	IconAlertTriangle,
	IconArrowBackUp,
	IconEye,
	IconEyeOff,
	IconPaperclip,
} from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	useDecideSpecLoss,
	useSpecLossCounts,
	useSpecLossDetail,
	useSpecLossPages,
} from "../../../hooks/useSpecLoss";
import { describeApiError } from "../../../lib/api-error";
import { formatLocaleDateTime } from "../../../lib/intl-format";
import { outlineTargetHref } from "../../../lib/outline-href";
import { useConfirmDialog } from "../../common/confirm-dialog-context";

const STATUS_COLORS: Record<OutlineSpecLossStatus, string> = {
	open: "yellow",
	attached: "teal",
	dismissed: "gray",
};

const KINDS: readonly OutlineSpecLossKind[] = [
	"table",
	"html",
	"image",
	"taskItem",
	"footnote",
	"frontMatter",
];

export function SpecLossFindings({ narratorId = null }: { narratorId?: string | null }) {
	const { t } = useTranslation("narrator");
	const [status, setStatus] = useState<OutlineSpecLossStatus>("open");
	const query = useSpecLossPages(narratorId, status);
	const first = query.data?.pages[0];
	const items = query.data?.pages.flatMap((page) => page.items) ?? [];
	return (
		<Stack gap="xs" data-testid="spec-loss-findings">
			<Chip.Group
				multiple={false}
				value={status}
				onChange={(value) => setStatus(value as OutlineSpecLossStatus)}
			>
				<Group gap={6} data-testid="spec-loss-statuses">
					{OUTLINE_SPEC_LOSS_STATUSES.map((value) => {
						const n = first?.counts[value];
						const shown =
							n === undefined
								? ""
								: n > (first?.countCap ?? 0)
									? ` (${first?.countCap}+)`
									: ` (${n})`;
						return (
							<Chip
								key={value}
								value={value}
								size="xs"
								wrapperProps={{ "data-testid": `spec-loss-status-${value}` }}
							>
								{t(`spec.loss.status.${value}`)}
								{shown}
							</Chip>
						);
					})}
				</Group>
			</Chip.Group>
			{query.isLoading ? (
				<Loader size="sm" />
			) : query.isError ? (
				<Text size="sm" c="red">
					{describeApiError(query.error, t).message}
				</Text>
			) : items.length === 0 ? (
				<Text size="sm" c="dimmed" data-testid="spec-loss-empty">
					{t("spec.loss.empty")}
				</Text>
			) : (
				<Stack gap="xs">
					{items.map((item) => (
						<SpecLossRow
							key={item.id}
							item={item}
							scope={narratorId}
							canAct={first?.canAct === true}
						/>
					))}
				</Stack>
			)}
			{query.hasNextPage && (
				<Group>
					<Button
						size="xs"
						variant="light"
						loading={query.isFetchingNextPage}
						onClick={() => void query.fetchNextPage()}
						data-testid="spec-loss-more"
					>
						{t("spec.loss.more")}
					</Button>
				</Group>
			)}
		</Stack>
	);
}

function SpecLossRow({
	item,
	scope,
	canAct,
}: {
	item: OutlineSpecLossFinding;
	/** The list's session; null on the admin page, whose rows name their session. */
	scope: string | null;
	canAct: boolean;
}) {
	const { t, i18n } = useTranslation("narrator");
	const confirm = useConfirmDialog();
	const [shown, setShown] = useState(false);
	const detail = useSpecLossDetail(scope, item.id, shown);
	const decide = useDecideSpecLoss(scope);
	const act = (action: "attach" | "dismiss" | "reopen") =>
		decide.mutate(
			{ findingId: item.id, action },
			{
				onSuccess: (after) =>
					notifications.show({
						message:
							action === "dismiss" && after.blockId
								? // Someone wrote in its block: it was kept.
									t("spec.loss.done.dismissKept")
								: action === "reopen" && after.status !== "attached"
									? t("spec.loss.done.reopenOpen")
									: t(`spec.loss.done.${action}`),
					}),
				onError: (error) =>
					notifications.show({ color: "red", message: describeApiError(error, t).message }),
			},
		);
	const kinds = KINDS.filter((kind) => (item.kinds[kind] ?? 0) > 0)
		.map((kind) => t(`spec.loss.kind.${kind}`, { count: item.kinds[kind] ?? 0 }))
		.join(t("spec.loss.kindSeparator"));
	// Why an open finding is not on its page.
	const why = !item.attachable ? "not_imported" : (item.attachNote ?? "pending");
	const blockHref =
		item.spaceId && item.blockId
			? outlineTargetHref({ kind: "block", spaceId: item.spaceId, blockId: item.blockId })
			: null;
	return (
		<Paper
			withBorder
			p="xs"
			radius="sm"
			data-testid="spec-loss-row"
			data-finding={item.id}
			data-status={item.status}
		>
			<Group gap={6} wrap="wrap" align="center">
				<Badge size="xs" variant="light" color={STATUS_COLORS[item.status]}>
					{t(`spec.loss.status.${item.status}`)}
				</Badge>
				<Text
					size="sm"
					fw={500}
					ff="monospace"
					style={{ flex: "1 1 120px", minWidth: 0, overflowWrap: "anywhere" }}
					data-testid="spec-loss-path"
				>
					{item.path}
				</Text>
			</Group>
			{scope === null && (
				<Text size="xs" mt={4} style={{ overflowWrap: "anywhere" }}>
					<Link
						to="/narrators/$narratorId"
						params={{ narratorId: item.narratorId }}
						style={{ color: "inherit" }}
					>
						{item.title?.trim() || t("spec.loss.untitled")}
					</Link>
				</Text>
			)}
			<Text
				size="xs"
				c="dimmed"
				mt={4}
				style={{ overflowWrap: "anywhere" }}
				data-testid="spec-loss-what"
			>
				{[
					item.savedAt
						? t("spec.loss.savedAt", {
								date: formatLocaleDateTime(item.savedAt, undefined, i18n.language),
							})
						: null,
					t("spec.loss.lost", { kinds, interpolation: { escapeValue: false } }),
					item.truncated ? t("spec.loss.truncated") : null,
				]
					.filter(Boolean)
					.join(" · ")}
			</Text>
			{item.status === "open" && (
				<Text size="xs" c="dimmed" mt={2} data-testid="spec-loss-why" data-note={why}>
					{t(`spec.loss.why.${why}`)}
				</Text>
			)}
			<Group gap={6} mt={6} wrap="wrap">
				<Button
					size="compact-xs"
					variant="light"
					color="gray"
					leftSection={<IconEye size={12} />}
					onClick={() => setShown((value) => !value)}
					aria-expanded={shown}
					data-testid="spec-loss-view"
				>
					{shown ? t("spec.loss.hide") : t("spec.loss.view")}
				</Button>
				{canAct && item.status === "open" && (
					<Button
						size="compact-xs"
						variant="light"
						leftSection={<IconPaperclip size={12} />}
						disabled={!item.attachable}
						loading={decide.isPending && decide.variables?.action === "attach"}
						onClick={async () => {
							if (
								await confirm({
									title: t("spec.loss.attachTitle"),
									message: t("spec.loss.attachConfirm", { path: item.path }),
									confirmLabel: t("spec.loss.attach"),
								})
							)
								act("attach");
						}}
						data-testid="spec-loss-attach"
					>
						{t("spec.loss.attach")}
					</Button>
				)}
				{canAct && item.status !== "dismissed" && (
					<Button
						size="compact-xs"
						variant="light"
						color="gray"
						leftSection={<IconEyeOff size={12} />}
						loading={decide.isPending && decide.variables?.action === "dismiss"}
						onClick={async () => {
							// A block goes with an attached finding: asked first.
							if (
								item.status === "open" ||
								(await confirm({
									title: t("spec.loss.dismissTitle"),
									message: t("spec.loss.dismissConfirm", { path: item.path }),
									confirmLabel: t("spec.loss.dismiss"),
								}))
							)
								act("dismiss");
						}}
						data-testid="spec-loss-dismiss"
					>
						{t("spec.loss.dismiss")}
					</Button>
				)}
				{canAct && item.status === "dismissed" && (
					<Button
						size="compact-xs"
						variant="light"
						color="gray"
						leftSection={<IconArrowBackUp size={12} />}
						loading={decide.isPending}
						onClick={() => act("reopen")}
						data-testid="spec-loss-reopen"
					>
						{t("spec.loss.reopen")}
					</Button>
				)}
				{blockHref && (
					<Anchor size="xs" href={blockHref} data-testid="spec-loss-open-block">
						{t("spec.loss.openBlock")}
					</Anchor>
				)}
			</Group>
			<Collapse expanded={shown}>
				<Box mt={6} data-testid="spec-loss-detail">
					{detail.isLoading ? (
						<Loader size="xs" />
					) : detail.isError ? (
						<Text size="xs" c="red">
							{describeApiError(detail.error, t).message}
						</Text>
					) : (
						<Stack gap={6}>
							{(detail.data?.parts ?? []).map((part, n) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: the parts of one finding never reorder.
								<Box key={n}>
									<Text size="xs" c="dimmed">
										{t(`spec.loss.kind.${part.kind}`, { count: 1 })}
									</Text>
									<Box
										component="pre"
										m={0}
										p={6}
										fz="xs"
										ff="monospace"
										style={{
											maxHeight: 240,
											overflow: "auto",
											whiteSpace: "pre",
											borderRadius: 4,
											background: "var(--mantine-color-default-hover)",
										}}
									>
										{part.text}
									</Box>
								</Box>
							))}
						</Stack>
					)}
				</Box>
			</Collapse>
		</Paper>
	);
}

/**
 * The Spec panel's line about the session's findings: how many are waiting for a decision, and
 * the list itself on demand. Nothing while the session has none.
 */
export function SpecLossNotice({ narratorId }: { narratorId: string }) {
	const { t } = useTranslation("narrator");
	const [open, setOpen] = useState(false);
	const { data } = useSpecLossCounts(narratorId);
	if (!data) return null;
	const waiting = data.counts.open;
	const onPage = data.counts.attached;
	const decided = data.counts.dismissed;
	if (waiting + onPage + decided === 0) return null;
	const cap = (n: number) => (n > data.countCap ? `${data.countCap}+` : String(n));
	return (
		<Box
			px="sm"
			py={6}
			data-testid="spec-loss-notice"
			style={{
				flexShrink: 0,
				minHeight: 0,
				display: "flex",
				flexDirection: "column",
				maxHeight: open ? "60%" : undefined,
				borderBottom: "1px solid var(--mantine-color-default-border)",
			}}
		>
			<Group gap={6} wrap="nowrap" align="flex-start" style={{ flexShrink: 0 }}>
				<IconAlertTriangle
					size={13}
					color={waiting > 0 ? "var(--mantine-color-yellow-6)" : "var(--mantine-color-dimmed)"}
					style={{ marginTop: 2, flexShrink: 0 }}
				/>
				<Text size="xs" style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
					{waiting + onPage > 0
						? t("spec.loss.notice", { attached: cap(onPage), open: cap(waiting) })
						: t("spec.loss.noticeDecided", { n: cap(decided) })}{" "}
					<Anchor
						component="button"
						type="button"
						size="xs"
						onClick={() => setOpen((value) => !value)}
						aria-expanded={open}
						data-testid="spec-loss-notice-toggle"
					>
						{open ? t("spec.loss.noticeHide") : t("spec.loss.noticeShow")}
					</Anchor>
				</Text>
			</Group>
			{open && (
				<Box mt={6} style={{ minHeight: 0, overflowY: "auto" }}>
					<Text size="xs" c="dimmed" mb={6}>
						{t("spec.loss.explain")}
					</Text>
					<SpecLossFindings narratorId={narratorId} />
				</Box>
			)}
		</Box>
	);
}

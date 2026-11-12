/**
 * The Dynamic Spec import as an administrator sees it (outline P2 PR 12b2): how imports run
 * (`outline.specImport`), how many sessions are in each state, and one state's sessions a page at
 * a time, each with what may be done to it: import it again (attention and failed attempts
 * cleared), or move a session the import moved back to Dynamic Spec (confirmed first; nothing is
 * deleted). Counts and pages are the server's bounded reads; nothing here counts by itself.
 * Laid out as wrapping rows, so it holds at a phone's width.
 */
import { Badge, Box, Button, Chip, Group, Loader, Paper, Stack, Text, Title } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
	OUTLINE_SPEC_IMPORT_ADMIN_STATES,
	type OutlineSpecImportAdminItem,
	type OutlineSpecImportAdminPage,
	type OutlineSpecImportAdminState,
} from "@shared/outline-spec-import";
import { IconArrowBackUp, IconRefresh } from "@tabler/icons-react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOutlineEnabled } from "../../hooks/useOutlineEnabled";
import { api } from "../../lib/api";
import { describeApiError } from "../../lib/api-error";
import { formatLocaleDateTime } from "../../lib/intl-format";
import { useConfirmDialog } from "../common/confirm-dialog-context";

const PAGE = 20;

export const specImportAdminKey = (state: OutlineSpecImportAdminState) =>
	["admin", "outline", "spec-import", state] as const;

const STATE_COLORS: Record<OutlineSpecImportAdminState, string> = {
	attention: "yellow",
	failed: "red",
	busy: "gray",
	running: "indigo",
	imported: "teal",
	reverted: "grape",
	idle: "gray",
};

export function SpecImportAdminSection() {
	const { t } = useTranslation("settings");
	const outline = useOutlineEnabled();
	const [state, setState] = useState<OutlineSpecImportAdminState>("attention");
	const queryClient = useQueryClient();
	const query = useInfiniteQuery({
		queryKey: specImportAdminKey(state),
		queryFn: ({ pageParam }) =>
			api.getSpecImportAdminPage({ state, cursor: pageParam, limit: PAGE }),
		initialPageParam: null as string | null,
		getNextPageParam: (last: OutlineSpecImportAdminPage) => last.next,
		enabled: outline.enabled,
	});
	const first = query.data?.pages[0];
	const items = query.data?.pages.flatMap((page) => page.items) ?? [];
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: ["admin", "outline", "spec-import"] });

	if (outline.loading) return <Loader size="sm" />;
	if (!outline.enabled)
		return (
			<Text size="sm" c="dimmed" data-testid="spec-import-admin-off">
				{t("specImportAdminOutlineOff")}
			</Text>
		);
	return (
		<Stack gap="sm" data-testid="spec-import-admin">
			<Stack gap={4}>
				<Title order={4}>{t("specImportAdminTitle")}</Title>
				<Text size="sm" c="dimmed">
					{t("specImportAdminDescription")}
				</Text>
				<Text size="sm" c="dimmed" data-testid="spec-import-admin-kept-help">
					{t("specImportAdminKeptBlocksHelp")}
				</Text>
				{first && (
					<Text size="sm" data-testid="spec-import-admin-mode">
						{t(`specImportAdminMode.${first.mode}`)}
					</Text>
				)}
			</Stack>
			<Chip.Group
				multiple={false}
				value={state}
				onChange={(value) => setState(value as OutlineSpecImportAdminState)}
			>
				<Group gap={6} data-testid="spec-import-admin-states">
					{OUTLINE_SPEC_IMPORT_ADMIN_STATES.map((value) => {
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
								wrapperProps={{ "data-testid": `spec-import-state-${value}` }}
							>
								{t(`specImportAdminState.${value}`)}
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
				<Text size="sm" c="dimmed" data-testid="spec-import-admin-empty">
					{t("specImportAdminEmpty")}
				</Text>
			) : (
				<Stack gap="xs">
					{items.map((item) => (
						<SpecImportAdminRow key={item.narratorId} item={item} onChanged={refresh} />
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
						data-testid="spec-import-admin-more"
					>
						{t("specImportAdminMore")}
					</Button>
				</Group>
			)}
		</Stack>
	);
}

function SpecImportAdminRow({
	item,
	onChanged,
}: {
	item: OutlineSpecImportAdminItem;
	onChanged: () => void;
}) {
	const { t, i18n } = useTranslation("settings");
	const { t: tn } = useTranslation("narrator");
	const confirm = useConfirmDialog();
	const failed = (error: unknown) =>
		notifications.show({ color: "red", message: describeApiError(error, t).message });
	const reimport = useMutation({
		mutationFn: () => api.reimportSpecSession(item.narratorId),
		onSuccess: () => {
			notifications.show({ message: t("specImportAdminReimported") });
			onChanged();
		},
		onError: failed,
	});
	const revert = useMutation({
		mutationFn: () => api.revertSpecImport(item.narratorId),
		onSuccess: (result) => {
			notifications.show({
				message: result.marked
					? t("specImportAdminReverted")
					: t("specImportAdminRevertedUnmarked"),
			});
			// The old fence could not be written back: the session runs without its old rules.
			if (!result.fenceRestored)
				notifications.show({
					color: "yellow",
					autoClose: false,
					message: t("specImportAdminFenceNotRestored"),
					"data-testid": "spec-import-admin-fence-warning",
				} as Parameters<typeof notifications.show>[0]);
			onChanged();
		},
		onError: failed,
	});
	const reason = item.reason
		? tn(`spec.specImportReason.${item.reason.code}`, { n: item.reason.count ?? 0 })
		: null;
	return (
		<Paper
			withBorder
			p="xs"
			radius="sm"
			data-testid="spec-import-admin-row"
			data-narrator={item.narratorId}
		>
			<Group gap={6} wrap="wrap" align="center">
				<Badge size="xs" variant="light" color={STATE_COLORS[item.state]}>
					{t(`specImportAdminState.${item.state}`)}
				</Badge>
				<Box style={{ flex: "1 1 160px", minWidth: 0 }}>
					<Link
						to="/narrators/$narratorId"
						params={{ narratorId: item.narratorId }}
						style={{ color: "inherit", textDecoration: "none" }}
					>
						<Text size="sm" fw={500} style={{ overflowWrap: "anywhere" }}>
							{item.title?.trim() || t("specImportAdminUntitled")}
						</Text>
					</Link>
				</Box>
			</Group>
			<Text size="xs" c="dimmed" mt={4} style={{ overflowWrap: "anywhere" }}>
				{[
					item.ownerName ? t("specImportAdminOwner", { name: item.ownerName }) : null,
					t(`specImportAdminBackend.${item.taskBackend === "outline" ? "outline" : "spec"}`),
					item.attempts > 0 ? t("specImportAdminAttempts", { count: item.attempts }) : null,
					item.revertCount > 0 ? t("specImportAdminReverts", { count: item.revertCount }) : null,
					formatLocaleDateTime(item.updatedAt, undefined, i18n.language),
				]
					.filter(Boolean)
					.join(" · ")}
			</Text>
			{reason && (
				<Text
					size="xs"
					mt={2}
					style={{ overflowWrap: "anywhere" }}
					data-testid="spec-import-admin-reason"
				>
					{tn("spec.specImportError", { error: reason, interpolation: { escapeValue: false } })}
				</Text>
			)}
			{(item.canReimport || item.canRevert) && (
				<Group gap={6} mt={6} wrap="wrap">
					{item.canReimport && (
						<Button
							size="compact-xs"
							variant="light"
							leftSection={<IconRefresh size={12} />}
							loading={reimport.isPending}
							onClick={() => reimport.mutate()}
							data-testid="spec-import-admin-reimport"
						>
							{t("specImportAdminReimport")}
						</Button>
					)}
					{item.canRevert && (
						<Button
							size="compact-xs"
							variant="light"
							color="grape"
							leftSection={<IconArrowBackUp size={12} />}
							loading={revert.isPending}
							onClick={async () => {
								if (
									await confirm({
										title: t("specImportAdminRevertTitle"),
										message: t("specImportAdminRevertConfirm"),
										confirmLabel: t("specImportAdminRevert"),
									})
								)
									revert.mutate();
							}}
							data-testid="spec-import-admin-revert"
						>
							{t("specImportAdminRevert")}
						</Button>
					)}
				</Group>
			)}
		</Paper>
	);
}

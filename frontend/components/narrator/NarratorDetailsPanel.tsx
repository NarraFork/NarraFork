import {
	Badge,
	Box,
	Button,
	CloseButton,
	Code,
	Divider,
	Drawer,
	Group,
	Paper,
	ScrollArea,
	SimpleGrid,
	Stack,
	Text,
	Tooltip,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useBrowserSessions } from "../../hooks/useBrowserSessions";
import { useChapter } from "../../hooks/useChapters";
import {
	useBlacklistDirs,
	useCmdBlacklist,
	useCmdWhitelist,
	useNarrator,
	useUpdateCwd,
	useWhitelistDirs,
} from "../../hooks/useNarrator";
import { usePermissions } from "../../hooks/usePermissions";
import { useNarratorTerminals } from "../../hooks/useTerminals";
import type {
	ApiEntity,
	BlacklistCmd,
	BlacklistDir,
	WhitelistCmd,
	WhitelistDir,
} from "../../lib/api";
import { FOLLOW_DEFAULT_MODEL, NARRATOR_STATUS_COLORS } from "../../lib/constants";
import { DirectoryPicker } from "../common/DirectoryPicker";
import { UserAvatar } from "../UserAvatar";
import type { ViewerInfo } from "./useNarratorPanelWS";

interface NarratorDetailsPanelProps {
	opened: boolean;
	onClose: () => void;
	narratorId: string;
	narrator: ApiEntity;
	viewers: ViewerInfo[];
	defaultModelValue?: string;
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<Stack gap="xs">
			<Text size="xs" fw={700} c="dimmed" tt="uppercase">
				{title}
			</Text>
			<Paper withBorder p="sm" radius="md">
				<Stack gap="sm">{children}</Stack>
			</Paper>
		</Stack>
	);
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
			<Text size="sm" c="dimmed" style={{ flexShrink: 0 }}>
				{label}
			</Text>
			<Box style={{ flex: 1, minWidth: 0, textAlign: "right" }}>{value}</Box>
		</Group>
	);
}

function StatCard({
	label,
	value,
	hint,
}: {
	label: string;
	value: React.ReactNode;
	hint?: string;
}) {
	return (
		<Paper withBorder p="sm" radius="md">
			<Stack gap={4}>
				<Text size="xs" c="dimmed">
					{label}
				</Text>
				<Text fw={700} size="lg">
					{value}
				</Text>
				{hint ? (
					<Text size="xs" c="dimmed">
						{hint}
					</Text>
				) : null}
			</Stack>
		</Paper>
	);
}

function RuleList({
	items,
	emptyLabel,
	renderItem,
}: {
	items: readonly unknown[] | undefined;
	emptyLabel: string;
	renderItem: (item: unknown, index: number) => React.ReactNode;
}) {
	if (!items?.length) {
		return (
			<Text size="sm" c="dimmed">
				{emptyLabel}
			</Text>
		);
	}

	return <Stack gap="xs">{items.map((item, index) => renderItem(item, index))}</Stack>;
}

export function NarratorDetailsPanel({
	opened,
	onClose,
	narratorId,
	narrator,
	viewers,
	defaultModelValue,
}: NarratorDetailsPanelProps) {
	const isMobile = useMediaQuery("(max-width: 768px)") ?? false;
	const navigate = useNavigate();
	const { t, i18n } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");

	const chapterId = narrator?.chapterId ? String(narrator.chapterId) : "";
	const parentNarratorId = narrator?.parentNarratorId ? String(narrator.parentNarratorId) : "";

	const { data: chapter } = useChapter(opened ? chapterId : "");
	const { data: parentNarrator } = useNarrator(opened ? parentNarratorId : "");
	const updateCwdMutation = useUpdateCwd();
	const { data: terminals } = useNarratorTerminals(opened ? narratorId : "");
	const { data: pendingPermissions } = usePermissions(opened ? narratorId : "");
	const { data: browserSessions } = useBrowserSessions(opened ? narratorId : "");
	const { data: whitelistDirs } = useWhitelistDirs(opened ? narratorId : "");
	const { data: blacklistDirs } = useBlacklistDirs(opened ? narratorId : "");
	const { data: cmdWhitelist } = useCmdWhitelist(opened ? narratorId : "");
	const { data: cmdBlacklist } = useCmdBlacklist(opened ? narratorId : "");

	const resolvedModel =
		narrator?.model && narrator.model !== FOLLOW_DEFAULT_MODEL
			? narrator.model
			: defaultModelValue || narrator?.model || t("details.notAvailable");

	const activeTerminalCount = useMemo(
		() => (terminals ?? []).filter((terminal) => terminal.status === "running").length,
		[terminals],
	);

	const enabledTools = Array.isArray(narrator?.enabledTools)
		? (narrator.enabledTools as string[])
		: [];
	const [cwdValue, setCwdValue] = useState(String(narrator?.cwd ?? ""));
	const [cwdDirty, setCwdDirty] = useState(false);

	const formatDateTime = (value?: string | null) => {
		if (!value) return t("details.notAvailable");
		const date = new Date(value);
		if (Number.isNaN(date.getTime())) return value;
		return new Intl.DateTimeFormat(i18n.language, {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(date);
	};

	const formatBoolean = (value?: boolean | null) => (value ? t("details.on") : t("details.off"));

	const formatStatus = (status?: string | null) => {
		if (!status) return t("details.notAvailable");
		const key = `status_${status}`;
		const translated = t(key);
		return translated === key ? status : translated;
	};

	const formatPermissionMode = (mode?: string | null) => {
		if (!mode) return t("details.notAvailable");
		const key = `perm_${mode}`;
		const translated = t(key);
		return translated === key ? mode : translated;
	};

	const formatReasoningEffort = (effort?: string | null) => {
		if (!effort) return t("reasoning_auto");
		const key = `reasoning_${effort}`;
		const translated = t(key);
		return translated === key ? effort : translated;
	};

	const formatNarratorType = (type?: string | null) => {
		if (!type) return t("details.notAvailable");
		const key = `details.type_${type}`;
		const translated = t(key);
		return translated === key ? type : translated;
	};

	const formatInheritMode = (mode?: string | null) => {
		if (!mode) return t("details.notAvailable");
		const key = `details.inherit_${mode}`;
		const translated = t(key);
		return translated === key ? mode : translated;
	};

	const formatBackgroundStatus = (status?: string | null) => {
		if (!status) return t("details.notAvailable");
		const key = `details.backgroundStatus_${status}`;
		const translated = t(key);
		return translated === key ? status : translated;
	};

	useEffect(() => {
		setCwdValue(String(narrator?.cwd ?? ""));
		setCwdDirty(false);
	}, [narrator?.cwd]);

	const openChapter = () => {
		if (!chapterId) return;
		onClose();
		navigate({ to: "/chapters/$chapterId", params: { chapterId } });
	};

	const openParentNarrator = () => {
		if (!parentNarratorId) return;
		onClose();
		navigate({ to: "/narrators/$narratorId", params: { narratorId: parentNarratorId } });
	};

	const handleSaveCwd = async () => {
		const nextCwd = cwdValue.trim();
		if (!nextCwd) {
			notifications.show({
				title: t("details.cwdUpdateErrorTitle"),
				message: t("details.cwdRequired"),
				color: "red",
			});
			return;
		}
		try {
			const result = await updateCwdMutation.mutateAsync({ id: narratorId, cwd: nextCwd });
			setCwdDirty(false);
			notifications.show({
				title: t("details.cwdUpdatedTitle"),
				message: result.changed ? t("details.cwdUpdated") : t("details.cwdUnchanged"),
				color: result.changed ? "teal" : "blue",
			});
		} catch (error) {
			notifications.show({
				title: t("details.cwdUpdateErrorTitle"),
				message: error instanceof Error ? error.message : t("details.cwdUpdateError"),
				color: "red",
			});
		}
	};

	const content = (
		<Stack gap="md">
			<SimpleGrid cols={2} spacing="sm">
				<StatCard
					label={t("details.stats.messages")}
					value={(narrator?.messageCount ?? 0).toLocaleString(i18n.language)}
				/>
				<StatCard
					label={t("details.stats.cost")}
					value={`$${Number(narrator?.totalCostUsd ?? 0).toFixed(4)}`}
				/>
				<StatCard
					label={t("details.stats.viewers")}
					value={viewers.length.toLocaleString(i18n.language)}
				/>
				<StatCard
					label={t("details.stats.terminals")}
					value={activeTerminalCount.toLocaleString(i18n.language)}
				/>
				<StatCard
					label={t("details.stats.browserSessions")}
					value={(browserSessions?.length ?? 0).toLocaleString(i18n.language)}
				/>
				<StatCard
					label={t("details.stats.pendingPermissions")}
					value={(pendingPermissions?.length ?? 0).toLocaleString(i18n.language)}
				/>
			</SimpleGrid>

			<DetailSection title={t("details.basic")}>
				<DetailRow
					label={t("details.status")}
					value={
						<Badge color={NARRATOR_STATUS_COLORS[narrator?.status] ?? "gray"} variant="light">
							{formatStatus(narrator?.status)}
						</Badge>
					}
				/>
				<DetailRow label={t("details.id")} value={<Code>{narrator?.id || narratorId}</Code>} />
				<DetailRow
					label={t("details.type")}
					value={<Text size="sm">{formatNarratorType(narrator?.type)}</Text>}
				/>
				{narrator?.subagentType ? (
					<DetailRow
						label={t("details.subagentType")}
						value={<Badge variant="outline">{String(narrator.subagentType)}</Badge>}
					/>
				) : null}
				<Stack gap="xs">
					<Group justify="space-between" align="center" wrap="nowrap" gap="md">
						<Text size="sm" c="dimmed">
							{t("details.cwd")}
						</Text>
						{narrator?.cwd ? (
							<Tooltip label={String(narrator.cwd)} multiline>
								<Text size="xs" ff="monospace" c="dimmed" truncate maw={260}>
									{String(narrator.cwd)}
								</Text>
							</Tooltip>
						) : null}
					</Group>
					<DirectoryPicker
						value={cwdValue}
						onChange={(value) => {
							setCwdValue(value);
							setCwdDirty(value.trim() !== String(narrator?.cwd ?? "").trim());
						}}
						placeholder={t("details.cwdPlaceholder")}
						description={t("details.cwdDescription")}
						disabled={updateCwdMutation.isPending}
					/>
					<Group justify="flex-end" gap="xs">
						<Button
							variant="default"
							size="xs"
							disabled={!cwdDirty || updateCwdMutation.isPending}
							onClick={() => {
								setCwdValue(String(narrator?.cwd ?? ""));
								setCwdDirty(false);
							}}
						>
							{t("cancel")}
						</Button>
						<Button
							size="xs"
							loading={updateCwdMutation.isPending}
							disabled={!cwdDirty}
							onClick={handleSaveCwd}
						>
							{tc("save")}
						</Button>
					</Group>
				</Stack>
				<DetailRow
					label={t("details.createdAt")}
					value={<Text size="sm">{formatDateTime(narrator?.createdAt)}</Text>}
				/>
				<DetailRow
					label={t("details.updatedAt")}
					value={<Text size="sm">{formatDateTime(narrator?.updatedAt)}</Text>}
				/>
				<DetailRow
					label={t("details.lastMessageAt")}
					value={<Text size="sm">{formatDateTime(narrator?.lastMessageAt)}</Text>}
				/>
				<DetailRow
					label={t("details.turnStartedAt")}
					value={<Text size="sm">{formatDateTime(narrator?.turnStartedAt)}</Text>}
				/>
				{narrator?.apiConversationId ? (
					<DetailRow
						label={t("details.apiConversationId")}
						value={<Code>{String(narrator.apiConversationId)}</Code>}
					/>
				) : null}
				{narrator?.errorMessage ? (
					<DetailRow
						label={t("details.errorMessage")}
						value={
							<Text size="sm" c="red" ta="left">
								{String(narrator.errorMessage)}
							</Text>
						}
					/>
				) : null}
			</DetailSection>

			<DetailSection title={t("details.session")}>
				<DetailRow
					label={t("details.model")}
					value={
						<Text size="sm" ff="monospace">
							{resolvedModel}
						</Text>
					}
				/>
				<DetailRow
					label={t("details.permissionMode")}
					value={<Text size="sm">{formatPermissionMode(narrator?.permissionMode)}</Text>}
				/>
				<DetailRow
					label={t("details.reasoningEffort")}
					value={<Text size="sm">{formatReasoningEffort(narrator?.reasoningEffort)}</Text>}
				/>
				<DetailRow
					label={t("details.fastMode")}
					value={<Text size="sm">{formatBoolean(narrator?.fastMode)}</Text>}
				/>
				<DetailRow
					label={t("details.relaxedPlan")}
					value={<Text size="sm">{formatBoolean(narrator?.relaxedPlan)}</Text>}
				/>
				<DetailRow
					label={t("details.pruneEnabled")}
					value={<Text size="sm">{formatBoolean(narrator?.pruneEnabled ?? true)}</Text>}
				/>
				<DetailRow
					label={t("details.planMode")}
					value={<Text size="sm">{formatBoolean(narrator?.planMode)}</Text>}
				/>
				<DetailRow
					label={t("details.backgroundStatus")}
					value={<Text size="sm">{formatBackgroundStatus(narrator?.backgroundStatus)}</Text>}
				/>
				{narrator?.pendingModelRestore ? (
					<DetailRow
						label={t("details.pendingModelRestore")}
						value={<Code>{String(narrator.pendingModelRestore)}</Code>}
					/>
				) : null}
				<DetailRow
					label={t("details.enabledTools")}
					value={
						enabledTools.length ? (
							<Group justify="flex-end" gap={4}>
								{enabledTools.map((tool) => (
									<Badge key={tool} variant="outline" size="sm">
										{tool}
									</Badge>
								))}
							</Group>
						) : (
							<Text size="sm" c="dimmed">
								{t("details.none")}
							</Text>
						)
					}
				/>
				{narrator?.backgroundResult ? (
					<DetailRow
						label={t("details.backgroundResult")}
						value={
							<Text size="sm" ta="left" style={{ whiteSpace: "pre-wrap" }}>
								{String(narrator.backgroundResult)}
							</Text>
						}
					/>
				) : null}
			</DetailSection>

			<DetailSection title={t("details.relationships")}>
				<DetailRow
					label={t("details.chapter")}
					value={
						chapterId ? (
							<Stack gap={6} align="flex-end">
								<Text size="sm">{chapter?.title || chapterId}</Text>
								<Group gap={6} justify="flex-end">
									<Badge variant="outline">{chapterId.slice(0, 8)}</Badge>
									<Button variant="light" size="compact-xs" onClick={openChapter}>
										{t("details.openChapter")}
									</Button>
								</Group>
							</Stack>
						) : (
							<Text size="sm" c="dimmed">
								{t("details.standalone")}
							</Text>
						)
					}
				/>
				{parentNarratorId ? (
					<DetailRow
						label={t("details.parentNarrator")}
						value={
							<Stack gap={6} align="flex-end">
								<Text size="sm">{parentNarrator?.title || parentNarratorId}</Text>
								<Group gap={6} justify="flex-end">
									<Badge variant="outline">{parentNarratorId.slice(0, 8)}</Badge>
									<Button variant="light" size="compact-xs" onClick={openParentNarrator}>
										{t("details.openNarrator")}
									</Button>
								</Group>
							</Stack>
						}
					/>
				) : null}
				<DetailRow
					label={t("details.inheritMode")}
					value={<Text size="sm">{formatInheritMode(narrator?.inheritMode)}</Text>}
				/>
				<DetailRow
					label={t("details.forkMessageId")}
					value={
						narrator?.forkMessageId ? (
							<Code>{String(narrator.forkMessageId)}</Code>
						) : (
							<Text size="sm" c="dimmed">
								{t("details.none")}
							</Text>
						)
					}
				/>
			</DetailSection>

			<DetailSection title={t("details.activity")}>
				<DetailRow
					label={t("details.viewerNames")}
					value={
						viewers.length ? (
							<Stack gap={6} align="flex-end">
								{viewers.map((viewer) => (
									<Group key={viewer.userId} gap={8} wrap="nowrap">
										<Text size="sm">{viewer.username}</Text>
										<UserAvatar
											username={viewer.username}
											avatarColor={viewer.avatarColor}
											avatarImageId={viewer.avatarImageId}
											userId={viewer.userId}
											size={22}
											showTooltip={false}
										/>
									</Group>
								))}
							</Stack>
						) : (
							<Text size="sm" c="dimmed">
								{t("details.none")}
							</Text>
						)
					}
				/>
				<DetailRow
					label={t("details.browserSessions")}
					value={
						browserSessions?.length ? (
							<Stack gap={6} align="flex-end">
								{browserSessions.map((session) => (
									<Group key={session.id} gap={6} justify="flex-end">
										<Badge variant="outline">{session.id.slice(0, 8)}</Badge>
										<Text size="sm" ff="monospace" truncate maw={220} title={session.url}>
											{session.url}
										</Text>
									</Group>
								))}
							</Stack>
						) : (
							<Text size="sm" c="dimmed">
								{t("details.none")}
							</Text>
						)
					}
				/>
				<DetailRow
					label={t("details.pendingPermissions")}
					value={
						pendingPermissions?.length ? (
							<Stack gap={6} align="flex-end">
								{pendingPermissions.map((permission) => (
									<Group key={permission.id} gap={6} justify="flex-end">
										<Badge color="yellow" variant="light">
											{permission.toolName}
										</Badge>
										<Badge variant="outline">{permission.id.slice(0, 8)}</Badge>
									</Group>
								))}
							</Stack>
						) : (
							<Text size="sm" c="dimmed">
								{t("details.none")}
							</Text>
						)
					}
				/>
			</DetailSection>

			<DetailSection title={t("details.rules")}>
				<Stack gap="xs">
					<Text size="sm" fw={600}>
						{t("details.whitelistDirs")} ·{" "}
						{(whitelistDirs?.length ?? 0).toLocaleString(i18n.language)}
					</Text>
					<RuleList
						items={whitelistDirs}
						emptyLabel={t("details.emptyRules")}
						renderItem={(item) => {
							const rule = item as WhitelistDir;
							return (
								<Paper key={rule.id} withBorder p="xs" radius="sm">
									<Group justify="space-between" align="flex-start" wrap="nowrap">
										<Box style={{ flex: 1, minWidth: 0 }}>
											<Text size="sm" ff="monospace" truncate title={rule.path}>
												{rule.path}
											</Text>
										</Box>
										<Group gap={4}>
											<Badge variant="outline">{t(`whitelist_access_${rule.accessLevel}`)}</Badge>
											{!rule.enabled ? <Badge color="gray">{t("details.off")}</Badge> : null}
										</Group>
									</Group>
								</Paper>
							);
						}}
					/>
				</Stack>

				<Divider />

				<Stack gap="xs">
					<Text size="sm" fw={600}>
						{t("details.blacklistDirs")} ·{" "}
						{(blacklistDirs?.length ?? 0).toLocaleString(i18n.language)}
					</Text>
					<RuleList
						items={blacklistDirs}
						emptyLabel={t("details.emptyRules")}
						renderItem={(item) => {
							const rule = item as BlacklistDir;
							return (
								<Paper key={rule.id} withBorder p="xs" radius="sm">
									<Group justify="space-between" align="flex-start" wrap="nowrap">
										<Box style={{ flex: 1, minWidth: 0 }}>
											<Text size="sm" ff="monospace" truncate title={rule.path}>
												{rule.path}
											</Text>
										</Box>
										<Group gap={4}>
											<Badge variant="outline">{t(`blacklist_deny_${rule.denyLevel}`)}</Badge>
											{!rule.enabled ? <Badge color="gray">{t("details.off")}</Badge> : null}
										</Group>
									</Group>
								</Paper>
							);
						}}
					/>
				</Stack>

				<Divider />

				<Stack gap="xs">
					<Text size="sm" fw={600}>
						{t("details.cmdWhitelist")} ·{" "}
						{(cmdWhitelist?.length ?? 0).toLocaleString(i18n.language)}
					</Text>
					<RuleList
						items={cmdWhitelist}
						emptyLabel={t("details.emptyRules")}
						renderItem={(item) => {
							const rule = item as WhitelistCmd;
							return (
								<Paper key={rule.id} withBorder p="xs" radius="sm">
									<Group justify="space-between" align="flex-start" wrap="nowrap">
										<Text size="sm" ff="monospace" style={{ flex: 1, minWidth: 0 }}>
											{rule.pattern}
										</Text>
										{!rule.enabled ? <Badge color="gray">{t("details.off")}</Badge> : null}
									</Group>
								</Paper>
							);
						}}
					/>
				</Stack>

				<Divider />

				<Stack gap="xs">
					<Text size="sm" fw={600}>
						{t("details.cmdBlacklist")} ·{" "}
						{(cmdBlacklist?.length ?? 0).toLocaleString(i18n.language)}
					</Text>
					<RuleList
						items={cmdBlacklist}
						emptyLabel={t("details.emptyRules")}
						renderItem={(item) => {
							const rule = item as BlacklistCmd;
							return (
								<Paper key={rule.id} withBorder p="xs" radius="sm">
									<Stack gap={6}>
										<Group justify="space-between" align="flex-start" wrap="nowrap">
											<Text size="sm" ff="monospace" style={{ flex: 1, minWidth: 0 }}>
												{rule.pattern}
											</Text>
											{!rule.enabled ? <Badge color="gray">{t("details.off")}</Badge> : null}
										</Group>
										{rule.denyPrompt ? (
											<Text size="xs" c="dimmed" style={{ whiteSpace: "pre-wrap" }}>
												{rule.denyPrompt}
											</Text>
										) : null}
									</Stack>
								</Paper>
							);
						}}
					/>
				</Stack>
			</DetailSection>

			{narrator?.contextSummary ? (
				<DetailSection title={t("details.contextSummary")}>
					<Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
						{String(narrator.contextSummary)}
					</Text>
				</DetailSection>
			) : null}
		</Stack>
	);

	if (isMobile) {
		return (
			<Drawer
				opened={opened}
				onClose={onClose}
				position="right"
				size="100%"
				title={t("details.title")}
				padding="md"
			>
				{content}
			</Drawer>
		);
	}

	return (
		<Drawer
			opened={opened}
			onClose={onClose}
			position="right"
			size={440}
			withCloseButton={false}
			title={
				<Group justify="space-between" w="100%" wrap="nowrap">
					<Text fw={600}>{t("details.title")}</Text>
					<CloseButton onClick={onClose} />
				</Group>
			}
			padding={0}
		>
			<ScrollArea h="100%" p="md">
				{content}
			</ScrollArea>
		</Drawer>
	);
}

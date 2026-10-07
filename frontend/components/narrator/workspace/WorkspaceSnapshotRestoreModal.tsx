import {
	Alert,
	Badge,
	Button,
	Checkbox,
	Code,
	Divider,
	Group,
	Loader,
	Modal,
	ScrollArea,
	Stack,
	Text,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../../hooks/useAuth";
import { useWorkspaceContext } from "../../../hooks/useWorkspaceContext";
import {
	restoreViewScope,
	useWorkspaceSnapshotRestoreFlow,
	useWorkspaceSnapshots,
} from "../../../hooks/useWorkspaceSnapshotRestores";
import type {
	WorkspaceSnapshotRestorePreview,
	WorkspaceSnapshotSummary,
} from "../../../lib/api/workspace-snapshot-restores";
import { formatLocaleDateTime } from "../../../lib/intl-format";
import { snapshotIsCandidate } from "./snapshot-restore-flow";

export function WorkspaceSnapshotRestoreModal({
	narratorId,
	opened,
	onClose,
}: {
	narratorId: string;
	opened: boolean;
	onClose: () => void;
}) {
	const { data: user } = useCurrentUser();
	const { t } = useTranslation("narrator");
	return user?.id ? (
		<ScopedWorkspaceSnapshotRestoreModal
			key={`${user.id}:${narratorId}`}
			actorId={user.id}
			narratorId={narratorId}
			opened={opened}
			onClose={onClose}
		/>
	) : (
		<Modal opened={opened} onClose={onClose} title={t("snapshotRestore.title")}>
			<Loader size="sm" />
		</Modal>
	);
}
function ScopedWorkspaceSnapshotRestoreModal({
	actorId,
	narratorId,
	opened,
	onClose,
}: {
	actorId: string;
	narratorId: string;
	opened: boolean;
	onClose: () => void;
}) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const { data: context } = useWorkspaceContext(narratorId);
	const scope = restoreViewScope(narratorId, context);
	const [cursor, setCursor] = useState<string>();
	// biome-ignore lint/correctness/useExhaustiveDependencies: never reuse an opaque catalogue cursor in a different view scope
	useEffect(() => setCursor(undefined), [scope]);
	const catalogue = useWorkspaceSnapshots(narratorId, context, cursor);
	const { flow, state, storageError } = useWorkspaceSnapshotRestoreFlow(
		narratorId,
		actorId,
		context,
	);
	const [, tick] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => {
			flow.observeScope();
			tick((value) => value + 1);
		}, 1000);
		return () => clearInterval(timer);
	}, [flow]);
	useEffect(() => {
		flow.observeSnapshot(catalogue.data?.items.find((item) => item.id === state.snapshot?.id));
	}, [flow, catalogue.data, state.snapshot?.id]);
	const close = () => {
		if (flow.cancel()) onClose();
	};
	const source = state.pending?.origin ?? state.preview?.origin;
	const snapshot = state.snapshot;
	const busy = flow.busy;
	const previewable =
		!!snapshot &&
		snapshotIsCandidate(snapshot) &&
		!state.pending &&
		!busy &&
		!!scope &&
		!storageError;
	const error = storageError ?? state.error;
	const errorText = error?.startsWith("snapshotRestore.") ? t(error) : error;
	return (
		<Modal
			opened={opened}
			onClose={close}
			title={t("snapshotRestore.title")}
			size="lg"
			closeButtonProps={{ disabled: busy }}
		>
			<Stack gap="sm">
				<Alert color="orange">{t("snapshotRestore.warning")}</Alert>
				<Text size="xs" c="dimmed">
					{t("snapshotRestore.notUndo")}
				</Text>
				{catalogue.error && (
					<Alert color="red">
						{catalogue.error.message}
						<Button size="xs" variant="subtle" onClick={() => void catalogue.refetch()}>
							{tc("retry")}
						</Button>
					</Alert>
				)}
				{errorText && <Alert color="red">{errorText}</Alert>}
				{!state.pending && (
					<>
						<Group justify="space-between">
							<Text size="sm" fw={600}>
								{t("snapshotRestore.choose")}
							</Text>
							<Button
								size="xs"
								variant="subtle"
								disabled={busy}
								onClick={() => void catalogue.refetch()}
							>
								{tc("refresh")}
							</Button>
						</Group>
						<ScrollArea mah={240}>
							<Stack gap="xs">
								{catalogue.isLoading ? (
									<Loader size="sm" />
								) : !catalogue.data?.items.length ? (
									<Text size="xs" c="dimmed">
										{t("snapshotRestore.empty")}
									</Text>
								) : (
									catalogue.data.items
										.slice(0, 32)
										.map((item) => (
											<SnapshotChoice
												key={item.id}
												item={item}
												selected={snapshot?.id === item.id}
												disabled={busy || !!storageError}
												onSelect={() => flow.select(item)}
											/>
										))
								)}
							</Stack>
						</ScrollArea>
						<Group justify="space-between">
							<Button
								size="xs"
								variant="default"
								disabled={!cursor || busy}
								onClick={() => setCursor(undefined)}
							>
								{t("snapshotRestore.firstPage")}
							</Button>
							<Button
								size="xs"
								variant="default"
								disabled={!catalogue.data?.nextCursor || busy}
								onClick={() => setCursor(catalogue.data?.nextCursor ?? undefined)}
							>
								{t("snapshotRestore.nextPage")}
							</Button>
						</Group>
					</>
				)}
				{snapshot && (
					<>
						<Divider />
						<SourceMetadata snapshot={snapshot} source={source} viewScope={scope} />
						{!state.pending && (
							<Button
								onClick={() => void flow.preview()}
								loading={state.step === "previewing"}
								disabled={!previewable}
							>
								{t(
									state.step === "stale"
										? "snapshotRestore.previewAgain"
										: "snapshotRestore.preview",
								)}
							</Button>
						)}
					</>
				)}
				{state.preview && (
					<>
						<Text size="sm">
							{t("snapshotRestore.diffSummary", { count: state.preview.totalFileCount })}
						</Text>
						<Code block>
							{state.preview.files
								.slice(0, 100)
								.map(
									(file) =>
										`${file.willBeDeleted ? t("snapshotRestore.deleted") : t("snapshotRestore.changed")}: ${file.deviceId}: ${file.path}`,
								)
								.join("\n")}
						</Code>
						{state.preview.hasMore && (
							<Text size="xs" c="orange">
								{t("snapshotRestore.diffTruncated")}
							</Text>
						)}
						<Text size="xs">
							{t("snapshotRestore.planHash")}
							<Code>{state.preview.plan.planHash}</Code>
						</Text>
						<Text size="xs">
							{t("snapshotRestore.expires", {
								time: formatLocaleDateTime(state.preview.plan.expiresAt),
							})}
						</Text>
					</>
				)}
				{state.pending && (
					<Alert color="orange">
						{t("snapshotRestore.pendingOriginal")}
						<Code block>{state.pending.request.planId}</Code>
						<Code block>{state.pending.request.planHash}</Code>
					</Alert>
				)}
				{(state.preview || state.pending) && (
					<Checkbox
						checked={state.consent}
						disabled={!flow.canConsent() || !!storageError}
						onChange={(event) => flow.setConsent(event.currentTarget.checked)}
						label={t("snapshotRestore.consent", {
							device: source?.deviceId,
							root: source?.root,
							digest: source?.treeDigest,
						})}
					/>
				)}
				{state.result && (
					<Alert
						color={
							state.result.status === "committed"
								? "green"
								: state.result.status === "compensated"
									? "blue"
									: "orange"
						}
					>
						{t(`snapshotRestore.result.${state.result.status}`, {
							count: state.result.restoredFileCount,
						})}
					</Alert>
				)}
				<Group justify="flex-end">
					<Button variant="default" onClick={close} disabled={busy}>
						{tc("cancel")}
					</Button>
					{state.pending ? (
						<Button
							color="orange"
							disabled={!flow.canRecover() || !!storageError}
							loading={state.step === "recovering"}
							onClick={() => void flow.recover()}
						>
							{t("snapshotRestore.recover")}
						</Button>
					) : (
						<Button
							color="red"
							disabled={!flow.canApply() || !!storageError}
							loading={state.step === "applying"}
							onClick={() => void flow.apply()}
						>
							{t("snapshotRestore.apply")}
						</Button>
					)}
				</Group>
			</Stack>
		</Modal>
	);
}
function SnapshotChoice({
	item,
	selected,
	disabled,
	onSelect,
}: {
	item: WorkspaceSnapshotSummary;
	selected: boolean;
	disabled: boolean;
	onSelect: () => void;
}) {
	const { t } = useTranslation("narrator");
	const candidate = snapshotIsCandidate(item);
	return (
		<Stack
			gap={3}
			p="xs"
			style={{ border: "1px solid var(--mantine-color-default-border)", borderRadius: 4 }}
		>
			<Group justify="space-between">
				<Text size="xs">
					{formatLocaleDateTime(item.createdAt)} · {item.edge}
				</Text>
				<Badge size="xs" color={candidate ? "gray" : "orange"}>
					{t(candidate ? "snapshotRestore.candidate" : "snapshotRestore.unavailable")}
				</Badge>
			</Group>
			<Code block style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
				{item.deviceId}: {item.root ?? t("snapshotRestore.unknownSource")}
			</Code>
			{!candidate && (
				<Text size="xs" c="orange">
					{item.originContextVersion !== 1
						? t("snapshotRestore.legacyUnknown")
						: (item.reason ?? t("snapshotRestore.unsupported"))}
				</Text>
			)}
			<Button
				size="xs"
				variant={selected ? "light" : "subtle"}
				disabled={disabled || !candidate}
				onClick={onSelect}
			>
				{t("snapshotRestore.select")}
			</Button>
		</Stack>
	);
}
function SourceMetadata({
	snapshot,
	source,
	viewScope,
}: {
	snapshot: WorkspaceSnapshotSummary;
	source: WorkspaceSnapshotRestorePreview["origin"] | undefined;
	viewScope: string | null;
}) {
	const { t } = useTranslation("narrator");
	return (
		<Stack gap={3}>
			<Text size="sm" fw={600}>
				{t("snapshotRestore.originalScope")}
			</Text>
			<Text size="xs">
				{t("snapshotRestore.device")} <Code>{source?.deviceId ?? snapshot.deviceId}</Code>
			</Text>
			<Text size="xs">{t("snapshotRestore.root")}</Text>
			<Code block style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
				{source?.root ?? snapshot.root ?? t("snapshotRestore.unknownSource")}
			</Code>
			<Text size="xs">
				{t("snapshotRestore.source")}{" "}
				<Code>{source?.sourceInstanceId ?? snapshot.sourceInstanceId}</Code>
			</Text>
			<Text size="xs">
				{t("snapshotRestore.scopeId")} <Code>{source?.scopeId ?? snapshot.scopeId}</Code>
			</Text>
			<Text size="xs">
				{t("snapshotRestore.viewScope")}{" "}
				<Code>{viewScope ?? t("snapshotRestore.unknownSource")}</Code>
			</Text>
			<Text size="xs">
				{t("snapshotRestore.rootIdentity")}{" "}
				<Code>{source?.rootIdentity ?? snapshot.rootIdentity}</Code>
			</Text>
			<Text size="xs">
				{t("snapshotRestore.treeDigest")} <Code>{source?.treeDigest ?? snapshot.treeDigest}</Code>
			</Text>
			<Text size="xs">
				{t("snapshotRestore.originContext")}{" "}
				<Code>
					{snapshot.contextKey} / {snapshot.workspaceRevision}
				</Code>
			</Text>
			<Text size="xs">
				{t("snapshotRestore.originProject")}{" "}
				<Code>
					{snapshot.originContextVersion !== 1
						? t("snapshotRestore.legacyUnknown")
						: (snapshot.originProjectId ?? t("snapshotRestore.standalone"))}
				</Code>
			</Text>
		</Stack>
	);
}

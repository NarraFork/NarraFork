import { Alert, Button, Drawer, Group, Loader, Stack, Text, Title } from "@mantine/core";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLegacyMigration } from "../../hooks/useLegacyMigration";
import { useMobileDrawerHistory } from "../../hooks/useMobileDrawerHistory";
import { useProjectAccess } from "../../hooks/useProjectAccess";
import type { LegacyMigrationPreview } from "../../lib/api/legacy-migration";

/** Shared drawer for chapter links, narrator pages and the retired project shell. */
export function LegacyMigrationAssistant({
	projectId,
	autoOpen = false,
	onCompleted,
}: {
	projectId?: string;
	autoOpen?: boolean;
	onCompleted?: () => void;
}) {
	// Preserve the source and result if narrator refresh removes its chapter association.
	const [sourceId, setSourceId] = useState(projectId);
	const [opened, setOpened] = useState(autoOpen && !!projectId);
	const [settled, setSettled] = useState(false);
	useEffect(() => {
		if (projectId && projectId !== sourceId) {
			setSourceId(projectId);
			setOpened(autoOpen);
			setSettled(false);
		}
	}, [projectId, sourceId, autoOpen]);
	const { t } = useTranslation("projects");
	const access = useProjectAccess(settled ? "" : (sourceId ?? ""));
	const canManage = !access.isError && access.data?.canManage === true;
	const allowReceiptLookup =
		access.isError &&
		!!access.error &&
		typeof access.error === "object" &&
		"status" in access.error &&
		access.error.status === 404;
	const close = () => setOpened(false);
	const handleCompleted = useCallback(() => {
		setSettled(true);
		onCompleted?.();
	}, [onCompleted]);
	useMobileDrawerHistory(opened, close);
	if (!sourceId) return null;
	return (
		<>
			<Button variant="light" onClick={() => setOpened(true)}>
				{t(settled ? "migration.result" : "migration.entry")}
			</Button>
			<Drawer
				keepMounted
				opened={opened}
				onClose={close}
				position="right"
				size="lg"
				title={t("migration.title")}
			>
				<LegacyMigrationContent
					key={sourceId}
					projectId={sourceId}
					opened={opened}
					canManage={canManage}
					allowReceiptLookup={allowReceiptLookup}
					onCompleted={handleCompleted}
				/>
			</Drawer>
		</>
	);
}

export function LegacyMigrationContent({
	projectId,
	opened,
	canManage,
	allowReceiptLookup = false,
	onCompleted,
}: {
	projectId: string;
	opened: boolean;
	canManage: boolean;
	allowReceiptLookup?: boolean;
	onCompleted?: () => void;
}) {
	const { t } = useTranslation("projects");
	const { preview, migration, disable, draining, drainTimedOut, syncDisabled } = useLegacyMigration(
		projectId,
		opened,
		canManage,
		allowReceiptLookup,
	);
	const [confirmation, setConfirmation] = useState<{
		kind: "migrate" | "disable";
		revision: string;
	} | null>(null);
	const pending = migration.isPending || disable.isPending;
	const result = migration.data;
	const [completedPreview, setCompletedPreview] = useState<LegacyMigrationPreview | null>(null);
	// Receipt recovery must finish its independently authorized request before
	// displaying even a cached completed preview. A rejected lookup hides stale data.
	const authorizedPreview =
		!preview.isError && (canManage || (allowReceiptLookup && preview.isFetchedAfterMount))
			? preview.data
			: undefined;
	useEffect(() => {
		if (authorizedPreview?.phase === "completed") setCompletedPreview(authorizedPreview);
	}, [authorizedPreview]);
	const data = completedPreview ?? authorizedPreview;
	const phase = result?.phase ?? data?.phase;
	const blockers = result?.blockers ?? data?.blockers ?? [];
	const error = migration.error ?? disable.error ?? preview.error;
	const completed = phase === "completed";
	useEffect(() => {
		if (completed) onCompleted?.();
	}, [completed, onCompleted]);
	if (!canManage && !completed)
		return (
			<Stack>
				{allowReceiptLookup && preview.isLoading && <Loader size="sm" />}
				<Alert color={allowReceiptLookup && preview.isError ? "red" : "gray"}>
					{t(
						allowReceiptLookup && preview.isError ? "migration.failed" : "migration.manageRequired",
					)}
					{allowReceiptLookup && preview.error && ` ${preview.error.message}`}
				</Alert>
			</Stack>
		);
	const submit = () => {
		if (!confirmation || pending || !canManage) return;
		if (confirmation.kind === "disable") disable.mutate();
		else if (data?.canMigrate && data.revision === confirmation.revision && !preview.isError) {
			migration.mutate(confirmation.revision);
		}
		setConfirmation(null);
	};
	return (
		<Stack>
			{data && <Title order={4}>{data.projectName}</Title>}
			{data && (
				<Text>
					{t("migration.scope", { chapters: data.chapterCount, narrators: data.narratorCount })}
				</Text>
			)}
			{preview.isLoading && !result && <Loader size="sm" />}
			{error && !completed && (
				<Alert color="red">
					{t("migration.failed")} {error.message}
				</Alert>
			)}
			{draining && !error && !completed && <Alert>{t("migration.draining")}</Alert>}
			{drainTimedOut && !completed && (
				<Alert color="yellow">{t("migration.drainUnconfirmed")}</Alert>
			)}
			{phase && phase !== "none" && (
				<Alert color={completed ? "green" : "yellow"}>
					{t(`migration.phase.${phase}`, { defaultValue: phase })}
				</Alert>
			)}
			{blockers.map((blocker) => (
				<Alert color="yellow" key={`${blocker.code}:${blocker.message}`}>
					<Text fw={600}>{blocker.code}</Text>
					<Text>{blocker.message}</Text>
				</Alert>
			))}
			{(result?.narratorIds ?? (completed ? data?.narratorIds : undefined) ?? []).map((id) => (
				<Link
					key={id}
					to="/narrators/$narratorId"
					params={{ narratorId: id }}
					style={{ textDecoration: "none" }}
				>
					<Button component="span" variant="light">
						{t("migration.openNarrator", { id })}
					</Button>
				</Link>
			))}
			{!completed && (
				<>
					<Text>{t("migration.preserve")}</Text>
					<Text>{t("migration.remove")}</Text>
					<Text size="sm" c="dimmed">
						{t("migration.permissions")}
					</Text>
					{confirmation ? (
						<Stack data-migration-confirmation={confirmation.kind}>
							<Title order={5}>{t("migration.confirmTitle")}</Title>
							<Text>
								{t(
									confirmation.kind === "migrate"
										? "migration.confirmMigration"
										: "migration.confirmDisable",
								)}
							</Text>
							<Group>
								<Button
									color="orange"
									disabled={
										pending ||
										!canManage ||
										(confirmation.kind === "migrate" &&
											(preview.isError ||
												!data?.canMigrate ||
												data.revision !== confirmation.revision))
									}
									onClick={submit}
								>
									{t("migration.confirm")}
								</Button>
								<Button variant="subtle" onClick={() => setConfirmation(null)}>
									{t("migration.cancel")}
								</Button>
							</Group>
						</Stack>
					) : (
						<Group>
							<Button
								color="orange"
								disabled={
									!canManage ||
									!data?.canMigrate ||
									preview.isError ||
									pending ||
									preview.isFetching
								}
								onClick={() => setConfirmation({ kind: "migrate", revision: data?.revision ?? "" })}
							>
								{t(phase === "cleanup_pending" ? "migration.retryCleanup" : "migration.action")}
							</Button>
							<Button
								variant="light"
								disabled={!canManage || syncDisabled || pending || !data || preview.isError}
								onClick={() => setConfirmation({ kind: "disable", revision: data?.revision ?? "" })}
							>
								{t(syncDisabled ? "migration.syncDisabled" : "migration.disableSync")}
							</Button>
							<Button
								variant="subtle"
								disabled={pending || preview.isFetching}
								onClick={() => {
									migration.reset();
									disable.reset();
									void preview.refetch();
								}}
							>
								{t("migration.refresh")}
							</Button>
						</Group>
					)}
				</>
			)}
		</Stack>
	);
}

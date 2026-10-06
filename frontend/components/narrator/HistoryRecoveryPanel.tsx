import { Alert, Box, Button, Checkbox, Group, Loader, Stack, Text } from "@mantine/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import type { HistoryRecoveryCandidate } from "../../lib/api/types";

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function isAggregateUnavailable(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const data = (error as { data?: { code?: unknown } }).data;
	return data?.code === "HISTORY_AGGREGATE_UNAVAILABLE";
}

/**
 * Recovery card shown when the timeline cannot paginate because one message
 * exceeded the history-aggregation budget. Lists oversized messages and offers
 * "delete this message and after" via the ordinary message-delete API — never
 * through the aggregate path that is already failing.
 */
export function HistoryRecoveryPanel({
	narratorId,
	loadError,
	onRecovered,
}: {
	narratorId: string;
	loadError: unknown;
	onRecovered: () => void;
}) {
	const { t } = useTranslation("narrator");
	const [skipRevert, setSkipRevert] = useState(true);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const showRecovery = isAggregateUnavailable(loadError);

	const recovery = useQuery({
		queryKey: ["narrators", narratorId, "history-recovery"],
		queryFn: ({ signal }) => api.getHistoryRecovery(narratorId, signal),
		// Only when the timeline is actually blocked by the aggregate budget.
		enabled: showRecovery,
		retry: false,
	});

	const remove = useMutation({
		mutationFn: (messageId: string) => api.deleteMessage(narratorId, messageId, { skipRevert }),
		onSuccess: () => {
			setSelectedId(null);
			void recovery.refetch();
			onRecovered();
		},
	});

	const candidates = recovery.data?.candidates ?? [];
	if (!showRecovery) return null;

	return (
		<Alert color="yellow" title={t("historyRecovery.title")}>
			<Stack gap="sm">
				<Text size="sm">{t("historyRecovery.description")}</Text>
				{recovery.isPending ? (
					<Loader size="sm" />
				) : recovery.isError ? (
					<Text size="sm" c="red">
						{t("historyRecovery.scanFailed")}
					</Text>
				) : candidates.length === 0 ? (
					<Text size="sm" c="dimmed">
						{t("historyRecovery.noCandidates")}
					</Text>
				) : (
					<Stack gap="xs">
						{candidates.map((candidate) => (
							<CandidateRow
								key={candidate.messageId}
								candidate={candidate}
								selected={selectedId === candidate.messageId}
								onSelect={() =>
									setSelectedId(selectedId === candidate.messageId ? null : candidate.messageId)
								}
								t={t}
							/>
						))}
					</Stack>
				)}
				<Checkbox
					label={t("historyRecovery.skipRevert")}
					description={t("historyRecovery.skipRevertDesc")}
					checked={skipRevert}
					onChange={(e) => setSkipRevert(e.currentTarget.checked)}
				/>
				<Group>
					<Button
						color="red"
						size="xs"
						disabled={!selectedId || remove.isPending}
						loading={remove.isPending}
						onClick={() => {
							if (selectedId) remove.mutate(selectedId);
						}}
					>
						{t("historyRecovery.delete")}
					</Button>
					<Button
						variant="default"
						size="xs"
						onClick={() => {
							void recovery.refetch();
							onRecovered();
						}}
					>
						{t("historyRecovery.retryLoad")}
					</Button>
				</Group>
				{remove.isError ? (
					<Text size="sm" c="red">
						{t("historyRecovery.deleteFailed")}
					</Text>
				) : null}
			</Stack>
		</Alert>
	);
}

function CandidateRow({
	candidate,
	selected,
	onSelect,
	t,
}: {
	candidate: HistoryRecoveryCandidate;
	selected: boolean;
	onSelect: () => void;
	t: (key: string, params?: Record<string, unknown>) => string;
}) {
	return (
		<Box
			p="xs"
			style={{
				border: `1px solid ${selected ? "var(--mantine-primary-color-filled)" : "var(--mantine-color-default-border)"}`,
				borderRadius: 6,
			}}
		>
			<Checkbox
				checked={selected}
				onChange={onSelect}
				label={
					<Stack gap={2}>
						<Text size="sm" fw={500}>
							{t("historyRecovery.candidateTitle", {
								seq: candidate.seq,
								role: candidate.role,
								toolCount: candidate.toolCount,
								size: formatBytes(candidate.byteSize),
							})}
							{candidate.latest ? ` · ${t("historyRecovery.latest")}` : ""}
						</Text>
						{candidate.preview ? (
							<Text size="xs" c="dimmed" lineClamp={2}>
								{candidate.preview}
							</Text>
						) : null}
					</Stack>
				}
			/>
		</Box>
	);
}

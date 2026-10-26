import { useConfirmDialog } from "@frontend/components/common/confirm-dialog-context";
import { useCurrentUser } from "@frontend/hooks/useAuth";
import {
	TOKEN_RECALCULATION_QUERY_KEY,
	tokenRecalculationApi,
} from "@frontend/lib/token-recalculation-api";
import { Alert, Badge, Button, Group, Loader, Modal, SimpleGrid, Stack, Text } from "@mantine/core";
import { DatePickerInput } from "@mantine/dates";
import { IconAlertTriangle } from "@tabler/icons-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export function TokenRecalculationPanel() {
	const { data: user } = useCurrentUser();
	const { t } = useTranslation("common", { keyPrefix: "tokenRecalculation" });
	const [opened, setOpened] = useState(false);
	if (user?.role !== "admin") return null;
	return (
		<>
			<Button variant="subtle" size="xs" color="gray" onClick={() => setOpened(true)}>
				{t("open")}
			</Button>
			<Modal
				opened={opened}
				onClose={() => setOpened(false)}
				title={t("title")}
				size="lg"
				closeButtonProps={{ "aria-label": t("close") }}
			>
				{opened && <AdminTokenRecalculationPanel />}
			</Modal>
		</>
	);
}

function AdminTokenRecalculationPanel() {
	const { t } = useTranslation("common", { keyPrefix: "tokenRecalculation" });
	const confirm = useConfirmDialog();
	const queryClient = useQueryClient();
	const [startDate, setStartDate] = useState<string | null>(null);
	const [endDate, setEndDate] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [operationError, setOperationError] = useState<string | null>(null);
	const [cancelRequestedId, setCancelRequestedId] = useState<string | null>(null);
	const inFlight = useRef(false);
	const invalidatedJob = useRef<string | null>(null);
	const query = useQuery({
		queryKey: TOKEN_RECALCULATION_QUERY_KEY,
		queryFn: ({ signal }) => tokenRecalculationApi.get(signal),
		enabled: !busy,
		retry: false,
		// Keep discovering jobs started by another administrator, even when initially idle.
		refetchInterval: (state) =>
			busy ? false : state.state.data?.job?.status === "running" ? 1_000 : 5_000,
	});
	const job = query.data?.job;
	const running = job?.status === "running";
	const invalidRange = !!startDate && !!endDate && startDate > endDate;
	const rangeLabel = (start?: string | null, end?: string | null) =>
		!start && !end
			? t("allHistory")
			: t("range", { start: start || t("earliest"), end: end || t("latest") });

	useEffect(() => {
		if (!job || job.status === "running") return;
		const signature = `${job.id}:${job.status}`;
		if (invalidatedJob.current === signature) return;
		invalidatedJob.current = signature;
		// Cancelled and failed runs can also have committed partial corrections.
		void queryClient.invalidateQueries({ queryKey: ["usage-history"] });
	}, [job, queryClient]);

	async function start() {
		if (inFlight.current || running || invalidRange || !query.data || query.isError) return;
		inFlight.current = true;
		setBusy(true);
		setOperationError(null);
		try {
			if (
				!(await confirm({
					title: t("confirmTitle"),
					message: (
						<Stack gap="sm">
							<Text fw={600}>{rangeLabel(startDate, endDate)}</Text>
							<Text>{t("warning")}</Text>
							<Text>{t("scope")}</Text>
							<Text>{t("skipNote")}</Text>
						</Stack>
					),
					confirmLabel: t("confirmStart"),
					cancelLabel: t("back"),
					confirmColor: "orange",
				}))
			)
				return;
			await queryClient.cancelQueries({ queryKey: TOKEN_RECALCULATION_QUERY_KEY });
			const result = await tokenRecalculationApi.start({
				...(startDate ? { startDate } : {}),
				...(endDate ? { endDate } : {}),
			});
			queryClient.setQueryData(TOKEN_RECALCULATION_QUERY_KEY, result);
			setCancelRequestedId(null);
		} catch (error) {
			setOperationError(error instanceof Error ? error.message : t("operationFailed"));
			// The server may have accepted a request whose response was lost.
			void queryClient.invalidateQueries({ queryKey: TOKEN_RECALCULATION_QUERY_KEY });
		} finally {
			inFlight.current = false;
			setBusy(false);
		}
	}

	async function cancel() {
		if (inFlight.current || !job || !running || cancelRequestedId === job.id) return;
		inFlight.current = true;
		setBusy(true);
		setOperationError(null);
		try {
			await queryClient.cancelQueries({ queryKey: TOKEN_RECALCULATION_QUERY_KEY });
			const result = await tokenRecalculationApi.cancel(job.id);
			queryClient.setQueryData(TOKEN_RECALCULATION_QUERY_KEY, result);
			setCancelRequestedId(job.id);
		} catch (error) {
			setOperationError(error instanceof Error ? error.message : t("operationFailed"));
			void queryClient.invalidateQueries({ queryKey: TOKEN_RECALCULATION_QUERY_KEY });
		} finally {
			inFlight.current = false;
			setBusy(false);
		}
	}

	return (
		<Stack gap="sm">
			<Text size="sm" c="dimmed">
				{t("backgroundNote")}
			</Text>
			<Alert color="orange" icon={<IconAlertTriangle size={18} />} title={t("warningTitle")}>
				<Stack gap="xs">
					<Text size="sm">{t("warning")}</Text>
					<Text size="sm">{t("scope")}</Text>
					<Text size="sm">{t("skipNote")}</Text>
				</Stack>
			</Alert>
			<Text size="sm" c="dimmed">
				{t("rangeHelp")}
			</Text>
			<Group align="flex-end">
				<DatePickerInput
					label={t("startDate")}
					placeholder={t("earliest")}
					value={startDate}
					onChange={setStartDate}
					maxDate={endDate ?? undefined}
					clearable
					disabled={busy || running}
				/>
				<DatePickerInput
					label={t("endDate")}
					placeholder={t("latest")}
					value={endDate}
					onChange={setEndDate}
					minDate={startDate ?? undefined}
					error={invalidRange ? t("invalidRange") : undefined}
					clearable
					disabled={busy || running}
				/>
				<Button
					color="orange"
					variant="light"
					onClick={() => void start()}
					loading={busy && !running}
					disabled={running || invalidRange || !query.data || query.isError}
				>
					{t("start")}
				</Button>
			</Group>
			<Text size="sm" fw={500}>
				{rangeLabel(startDate, endDate)}
			</Text>
			{query.isPending && <Text size="sm">{t("loading")}</Text>}
			{query.isError && (
				<Alert color="red" title={t("loadFailed")}>
					<Button size="xs" variant="light" onClick={() => void query.refetch()} disabled={busy}>
						{t("retry")}
					</Button>
				</Alert>
			)}
			{operationError && (
				<Alert color="red" title={t("operationFailed")}>
					{operationError}
				</Alert>
			)}
			{job && (
				<Stack gap="xs" aria-live="polite" aria-atomic="true">
					<Group>
						{running && <Loader size="xs" />}
						<Badge
							color={
								job.status === "failed" ? "red" : job.status === "completed" ? "green" : "blue"
							}
						>
							{t(`status.${job.status}`)}
						</Badge>
						<Text size="sm">{rangeLabel(job.startDate, job.endDate)}</Text>
						{running && (
							<Button
								size="xs"
								variant="light"
								color="red"
								onClick={() => void cancel()}
								loading={busy}
								disabled={cancelRequestedId === job.id}
							>
								{t(cancelRequestedId === job.id ? "cancelling" : "cancel")}
							</Button>
						)}
					</Group>
					<SimpleGrid cols={{ base: 2, sm: 3, lg: 6 }}>
						{(["scanned", "processed", "changed", "skipped", "fallback"] as const).map((key) => (
							<Text size="sm" key={key}>
								{t(`counts.${key}`, { count: job[key] })}
							</Text>
						))}
					</SimpleGrid>
					<Text size="xs" c="dimmed">
						{t("countsHelp")}
					</Text>
					<Text size="xs" c="dimmed">
						{t("cancelNote")}
					</Text>
					{job.error && <Alert color="red">{job.error}</Alert>}
				</Stack>
			)}
		</Stack>
	);
}

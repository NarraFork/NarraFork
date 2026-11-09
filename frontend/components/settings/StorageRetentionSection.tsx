import {
	api,
	type StorageHistoryJob,
	type StorageHistoryJobs,
	type StorageHistoryPreview,
	type StorageRetentionRule,
	type StorageRetentionTarget,
} from "@frontend/lib/api";
import {
	Button,
	Group,
	Loader,
	NativeSelect,
	NumberInput,
	Paper,
	Popover,
	Stack,
	Switch,
	Text,
	TextInput,
} from "@mantine/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

export const STORAGE_HISTORY_QUERY_KEY = ["storage", "history-jobs"] as const;
const TARGETS: StorageRetentionTarget[] = ["toolCallPayloads", "messageHistory"];
const DAY_OPTIONS = [30, 90, 180, 365];
const KEEP_ALL: StorageRetentionRule = { retentionDays: null, autoCleanup: false };

function active(job: StorageHistoryJob | null | undefined): boolean {
	return job?.status === "queued" || job?.status === "running";
}

function bytes(value: number): string {
	if (value < 1024) return `${value} B`;
	const unit = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
	return `${(value / 1024 ** unit).toFixed(1)} ${["B", "KB", "MB", "GB", "TB"][unit]}`;
}

function localDate(days: number): string {
	const date = new Date();
	date.setDate(date.getDate() - days);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** A date means the start of that local day, never UTC midnight or request time. */
export function storageHistoryCutoff(date: string): string | null {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
	const [year, month, day] = date.split("-").map(Number);
	const value = new Date(year, month - 1, day);
	if (value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== day)
		return null;
	return value.toISOString();
}

type Operation =
	| { action: "start"; target: StorageRetentionTarget; cutoffAt: string }
	| { action: "cancel"; target: StorageRetentionTarget };

/** Retention and one-off cleanup work without a storage scan. Jobs belong to the server. */
export function StorageRetentionSection({ onSettled }: { onSettled?: () => void }) {
	const { t } = useTranslation("settings");
	const client = useQueryClient();
	const settled = useRef(new Set<string>());
	const settings = useQuery({
		queryKey: ["settings"],
		queryFn: ({ signal }) => api.getSettings({ signal }),
	});
	const operation = useMutation({
		mutationFn: (input: Operation) =>
			input.action === "start"
				? api.cleanupStorageHistory({ target: input.target, cutoffAt: input.cutoffAt })
				: api.cancelStorageHistory(input.target),
		onMutate: () => client.cancelQueries({ queryKey: STORAGE_HISTORY_QUERY_KEY }),
		onSuccess: (result, input) => {
			client.setQueryData<{ jobs: StorageHistoryJobs }>(STORAGE_HISTORY_QUERY_KEY, (current) => ({
				jobs: {
					toolCallPayloads: null,
					messageHistory: null,
					...current?.jobs,
					[input.target]: result.job,
				},
			}));
		},
		onSettled: () => void client.invalidateQueries({ queryKey: STORAGE_HISTORY_QUERY_KEY }),
	});
	const query = useQuery({
		queryKey: STORAGE_HISTORY_QUERY_KEY,
		queryFn: ({ signal }) => api.getStorageHistoryJobs(signal),
		enabled: !operation.isPending,
		retry: false,
		// Also discover automatic jobs and work started in another browser.
		refetchInterval: (state) =>
			Object.values(state.state.data?.jobs ?? {}).some(active) ? 1_000 : 5_000,
	});

	useEffect(() => {
		let changed = false;
		for (const job of Object.values(query.data?.jobs ?? {})) {
			if (!job || active(job)) continue;
			const signature = `${job.id}:${job.status}`;
			if (settled.current.has(signature)) continue;
			settled.current.add(signature);
			changed = true;
		}
		if (!changed) return;
		// Failed or cancelled jobs can have committed partial cleanup too.
		void client.invalidateQueries({ queryKey: ["storage"] });
		void client.invalidateQueries({ queryKey: ["narrators"] });
		onSettled?.();
	}, [query.data, client, onSettled]);

	return (
		<Stack gap="sm" data-storage-retention>
			{TARGETS.map((target) => (
				<RetentionRow
					key={target}
					target={target}
					rule={settings.data?.storageRetention?.[target] ?? KEEP_ALL}
					settingsUnavailable={settings.isPending || settings.isError}
					job={query.data?.jobs[target] ?? null}
					busy={operation.isPending}
					onStart={(cutoffAt) => operation.mutateAsync({ action: "start", target, cutoffAt })}
					onCancel={() => operation.mutateAsync({ action: "cancel", target })}
				/>
			))}
			{(query.isError || settings.isError) && (
				<Group gap="xs">
					<Text size="xs" c="red">
						{t("storageRetentionLoadFailed")}
					</Text>
					<Button
						size="compact-xs"
						variant="subtle"
						onClick={() => {
							void query.refetch();
							void settings.refetch();
						}}
					>
						{t("storageHealthRetry")}
					</Button>
				</Group>
			)}
		</Stack>
	);
}

function RetentionRow({
	target,
	rule,
	settingsUnavailable,
	job,
	busy,
	onStart,
	onCancel,
}: {
	target: StorageRetentionTarget;
	rule: StorageRetentionRule;
	settingsUnavailable: boolean;
	job: StorageHistoryJob | null;
	busy: boolean;
	onStart: (cutoffAt: string) => Promise<unknown>;
	onCancel: () => Promise<unknown>;
}) {
	const { t } = useTranslation("settings");
	const client = useQueryClient();
	const [custom, setCustom] = useState(false);
	const [customDays, setCustomDays] = useState<number | string>(rule.retentionDays ?? "");
	const customDirty = useRef(false);
	const [opened, setOpened] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [cancelRequested, setCancelRequested] = useState<string | null>(null);
	const save = useMutation({
		// Serialize settings responses so saving one row cannot replace a newer sibling value.
		scope: { id: "storage-retention-settings" },
		mutationFn: (patch: Partial<StorageRetentionRule>) =>
			api.updateSettings({ storageRetention: { [target]: patch } }),
		onMutate: () => client.cancelQueries({ queryKey: ["settings"] }),
		onSuccess: (data) => client.setQueryData(["settings"], data),
	});
	useEffect(() => {
		if (!custom) setCustomDays(rule.retentionDays ?? "");
	}, [custom, rule.retentionDays]);

	function commitCustomDays() {
		if (!customDirty.current || typeof customDays !== "number" || settingsUnavailable) return;
		if (!Number.isInteger(customDays) || customDays < 1 || customDays > 36_500) return;
		customDirty.current = false;
		if (customDays !== rule.retentionDays) save.mutate({ retentionDays: customDays });
	}
	const selection =
		custom || (rule.retentionDays !== null && !DAY_OPTIONS.includes(rule.retentionDays))
			? "custom"
			: rule.retentionDays === null
				? "all"
				: String(rule.retentionDays);
	const running = active(job);
	useEffect(() => {
		if (running) setOpened(false);
	}, [running]);

	async function cleanup(cutoffAt: string) {
		setError(null);
		try {
			await onStart(cutoffAt);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			throw cause;
		}
	}

	async function cancel() {
		if (!job || cancelRequested === job.id) return;
		setError(null);
		try {
			await onCancel();
			setCancelRequested(job.id);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}

	return (
		<Paper p="sm" withBorder radius="sm" data-retention-target={target}>
			<Stack gap="xs">
				<Group justify="space-between" align="flex-start">
					<div>
						<Text fw={500} size="sm">
							{t(`storageRetentionTarget_${target}`)}
						</Text>
						<Text size="xs" c="dimmed">
							{t(`storageRetentionDescription_${target}`)}
						</Text>
					</div>
					<Popover
						opened={opened}
						onChange={setOpened}
						position="bottom-end"
						width={280}
						withinPortal={false}
					>
						<Popover.Target>
							<Button
								size="compact-xs"
								variant="subtle"
								disabled={running || busy}
								onClick={() => setOpened(!opened)}
							>
								{t("storageRetentionManual")}
							</Button>
						</Popover.Target>
						<Popover.Dropdown>
							{opened && (
								<HistoryCleanupPopover
									target={target}
									days={rule.retentionDays ?? 30}
									busy={busy}
									onStart={cleanup}
									onClose={() => setOpened(false)}
								/>
							)}
						</Popover.Dropdown>
					</Popover>
				</Group>
				<Group gap="sm" align="flex-end">
					<NativeSelect
						label={t("storageRetentionKeep")}
						size="xs"
						value={selection}
						disabled={settingsUnavailable || save.isPending}
						data={[
							{ value: "all", label: t("storageRetentionAll") },
							...DAY_OPTIONS.map((days) => ({
								value: String(days),
								label: t("storageRetentionDays", { days }),
							})),
							{ value: "custom", label: t("storageRetentionCustom") },
						]}
						onChange={(event) => {
							const value = event.currentTarget.value;
							setCustom(value === "custom");
							customDirty.current = false;
							if (value === "custom") {
								// Expanding the editor is not permission to apply a shorter default window.
								setCustomDays(rule.retentionDays ?? "");
							} else if (value === "all") {
								save.mutate({ retentionDays: null, autoCleanup: false });
							} else save.mutate({ retentionDays: Number(value) });
						}}
					/>
					{selection === "custom" && (
						<NumberInput
							label={t("storageRetentionCustomDays")}
							placeholder={t("storageRetentionCustomDays")}
							size="xs"
							w={100}
							min={1}
							max={36_500}
							allowDecimal={false}
							value={customDays}
							disabled={settingsUnavailable}
							onChange={(value) => {
								setCustom(true);
								setCustomDays(value);
								customDirty.current = true;
							}}
							onBlur={commitCustomDays}
							onKeyDown={(event) => {
								if (event.key !== "Enter") return;
								event.preventDefault();
								commitCustomDays();
							}}
						/>
					)}
					{rule.retentionDays !== null && (
						<Switch
							label={t("storageRetentionAuto")}
							size="xs"
							mb={4}
							checked={rule.autoCleanup}
							disabled={settingsUnavailable || save.isPending}
							onChange={(event) => save.mutate({ autoCleanup: event.currentTarget.checked })}
						/>
					)}
					{save.isPending && <Loader size={12} mb={4} />}
				</Group>
				{job && (
					<Group gap="xs" aria-live="polite">
						{running && <Loader size={12} />}
						<Text size="xs" c={job.status === "failed" ? "red" : "dimmed"}>
							{running
								? t("storageRetentionProgress", { count: job.cleared })
								: t(`storageRetentionStatus_${job.status}`, { count: job.cleared })}
							{!running &&
								job.retained > 0 &&
								t("storageRetentionRetained", { count: job.retained })}
						</Text>
						{running && (
							<Button
								size="compact-xs"
								variant="subtle"
								color="gray"
								loading={busy}
								disabled={cancelRequested === job.id}
								onClick={() => void cancel()}
							>
								{t(
									cancelRequested === job.id
										? "storageRetentionCancelling"
										: "storageRetentionCancel",
								)}
							</Button>
						)}
					</Group>
				)}
				{(save.error || error || job?.error) && (
					<Text size="xs" c="red">
						{save.error?.message ?? error ?? job?.error}
					</Text>
				)}
			</Stack>
		</Paper>
	);
}

function HistoryCleanupPopover({
	target,
	days,
	busy,
	onStart,
	onClose,
}: {
	target: StorageRetentionTarget;
	days: number;
	busy: boolean;
	onStart: (cutoffAt: string) => Promise<unknown>;
	onClose: () => void;
}) {
	const { t } = useTranslation("settings");
	const [date, setDate] = useState(() => localDate(days));
	const [preview, setPreview] = useState<StorageHistoryPreview | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const starting = useRef(false);
	const cutoffAt = storageHistoryCutoff(date);

	useEffect(() => {
		setPreview(null);
		setError(null);
		setLoading(!!cutoffAt);
		if (!cutoffAt) return;
		const controller = new AbortController();
		const timer = setTimeout(() => {
			void api
				.previewStorageHistory({ target, cutoffAt }, controller.signal)
				.then((result) => {
					if (!controller.signal.aborted) setPreview(result.preview);
				})
				.catch((cause) => {
					if (!controller.signal.aborted)
						setError(cause instanceof Error ? cause.message : String(cause));
				})
				.finally(() => {
					if (!controller.signal.aborted) setLoading(false);
				});
		}, 250);
		return () => {
			clearTimeout(timer);
			controller.abort();
		};
	}, [target, cutoffAt]);
	const ready = preview?.cutoffAt === cutoffAt && preview.target === target && preview.count > 0;

	async function start() {
		if (!ready || !preview || busy || starting.current) return;
		starting.current = true;
		setError(null);
		try {
			await onStart(preview.cutoffAt);
			onClose();
		} catch {
			// The row retains operation errors, including a lost accepted response.
		} finally {
			starting.current = false;
		}
	}

	return (
		<Stack gap="sm" data-history-cleanup={target}>
			<TextInput
				type="date"
				label={t("storageRetentionBefore")}
				size="xs"
				value={date}
				max={localDate(0)}
				disabled={busy}
				onChange={(event) => setDate(event.currentTarget.value)}
			/>
			{loading ? (
				<Group gap="xs">
					<Loader size={12} />
					<Text size="xs" c="dimmed">
						{t("storageRetentionCounting")}
					</Text>
				</Group>
			) : preview?.cutoffAt === cutoffAt ? (
				<Group justify="space-between">
					<Text size="sm">{t("storageRetentionMatches", { count: preview.count })}</Text>
					<Text size="sm" c="dimmed">
						{t("storageRetentionEstimate", { size: bytes(preview.approxBytes) })}
					</Text>
				</Group>
			) : null}
			{error && (
				<Text size="xs" c="red">
					{error}
				</Text>
			)}
			<Button
				color="red"
				size="xs"
				disabled={!ready || loading || busy}
				loading={busy}
				onClick={() => void start()}
			>
				{t("storageRetentionClearBefore", { date })}
			</Button>
		</Stack>
	);
}

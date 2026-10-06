import { useCurrentUser } from "@frontend/hooks/useAuth";
import { useNarrator, useUpdateReflectionOverrides } from "@frontend/hooks/useNarrator";
import { api } from "@frontend/lib/api";
import { ActionIcon, Button, Group, NumberInput, Popover, Stack, Text } from "@mantine/core";
import { IconSettings } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

export type ReminderSource = "living_work_spec" | "silent_progress";

/** Header-only chrome: the portal never changes the virtual row's measured height. */
export function ReminderFrequencySettings({
	source,
	narratorId,
}: {
	source: ReminderSource;
	narratorId: string;
}) {
	const { t } = useTranslation("narrator");
	const [opened, setOpened] = useState(false);
	const label = t("sidecar.frequency.title");
	return (
		<Popover opened={opened} onChange={setOpened} position="bottom-end" withinPortal trapFocus>
			<Popover.Target>
				<ActionIcon
					size={20}
					variant="subtle"
					color="gray"
					aria-label={label}
					title={label}
					style={{ flexShrink: 0 }}
					onPointerDown={(event) => event.stopPropagation()}
					onClick={(event) => {
						event.stopPropagation();
						setOpened((value) => !value);
					}}
					onKeyDown={(event) => event.stopPropagation()}
				>
					<IconSettings size={14} />
				</ActionIcon>
			</Popover.Target>
			<Popover.Dropdown
				w={280}
				style={{ maxWidth: "calc(100vw - 24px)" }}
				onClick={(event) => event.stopPropagation()}
				onPointerDown={(event) => event.stopPropagation()}
				onKeyDown={(event) => event.stopPropagation()}
			>
				{opened && (
					<ReminderFrequencyForm
						key={`${narratorId}:${source}`}
						source={source}
						narratorId={narratorId}
						onSaved={() => setOpened(false)}
					/>
				)}
			</Popover.Dropdown>
		</Popover>
	);
}

/** Fetch only while open, never subscribe every historical reminder to settings. */
function ReminderFrequencyForm({
	source,
	narratorId,
	onSaved,
}: {
	source: ReminderSource;
	narratorId: string;
	onSaved: () => void;
}) {
	const { t } = useTranslation("narrator");
	const { t: tc } = useTranslation("common");
	const qc = useQueryClient();
	const isTasks = source === "living_work_spec";
	const { data: user } = useCurrentUser();
	const settings = useQuery({ queryKey: ["settings"], queryFn: api.getSettings });
	const narrator = useNarrator(isTasks ? narratorId : "");
	const reflection = useUpdateReflectionOverrides();
	const globalSettings = useMutation({
		mutationFn: api.updateSettings,
		onSuccess: (data) => qc.setQueryData(["settings"], data),
	});
	const [draft, setDraft] = useState<number | string | null>(null);
	const field = isTasks ? "tasksReminderInterval" : "silentToolCallThreshold";
	const globalValue = settings.data?.agent?.[field];
	const effectiveValue = isTasks
		? (narrator.data?.tasksReminderIntervalOverride ?? globalValue)
		: globalValue;
	const value = draft ?? (typeof effectiveValue === "number" ? effectiveValue : "");
	const valid =
		typeof value === "number" &&
		Number.isInteger(value) &&
		(value === -1 || (value >= (isTasks ? 5 : 1) && value <= 1000));
	const ready = settings.isSuccess && (!isTasks || narrator.isSuccess);
	const permitted = isTasks || user?.role === "admin";
	const pending = reflection.isPending || globalSettings.isPending;
	const error = reflection.error ?? globalSettings.error ?? settings.error ?? narrator.error;
	const save = async (next: number | null, setAsDefault = false) => {
		if (!ready || !permitted || pending) return;
		if (setAsDefault && (!isTasks || user?.role !== "admin" || !valid || next === null)) return;
		try {
			if (isTasks) {
				if (setAsDefault) {
					// Preserve the session override if saving the global default fails.
					await globalSettings.mutateAsync({ agent: { tasksReminderInterval: next } });
				}
				await reflection.mutateAsync({
					id: narratorId,
					tasksReminderIntervalOverride: setAsDefault ? null : next,
				});
			} else {
				await globalSettings.mutateAsync({ agent: { silentToolCallThreshold: next } });
			}
			onSaved();
		} catch {
			// Keep the draft and display the mutation error so the user can retry.
		}
	};
	return (
		<Stack gap="xs">
			<Text size="sm" fw={600}>
				{t(`sidecar.sources.${source}`)}
			</Text>
			<Text size="xs" c="dimmed">
				{t(isTasks ? "sidecar.frequency.saveScope" : "sidecar.frequency.globalScope")}
			</Text>
			<NumberInput
				label={t("sidecar.frequency.title")}
				description={t(isTasks ? "sidecar.frequency.tasksHint" : "sidecar.frequency.progressHint")}
				value={value}
				onChange={setDraft}
				min={-1}
				max={1000}
				allowDecimal={false}
				disabled={!ready || !permitted || pending}
				onKeyDown={(event) => {
					if (event.key === "Enter" && valid) {
						event.preventDefault();
						void save(value as number, isTasks);
					}
				}}
			/>
			{!permitted && (
				<Text size="xs" c="dimmed">
					{t("sidecar.frequency.adminOnly")}
				</Text>
			)}
			{error && (
				<Text size="xs" c="red" role="alert">
					{error.message}
				</Text>
			)}
			<Group justify="space-between" gap="xs">
				{isTasks && (
					<Group justify="space-between" gap={4} w="100%">
						<Button
							size="xs"
							px={6}
							variant="subtle"
							disabled={!ready || pending}
							onClick={() => void save(null)}
						>
							{t("override_followDefault")}
						</Button>
						<Button
							size="xs"
							px={6}
							variant="subtle"
							title={t("sidecar.frequency.sessionScope")}
							disabled={!ready || pending || !valid}
							onClick={() => void save(value as number)}
						>
							{t("sidecar.frequency.saveSession")}
						</Button>
					</Group>
				)}
				<Button
					size="xs"
					ml="auto"
					loading={pending}
					title={t(
						user?.role === "admin"
							? "sidecar.frequency.globalScope"
							: "sidecar.frequency.adminOnly",
					)}
					disabled={!ready || user?.role !== "admin" || !valid}
					onClick={() => void save(value as number, isTasks)}
				>
					{tc("save")}
				</Button>
			</Group>
		</Stack>
	);
}

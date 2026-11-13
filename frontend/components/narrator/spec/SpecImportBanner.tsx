/**
 * The Spec panel's banner for a session that still keeps its tasks in Dynamic Spec while the
 * outline is on (outline P2 PR 12b): says the session will be imported, offers "Import now", and
 * shows how the last attempt went (running, busy, failed with its reason and a retry, needs
 * attention, moved back to Dynamic Spec by an administrator). The reason is said in the reader's
 * language from its code.
 * Nothing is drawn for a session that is not to be imported, or with imports switched off. Once
 * the session was moved the panel itself becomes the task board (`SpecPanel`).
 */
import { Box, Button, Group, Loader, Text } from "@mantine/core";
import { IconAlertTriangle, IconArrowsExchange } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useSpecImportStatus, useStartSpecImport } from "../../../hooks/useSpecImport";

export function SpecImportBanner({ narratorId }: { narratorId: string }) {
	const { t } = useTranslation("narrator");
	const { data } = useSpecImportStatus(narratorId);
	const start = useStartSpecImport(narratorId);
	if (!data || data.mode === "off" || !data.importable) return null;
	const running = data.state === "running" || start.isPending;
	const problem = !running && (data.state === "failed" || data.state === "attention");
	const busy = !running && (data.state === "busy" || start.isError);
	const reverted = !running && data.state === "reverted";
	const message = running
		? t("spec.specImportRunning")
		: reverted
			? t("spec.specImportReverted")
			: data.state === "attention"
				? t("spec.specImportAttention")
				: data.state === "failed"
					? t("spec.specImportFailed")
					: busy
						? t("spec.specImportBusy")
						: data.mode === "manual"
							? t("spec.specImportManual")
							: t("spec.specImportAuto");
	const reason = data.reason
		? t(`spec.specImportReason.${data.reason.code}`, { n: data.reason.count ?? 0 })
		: t("spec.specImportReason.other");
	return (
		<Group
			gap={8}
			px="xs"
			py={6}
			wrap="nowrap"
			align="flex-start"
			data-testid="spec-import-banner"
			data-state={running ? "running" : busy ? "busy" : data.state}
			style={{
				flexShrink: 0,
				borderBottom: "1px solid var(--mantine-color-default-border)",
				background: "var(--mantine-color-default-hover)",
			}}
		>
			<Box style={{ flexShrink: 0, marginTop: 2, lineHeight: 0 }} aria-hidden>
				{running ? (
					<Loader size={13} />
				) : problem ? (
					<IconAlertTriangle size={13} color="var(--mantine-color-yellow-6)" />
				) : (
					<IconArrowsExchange size={13} color="var(--mantine-color-dimmed)" />
				)}
			</Box>
			<Box style={{ flex: 1, minWidth: 0 }}>
				<Text size="xs">{message}</Text>
				{problem && (data.reason || data.error) && (
					<Text
						size="xs"
						c="dimmed"
						data-testid="spec-import-error"
						style={{ overflowWrap: "anywhere" }}
					>
						{t("spec.specImportError", { error: reason, interpolation: { escapeValue: false } })}
					</Text>
				)}
			</Box>
			{data.canImport && !running && (
				<Button
					size="compact-xs"
					variant="light"
					style={{ flexShrink: 0 }}
					onClick={() => start.mutate()}
					data-testid="spec-import-now"
				>
					{problem ? t("spec.specImportRetry") : t("spec.specImportNow")}
				</Button>
			)}
		</Group>
	);
}

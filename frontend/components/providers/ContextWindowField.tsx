import { Badge, Loader, Tooltip, UnstyledButton } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useModelDescription } from "../../hooks/useModelCatalog";
import { formatLocaleNumber } from "../../lib/intl-format";
import { ModelOverrideEditor } from "../settings/ModelOverrideEditor";

export function formatWindow(value: number): string {
	if (value >= 1_000_000 && value % 1_000 === 0)
		return `${Number((value / 1_000_000).toFixed(3))}M`;
	if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`;
	return String(value);
}

const ORIGIN_COLOR: Record<string, string> = {
	connection: "blue",
	model: "indigo",
	upstream: "cyan",
	provider: "grape",
	catalog: "gray",
	default: "yellow",
};

export interface ContextWindowFieldProps {
	/** The full model value as this provider list shows it (`provider:model`). */
	modelValue: string;
}

/**
 * A provider entry's context window as requests use it, colored by where it comes from.
 * Clicking it opens the model parameter editor for this entry.
 */
export function ContextWindowField({ modelValue }: ContextWindowFieldProps) {
	const { t } = useTranslation("settings");
	const [opened, setOpened] = useState(false);
	const { data, isLoading } = useModelDescription(modelValue);
	const window = data?.effective.contextWindow;
	return (
		<>
			{isLoading ? (
				<Loader size={12} />
			) : (
				<Tooltip
					label={
						window
							? `${t("catalog.field.contextWindow")}: ${formatLocaleNumber(window.value)} · ${t(`catalog.origin.${window.origin}`)}`
							: t("catalog.field.contextWindow")
					}
				>
					<UnstyledButton onClick={() => setOpened(true)} aria-label={t("catalog.edit")}>
						<Badge
							size="sm"
							variant="light"
							color={window ? ORIGIN_COLOR[window.origin] : "gray"}
							style={{ cursor: "pointer" }}
						>
							{window ? formatWindow(window.value) : "—"}
						</Badge>
					</UnstyledButton>
				</Tooltip>
			)}
			{opened && (
				<ModelOverrideEditor model={modelValue} opened={opened} onClose={() => setOpened(false)} />
			)}
		</>
	);
}

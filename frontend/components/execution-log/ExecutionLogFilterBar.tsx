import { MOBILE_VIEWPORT_MEDIA_QUERY } from "@frontend/lib/responsive";
import type {
	ExecutionLogFacets,
	ExecutionLogFilters,
	ExecutionLogStatus,
} from "@frontend/types/execution-log";
import {
	Autocomplete,
	Button,
	Group,
	Select,
	SimpleGrid,
	Stack,
	Switch,
	TextInput,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconFilter, IconSearch } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

/** Draft state: edited freely, only turned into filters when the user applies. */
export interface ExecutionLogDraftFilters {
	q: string;
	searchPayload: boolean;
	toolName: string | null;
	status: ExecutionLogStatus | null;
	provider: string;
	model: string;
	narratorId: string;
	includeSubagents: boolean;
	onlyErrors: boolean;
	showCheckpoints: boolean;
	startDate: string;
	endDate: string;
}

export const EMPTY_EXECUTION_LOG_DRAFT: ExecutionLogDraftFilters = {
	q: "",
	searchPayload: false,
	toolName: null,
	status: null,
	provider: "",
	model: "",
	narratorId: "",
	includeSubagents: false,
	onlyErrors: false,
	showCheckpoints: false,
	startDate: "",
	endDate: "",
};

/**
 * Turn the draft into the filters the API accepts.
 *
 * Dates arrive as `YYYY-MM-DD` from the native pickers and are widened to cover
 * the whole local day, then sent as UTC instants — the server compares them
 * against `startedAt`, which is stored as an ISO string.
 */
export function toExecutionLogFilters(draft: ExecutionLogDraftFilters): ExecutionLogFilters {
	const q = draft.q.trim();
	return {
		q: q || undefined,
		// Payload search is meaningless without a needle, and the server rejects it.
		searchPayload: q ? draft.searchPayload : undefined,
		toolName: draft.toolName ?? undefined,
		status: draft.status ?? undefined,
		provider: draft.provider.trim() || undefined,
		model: draft.model.trim() || undefined,
		narratorId: draft.narratorId.trim() || undefined,
		includeSubagents: draft.narratorId.trim() ? draft.includeSubagents : undefined,
		onlyErrors: draft.onlyErrors || undefined,
		hideFileHistoryCheckpoints: draft.showCheckpoints ? false : undefined,
		startDate: draft.startDate ? new Date(`${draft.startDate}T00:00:00`).toISOString() : undefined,
		endDate: draft.endDate ? new Date(`${draft.endDate}T23:59:59.999`).toISOString() : undefined,
	};
}

interface ExecutionLogFilterBarProps {
	draft: ExecutionLogDraftFilters;
	onDraftChange: (next: ExecutionLogDraftFilters) => void;
	onApply: () => void;
	onReset: () => void;
	facets?: ExecutionLogFacets;
}

export function ExecutionLogFilterBar({
	draft,
	onDraftChange,
	onApply,
	onReset,
	facets,
}: ExecutionLogFilterBarProps) {
	const { t } = useTranslation("common");
	const isMobile = useMediaQuery(MOBILE_VIEWPORT_MEDIA_QUERY) ?? false;
	const size = isMobile ? "xs" : "sm";
	const patch = (next: Partial<ExecutionLogDraftFilters>) => onDraftChange({ ...draft, ...next });

	const statusOptions = (facets?.statuses ?? []).map((status) => ({
		value: status,
		label: t(`executionLogStatus_${status}`),
	}));

	return (
		<Stack gap={isMobile ? "xs" : "md"}>
			<TextInput
				size={size}
				label={t("executionLogSearch")}
				placeholder={t("executionLogSearchPlaceholder")}
				leftSection={<IconSearch size={14} />}
				value={draft.q}
				onChange={(event) => patch({ q: event.currentTarget.value })}
				onKeyDown={(event) => {
					if (event.key === "Enter") onApply();
				}}
			/>

			<Group gap={isMobile ? "xs" : "md"} wrap="wrap">
				<Switch
					size={size}
					label={t("executionLogSearchPayload")}
					description={t("executionLogSearchPayloadHint")}
					checked={draft.searchPayload}
					disabled={!draft.q.trim()}
					onChange={(event) => patch({ searchPayload: event.currentTarget.checked })}
				/>
				<Switch
					size={size}
					label={t("executionLogOnlyErrors")}
					checked={draft.onlyErrors}
					onChange={(event) => patch({ onlyErrors: event.currentTarget.checked })}
				/>
				<Switch
					size={size}
					label={t("executionLogShowCheckpoints")}
					description={t("executionLogShowCheckpointsHint")}
					checked={draft.showCheckpoints}
					onChange={(event) => patch({ showCheckpoints: event.currentTarget.checked })}
				/>
			</Group>

			<SimpleGrid
				cols={{ base: 1, sm: 2, lg: 4 }}
				spacing={isMobile ? "xs" : "md"}
				verticalSpacing={isMobile ? "xs" : "md"}
			>
				<Select
					size={size}
					label={t("executionLogTool")}
					placeholder={t("executionLogAllTools")}
					data={facets?.toolNames ?? []}
					searchable
					clearable
					value={draft.toolName}
					onChange={(value) => patch({ toolName: value })}
				/>
				<Select
					size={size}
					label={t("executionLogStatusLabel")}
					placeholder={t("executionLogAllStatuses")}
					data={statusOptions}
					clearable
					value={draft.status}
					onChange={(value) => patch({ status: (value as ExecutionLogStatus | null) ?? null })}
				/>
				<Autocomplete
					size={size}
					label={t("executionLogProvider")}
					placeholder={t("executionLogAllProviders")}
					data={facets?.providers ?? []}
					value={draft.provider}
					onChange={(value) => patch({ provider: value })}
				/>
				<TextInput
					size={size}
					label={t("executionLogModel")}
					placeholder={t("executionLogModelPlaceholder")}
					value={draft.model}
					onChange={(event) => patch({ model: event.currentTarget.value })}
				/>
				<TextInput
					size={size}
					label={t("executionLogNarratorId")}
					placeholder={t("executionLogNarratorIdPlaceholder")}
					value={draft.narratorId}
					onChange={(event) => patch({ narratorId: event.currentTarget.value })}
				/>
				<Switch
					size={size}
					mt={isMobile ? 0 : 26}
					label={t("executionLogIncludeSubagents")}
					checked={draft.includeSubagents}
					disabled={!draft.narratorId.trim()}
					onChange={(event) => patch({ includeSubagents: event.currentTarget.checked })}
				/>
				<TextInput
					size={size}
					label={t("executionLogStartDate")}
					type="date"
					value={draft.startDate}
					onChange={(event) => patch({ startDate: event.currentTarget.value })}
				/>
				<TextInput
					size={size}
					label={t("executionLogEndDate")}
					type="date"
					value={draft.endDate}
					onChange={(event) => patch({ endDate: event.currentTarget.value })}
				/>
			</SimpleGrid>

			<Group grow={isMobile} wrap="wrap" gap={isMobile ? "xs" : "sm"}>
				<Button
					size={size}
					leftSection={<IconFilter size={isMobile ? 14 : 16} />}
					onClick={onApply}
				>
					{t("executionLogApplyFilters")}
				</Button>
				<Button size={size} variant="light" onClick={onReset}>
					{t("executionLogReset")}
				</Button>
			</Group>
		</Stack>
	);
}

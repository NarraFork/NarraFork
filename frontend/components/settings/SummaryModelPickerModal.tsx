import { Code, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import { useUpdateRuntimeSettings } from "../../hooks/useUpdateRuntimeSettings";
import { SetGlobalModelModal } from "../narrator/interaction/SetGlobalModelModal";

export type SummaryModelPickerErrorKind = "unavailable" | "error";
export interface SummaryModelPickerModalProps {
	opened: boolean;
	unavailableModel: string;
	errorMessage: string;
	errorKind: SummaryModelPickerErrorKind;
	onClose: () => void;
	onSaved: () => void;
}

/** Shares the on-demand paginated directory, not the complete management settings. */
export function SummaryModelPickerModal({
	opened,
	unavailableModel,
	errorMessage,
	errorKind,
	onClose,
	onSaved,
}: SummaryModelPickerModalProps) {
	const { t } = useTranslation("settings");
	const save = useUpdateRuntimeSettings();
	return (
		<SetGlobalModelModal
			opened={opened}
			mode="summary"
			groupedModels={[]}
			currentValue={null}
			saving={save.isPending}
			onClose={onClose}
			onConfirm={(summaryModel) => save.mutate({ agent: { summaryModel } }, { onSuccess: onSaved })}
			title={
				errorKind === "unavailable"
					? t("summaryModelUnavailableTitle")
					: t("summaryModelErrorTitle")
			}
			confirmLabel={t("summaryModelUnavailableConfirm")}
		>
			<Stack gap="xs">
				<Text size="sm" c="dimmed">
					{errorKind === "unavailable"
						? t("summaryModelUnavailableDesc")
						: t("summaryModelErrorDescIntro")}
				</Text>
				{(unavailableModel || errorMessage) && (
					<Code block style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
						{unavailableModel}
						{errorMessage ? `${unavailableModel ? "\n" : ""}${errorMessage}` : ""}
					</Code>
				)}
				{errorKind === "unavailable" && (
					<Text size="sm" c="dimmed">
						{t("summaryModelUnavailableHint")}
					</Text>
				)}
				{save.error && (
					<Text size="sm" c="red" role="alert">
						{save.error.message}
					</Text>
				)}
			</Stack>
		</SetGlobalModelModal>
	);
}

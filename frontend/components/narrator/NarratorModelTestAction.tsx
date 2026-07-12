import { ActionIcon, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconNetwork } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useCurrentUser } from "../../hooks/useAuth";
import { useAllModels } from "../../hooks/useModels";
import { useNarrator } from "../../hooks/useNarrator";
import { isModelNetworkError, resolveModelTestTarget } from "../../lib/model-network-error";
import { ModelTestDialog } from "../providers/ModelTestDialog";

export function NarratorModelTestAction({
	narratorId,
	errorMessage,
}: {
	narratorId: string;
	errorMessage: string;
}) {
	const { t } = useTranslation("narrator");
	const { data: currentUser } = useCurrentUser();
	const { data: narrator } = useNarrator(narratorId);
	const { defaultModelValue } = useAllModels();
	const [opened, { open, close }] = useDisclosure(false);
	const narratorModel = typeof narrator?.model === "string" ? narrator.model.trim() : "";
	const selectedModelValue = narratorModel || defaultModelValue;
	const modelValue = resolveModelTestTarget(selectedModelValue, narrator?.runtimeModel);

	if (currentUser?.role !== "admin" || !modelValue || !isModelNetworkError(errorMessage)) {
		return null;
	}

	return (
		<>
			<Tooltip label={t("testCurrentModel")} withArrow>
				<ActionIcon
					size="xs"
					variant="subtle"
					color="blue.7"
					style={{ flexShrink: 0 }}
					onClick={open}
					aria-label={t("testCurrentModel")}
				>
					<IconNetwork size={14} />
				</ActionIcon>
			</Tooltip>
			<ModelTestDialog
				opened={opened}
				onClose={close}
				modelValue={modelValue}
				selectedModelValue={selectedModelValue}
				sourceError={errorMessage}
			/>
		</>
	);
}

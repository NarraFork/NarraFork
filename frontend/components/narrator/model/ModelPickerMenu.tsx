import { Menu, NativeSelect, Tooltip } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useInputMenu } from "../../../hooks/useInputMenu";
import { useRuntimeModel } from "../../../hooks/useModelCatalog";
import { useModelRuntimeSettings } from "../../../hooks/useModels";
import { FOLLOW_DEFAULT_MODEL, type ModelOption } from "../../../lib/constants";
import { followDefaultLabel } from "../../../lib/follow-model-label";
import { ModelPriceModal } from "./ModelPriceModal";
import { MODEL_MENU_POSITIONING } from "./model-menu-selection";
import { PaginatedModelMenuItems } from "./PaginatedModelMenuItems";

/** A draft picker: the header reads one summary, and the directory opens on demand. */
export function ModelPickerMenu({
	value,
	onChange,
	position = "bottom-start",
}: {
	value: string;
	onChange: (model: string) => void;
	position?: "bottom-start" | "top-end";
}) {
	const { t } = useTranslation("narrator");
	const inputMenu = useInputMenu();
	const [opened, setOpened] = useState(false);
	const [priceModel, setPriceModel] = useState<ModelOption | null>(null);
	const { defaultModelValue, summaryModelValue, settingsData } = useModelRuntimeSettings();
	const { data: summary } = useRuntimeModel({
		model: value,
		revision: settingsData?.revision == null ? undefined : String(settingsData.revision),
		enabled: !!settingsData,
	});
	const label =
		value === FOLLOW_DEFAULT_MODEL
			? followDefaultLabel(t, defaultModelValue)
			: value === "__parent__"
				? t("followParent")
				: value === "__summary__"
					? t("modelGroupSummary")
					: (summary?.selection.label ?? value);
	return (
		<>
			<Tooltip label={t("modelTooltip")} disabled={opened}>
				<Menu
					position={position}
					{...inputMenu.menuProps}
					{...MODEL_MENU_POSITIONING}
					opened={opened}
					onChange={(next) => {
						if (!next && priceModel) return;
						setOpened(next);
					}}
				>
					<Menu.Target>
						<NativeSelect
							{...inputMenu.targetProps}
							size="xs"
							aria-label={t("modelTooltip")}
							data={[{ value, label }]}
							value={value}
							onChange={() => {}}
							onMouseDown={(event: React.MouseEvent) => event.preventDefault()}
							style={{ pointerEvents: "auto", minWidth: 0 }}
						/>
					</Menu.Target>
					<Menu.Dropdown data-model-menu-scroll style={{ maxHeight: "60vh", overflowY: "auto" }}>
						<PaginatedModelMenuItems
							opened={opened}
							currentModel={value}
							onSelect={onChange}
							onShowPrice={setPriceModel}
							defaultModelValue={defaultModelValue}
							summaryModelValue={summaryModelValue}
						/>
					</Menu.Dropdown>
				</Menu>
			</Tooltip>
			{priceModel && (
				<ModelPriceModal model={priceModel} opened onClose={() => setPriceModel(null)} />
			)}
		</>
	);
}

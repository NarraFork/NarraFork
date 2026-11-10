import { Menu, NativeSelect, Tooltip } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useInputMenu } from "../../../hooks/useInputMenu";
import { useAllModels } from "../../../hooks/useModels";
import { api } from "../../../lib/api";
import {
	AGG_MODEL_PREFIX,
	FOLLOW_DEFAULT_MODEL,
	type ModelOption,
	parseAggModelValue,
} from "../../../lib/constants";
import { ModelMenuItems } from "./ModelMenuItems";
import { ModelPriceModal } from "./ModelPriceModal";
import { MODEL_MENU_POSITIONING } from "./model-menu-selection";
import { useModelMenuProviderBadges } from "./use-model-menu-provider-badges";
import { useModelMenuRefreshProps } from "./use-model-menu-refresh-props";

/**
 * The narrator status bar's model picker, detached from a session: the same
 * compact select-style trigger and the same {@link ModelMenuItems} catalog, but
 * the choice is local state of the caller (e.g. a composer that creates the
 * session on send).
 */
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
	const {
		visibleWithDefault: allModels,
		defaultModelValue,
		summaryModelValue,
		aggregations,
		providerLabels,
		nugProviderIdByPrefix,
	} = useAllModels();
	const refreshProps = useModelMenuRefreshProps(nugProviderIdByPrefix);
	// Same cache entry as useAllModels; feeds the provider allowance/balance badges.
	const { data: settingsData } = useQuery({
		queryKey: ["settings"],
		queryFn: api.getSettings,
		staleTime: 30_000,
	});
	const { providerBadges, providerBalances } = useModelMenuProviderBadges(settingsData, opened);

	const agg = parseAggModelValue(value);
	// A pinned aggregation member displays as its aggregation, as in the status bar.
	const triggerValue = agg ? `${AGG_MODEL_PREFIX}${agg.aggId}` : value;
	// The menu renders the full catalog; the trigger only needs the selected option.
	const triggerData = allModels
		.filter((m) => m.value === triggerValue)
		.map((m) => ({
			value: m.value,
			label:
				m.value === FOLLOW_DEFAULT_MODEL
					? t("followDefault", { model: defaultModelValue })
					: m.provider === "__agg__"
						? `⚡ ${m.label}`
						: m.provider === "__auto__"
							? m.label
							: m.provider
								? `${m.provider}:${m.label}`
								: m.label,
		}));

	return (
		<>
			<Tooltip label={t("modelTooltip")} disabled={opened}>
				<Menu
					position={position}
					{...inputMenu.menuProps}
					{...MODEL_MENU_POSITIONING}
					opened={opened}
					onChange={(next) => {
						// Don't let the price popup's outside-click close the menu.
						if (!next && priceModel != null) return;
						setOpened(next);
					}}
				>
					<Menu.Target>
						<NativeSelect
							{...inputMenu.targetProps}
							size="xs"
							aria-label={t("modelTooltip")}
							data={triggerData}
							value={triggerValue}
							onChange={() => {}}
							onMouseDown={(e: React.MouseEvent) => e.preventDefault()}
							style={{ pointerEvents: "auto", minWidth: 0 }}
						/>
					</Menu.Target>
					<Menu.Dropdown data-model-menu-scroll style={{ maxHeight: "60vh", overflowY: "auto" }}>
						<ModelMenuItems
							opened={opened}
							aggregations={aggregations}
							allModels={allModels}
							currentModel={value}
							totalCostUsd={null}
							onSelect={onChange}
							onShowPrice={setPriceModel}
							providerLabels={providerLabels}
							providerBadges={providerBadges}
							providerBalances={providerBalances}
							defaultModelValue={defaultModelValue}
							summaryModelValue={summaryModelValue}
							{...refreshProps}
						/>
					</Menu.Dropdown>
				</Menu>
			</Tooltip>
			<ModelPriceModal
				model={priceModel}
				opened={priceModel != null}
				onClose={() => setPriceModel(null)}
			/>
		</>
	);
}

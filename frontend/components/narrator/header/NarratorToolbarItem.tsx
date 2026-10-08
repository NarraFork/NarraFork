import { ActionIcon, Indicator, Menu, Tooltip } from "@mantine/core";
import { PluginContributionPicker } from "../../plugins/PluginContributionPicker";
import { PathRulesPopover } from "../interaction/PathRulesPopover";
import { NarratorLodMenu } from "../lod/NarratorLodMenu";
import { ExecutionDeviceMenu } from "../model/ExecutionDeviceMenu";
import type { NarratorStatusToolbarAction } from "./NarratorStatusToolbar";
import {
	type NarratorToolbarBadgeCounts,
	resolveNarratorToolbarBadge,
} from "./narrator-toolbar-badges";
import type { NarratorToolbarItemDef } from "./narrator-toolbar-items";
import type { UseHeaderToolbarOptions, UseHeaderToolbarResult } from "./use-header-toolbar";

export type ToolbarInlineControls = Pick<
	UseHeaderToolbarOptions,
	| "executionDevicesQuery"
	| "updateExecutionDeviceMutation"
	| "renderLod"
	| "renderLodIsDefault"
	| "handleSelectLod"
	| "setAsDefault"
	| "openPluginPanel"
>;

export interface NarratorToolbarItemProps {
	def: NarratorToolbarItemDef;
	narratorId: string;
	controller: UseHeaderToolbarResult;
	inlineControls: ToolbarInlineControls;
	toolbarBadgeCounts: NarratorToolbarBadgeCounts;
	t: (key: string, opts?: Record<string, unknown>) => string;
	mode?: "inline" | "menu";
}

/** One presentation and activation contract for header, bottom row and mobile overflow. */
export function NarratorToolbarItem({
	def,
	narratorId,
	controller,
	inlineControls,
	toolbarBadgeCounts,
	t,
	mode = "inline",
}: NarratorToolbarItemProps) {
	const Icon = def.icon;
	const title = t(def.labelKey, { ns: def.namespace ?? "narrator" });
	const label =
		def.badge === "backgroundTasks"
			? `${title}: ${t("backgroundTasks.activeKinds", { ns: "narrator", work: toolbarBadgeCounts.backgroundWork ?? toolbarBadgeCounts.backgroundTasks, services: toolbarBadgeCounts.backgroundServices ?? 0 })}`
			: title;
	const active = controller.toolbarEntryActive(def.id);
	const badge = resolveNarratorToolbarBadge(def.badge, toolbarBadgeCounts);
	if (def.id === "path-rules" && mode === "inline") {
		return <PathRulesPopover narratorId={narratorId} t={t} triggerMode="icon" />;
	}
	if (mode === "menu") {
		if (def.selfContained && def.id !== "path-rules") {
			return (
				<>
					<Menu.Label>{label}</Menu.Label>
					{controller.renderToolbarInlineOptions(def.id, () => {})}
				</>
			);
		}
		return (
			<Menu.Item
				leftSection={<Icon size={16} />}
				onClick={() => controller.activateToolbarEntry(def.id)}
			>
				{label}
			</Menu.Item>
		);
	}
	if (def.id === "device") {
		return (
			<ExecutionDeviceMenu
				label={t("executionDeviceSelector")}
				localLabel={t("executionTargetLocal")}
				offlineLabel={t("executionDeviceOffline")}
				devices={inlineControls.executionDevicesQuery.data?.devices ?? []}
				currentDeviceId={inlineControls.executionDevicesQuery.data?.defaultDeviceId ?? "local"}
				pending={inlineControls.updateExecutionDeviceMutation.isPending}
				onSelect={(deviceId) => inlineControls.updateExecutionDeviceMutation.mutate(deviceId)}
			/>
		);
	}
	if (def.id === "lodlevel") {
		return (
			<NarratorLodMenu
				lod={inlineControls.renderLod}
				isDefault={inlineControls.renderLodIsDefault}
				onSelectLod={inlineControls.handleSelectLod}
				onSetAsDefault={inlineControls.setAsDefault}
			/>
		);
	}
	if (def.id === "plugins") {
		return (
			<PluginContributionPicker
				onPick={inlineControls.openPluginPanel}
				surface="focus"
				trigger={
					<Tooltip label={label}>
						<ActionIcon size="sm" variant="subtle" color="gray" aria-label={label}>
							<Icon size={16} />
						</ActionIcon>
					</Tooltip>
				}
			/>
		);
	}
	const button = (
		<ActionIcon
			size="sm"
			variant={active ? "light" : "subtle"}
			color={active ? "indigo" : "gray"}
			aria-label={label}
			onClick={def.selfContained ? undefined : () => controller.activateToolbarEntry(def.id)}
		>
			<Icon size={16} />
		</ActionIcon>
	);
	return (
		<Tooltip label={label}>
			{badge.count > 0 ? (
				<Indicator
					inline
					size={badge.processing ? 8 : 14}
					offset={badge.processing ? 3 : 4}
					label={badge.processing ? undefined : badge.label}
					processing={badge.processing}
					color={badge.processing ? "blue" : "teal"}
					zIndex={1}
					style={{ height: "var(--ai-size-sm)", display: "flex", alignItems: "center" }}
				>
					{button}
				</Indicator>
			) : (
				button
			)}
		</Tooltip>
	);
}

export function buildBottomToolbarActions(
	props: Omit<NarratorToolbarItemProps, "def" | "mode"> & {
		defs: readonly NarratorToolbarItemDef[];
	},
): NarratorStatusToolbarAction[] {
	return props.defs.map((def, index) => ({
		key: def.id,
		// Keep the user's first tools visible longest as the row narrows.
		collapsePriority: 40 + props.defs.length - index,
		visualOverflow: { inlineEnd: 4 },
		render: (mode) => <NarratorToolbarItem {...props} def={def} mode={mode} />,
	}));
}

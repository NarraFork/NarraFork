/**
 * Plugin contribution picker — the discovery → open entry point for plugin
 * panels.
 *
 * Lists every host-owned contribution from the reactive registry (backend is
 * the only source of truth), grouped by plugin, with non-available entries
 * visible but disabled with their status badge. Selecting an available entry
 * invokes `onPick`, which the Dock/Workspace surfaces use to `addPanel` a
 * `plugin` Dockview panel with schema-valid params.
 */

import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Center,
	Group,
	Loader,
	Menu,
	Stack,
	Text,
	ThemeIcon,
	Tooltip,
} from "@mantine/core";
import { IconPuzzle, IconRefresh } from "@tabler/icons-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { usePluginContributions } from "../../hooks/usePluginContributions";
import type { PluginContributionRecord } from "./PluginContributionStore";
import type { PluginUiHostSurface, PluginUiSessionContext } from "./PluginUiSurfaceContext";

export interface PluginContributionPick {
	pluginId: string;
	contributionId: string;
	title: string;
	version: string;
	hash: string;
	scope?: "workspace" | "narrator" | "project" | "global";
}

export interface PluginContributionPickerProps {
	/** Called with the picked contribution. Should addPanel + focus. */
	onPick: (pick: PluginContributionPick) => void;
	/** Custom trigger rendered as the Menu target (must forward props + ref). */
	trigger?: React.ReactElement;
	disabled?: boolean;
	tooltip?: string;
	/**
	 * Host surface the picker is mounted on. Views whose declared surfaces do
	 * not include it, or whose scope cannot be satisfied there (e.g. a
	 * workspace-scoped view on the focus surface has no workspace id), are
	 * hidden — otherwise picking them creates a panel whose session can only
	 * fail with "…scope requires a live … id".
	 */
	surface?: PluginUiHostSurface;
}

function isPackageHash(value: string | undefined): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

/**
 * Scope ids a surface can actually provide: the session context built for that
 * surface has exactly these ids (focus/graph → narratorId; workspace/director →
 * workspaceId; settings/provider-settings → neither).
 *
 * Every surface must appear. A missing key makes the lookup below return `undefined`
 * and the filter drop every contribution for that surface — the panel simply looks
 * empty, with no error to explain why.
 */
const SURFACE_ALLOWED_SCOPES: Record<PluginUiHostSurface, ReadonlySet<string>> = {
	focus: new Set(["global", "narrator"]),
	// A graph node's embedded dock is the focus family: one surface, one narrator.
	graph: new Set(["global", "narrator"]),
	workspace: new Set(["global", "workspace"]),
	director: new Set(["global", "workspace"]),
	settings: new Set(["global"]),
	"provider-settings": new Set(["global"]),
};

function statusColor(availability: PluginContributionRecord["availability"]): string {
	switch (availability) {
		case "available":
			return "teal";
		case "disabled":
			return "gray";
		case "denied":
			return "red";
		case "incompatible":
			return "yellow";
		default:
			return "gray";
	}
}

/**
 * The contribution rows on their own, without a trigger or a dropdown around them.
 *
 * Exported so a host that already owns a Menu (the narrator toolbar's overflow
 * menu, which expands entries inline) can present the same list instead of a dead
 * "header only" row.
 */
export function PluginContributionOptions({
	onPick,
	trigger,
	disabled,
	tooltip,
	surface,
}: PluginContributionPickerProps) {
	const { t } = useTranslation("plugins");
	const { contributions, synced, isFetching, invalidate } = usePluginContributions();

	const records = useMemo(() => {
		const allowedScopes = surface ? SURFACE_ALLOWED_SCOPES[surface] : undefined;
		return Object.values(contributions)
			.filter((record) => {
				if (!surface) return true;
				if (record.surfaces && !record.surfaces.includes(surface)) return false;
				return allowedScopes?.has(record.scope ?? "global") ?? true;
			})
			.sort((a, b) => {
				const pluginCmp = (a.pluginName ?? a.pluginId).localeCompare(b.pluginName ?? b.pluginId);
				return pluginCmp !== 0 ? pluginCmp : a.title.localeCompare(b.title);
			});
	}, [contributions, surface]);
	const availableCount = records.filter(
		(record) => record.availability === "available" && isPackageHash(record.hash),
	).length;

	return (
		<>
			<Group justify="space-between" px="xs" py={4} wrap="nowrap">
				<Text size="xs" fw={600} c="dimmed">
					{t("picker.title")}
				</Text>
				<Tooltip label={t("picker.refresh")} withinPortal>
					<ActionIcon
						size="sm"
						variant="subtle"
						color="gray"
						onClick={invalidate}
						aria-label={t("picker.refresh")}
					>
						<IconRefresh size={14} />
					</ActionIcon>
				</Tooltip>
			</Group>
			<Menu.Divider />
			{!synced && isFetching ? (
				<Center py="md">
					<Loader size="sm" />
				</Center>
			) : records.length === 0 ? (
				<Box px="sm" py="md">
					<Text size="xs" c="dimmed" ta="center">
						{t("picker.empty")}
					</Text>
				</Box>
			) : (
				<>
					{availableCount === 0 ? (
						<Box px="sm" py={4}>
							<Text size="xs" c="dimmed">
								{t("picker.noneAvailable")}
							</Text>
						</Box>
					) : null}
					{records.map((record) => {
						const key = `${record.pluginId}:${record.contributionId}`;
						const available = record.availability === "available" && isPackageHash(record.hash);
						return (
							<Menu.Item
								key={key}
								disabled={!available}
								onClick={() => {
									if (!isPackageHash(record.hash)) return;
									onPick({
										pluginId: record.pluginId,
										contributionId: record.contributionId,
										title: record.title,
										version: record.version ?? "",
										hash: record.hash,
										scope: record.scope,
									});
								}}
								leftSection={
									<ThemeIcon size="sm" variant="light" color={statusColor(record.availability)}>
										<IconPuzzle size={12} />
									</ThemeIcon>
								}
								rightSection={
									record.availability !== "available" ? (
										<Badge size="xs" variant="light" color={statusColor(record.availability)}>
											{t(`picker.status.${record.availability}`)}
										</Badge>
									) : null
								}
							>
								<Stack gap={0}>
									<Text size="xs" fw={500} truncate>
										{record.title}
									</Text>
									<Text size="xs" c="dimmed" truncate>
										{record.pluginName ?? record.pluginId} · {record.version}
									</Text>
								</Stack>
							</Menu.Item>
						);
					})}
				</>
			)}
		</>
	);
}

export function PluginContributionPicker({
	onPick,
	trigger,
	disabled,
	tooltip,
}: PluginContributionPickerProps) {
	const { t } = useTranslation("plugins");

	return (
		<Menu position="bottom-end" withinPortal shadow="md" width={320}>
			<Menu.Target>
				{trigger ?? (
					<Tooltip label={tooltip ?? t("picker.tooltip")} withinPortal>
						<Button
							size="compact-xs"
							variant="subtle"
							color="gray"
							leftSection={<IconPuzzle size={14} />}
							disabled={disabled}
						>
							{t("picker.addPanel")}
						</Button>
					</Tooltip>
				)}
			</Menu.Target>
			<Menu.Dropdown>
				<PluginContributionOptions onPick={onPick} />
			</Menu.Dropdown>
		</Menu>
	);
}

/** Build schema-valid Dockview params for a picked plugin panel. */
export function buildPluginDockPanelParams(input: {
	pluginId: string;
	contributionId: string;
	panelInstanceId: string;
	binding?: import("./protocol").PluginPanelBinding;
	fallback?: {
		title?: string;
		pluginName?: string;
		pluginVersion?: string;
		packageHash?: string;
	};
}): import("./protocol").PluginDockPanelParams {
	return {
		panelType: "plugin",
		schemaVersion: 1,
		pluginId: input.pluginId,
		contributionId: input.contributionId,
		panelInstanceId: input.panelInstanceId,
		binding: input.binding ?? { kind: "host-surface", surface: "settings" },
		...(input.fallback ? { fallback: input.fallback } : {}),
	};
}

export interface PluginDockPanelOpenRequest<TGroup = unknown> {
	id: string;
	component: "plugin";
	title: string;
	params: import("./protocol").PluginDockPanelParams;
	position?: { referenceGroup: TGroup } | { referencePanel: string; direction: "right" };
}

interface PluginDockPanelAnchor<TGroup> {
	id: string;
	group?: TGroup;
	params?: unknown;
}

/**
 * Build the exact Dockview addPanel request used by the picker.
 *
 * Keeping anchor selection and identity construction pure makes the discovery→open
 * contract testable without booting a browser or mutating a live Dockview instance.
 */
export function buildPluginDockPanelOpenRequest<TGroup>(input: {
	pick: PluginContributionPick;
	hostContext?: PluginUiSessionContext;
	panels: readonly PluginDockPanelAnchor<TGroup>[];
}): PluginDockPanelOpenRequest<TGroup> {
	const panelInstanceId = nextPluginPanelInstanceId(input.pick.pluginId, input.pick.contributionId);
	const binding: import("./protocol").PluginPanelBinding = (() => {
		const host = input.hostContext;
		// Record the narrator so the panel can resolve it on any surface;
		// focus-family surfaces can still fall back to their live narrator context.
		if ((host?.surface === "focus" || host?.surface === "graph") && host.narratorId) {
			return { kind: "focus-current-narrator", narratorId: host.narratorId };
		}
		if (
			(host?.surface === "workspace" || host?.surface === "director") &&
			host.workspaceId &&
			host.narratorId
		) {
			return {
				kind: "workspace-narrator",
				workspaceId: host.workspaceId,
				ownerNarratorId: host.narratorId,
			};
		}
		if (host?.surface === "workspace" || host?.surface === "director") {
			return host.workspaceId
				? { kind: "workspace", workspaceId: host.workspaceId }
				: { kind: "host-surface", surface: host.surface };
		}
		return { kind: "global" };
	})();
	const params = buildPluginDockPanelParams({
		pluginId: input.pick.pluginId,
		contributionId: input.pick.contributionId,
		panelInstanceId,
		binding,
		fallback: {
			title: input.pick.title,
			pluginVersion: input.pick.version,
			packageHash: input.pick.hash,
		},
	});
	const secondary = input.panels.find((panel) => {
		const panelParams = panel.params as { panelType?: string } | undefined;
		return panelParams && panelParams.panelType !== "chat" && panelParams.panelType !== "narrator";
	});
	const anchor =
		secondary ??
		input.panels.find((panel) => {
			const panelParams = panel.params as { panelType?: string } | undefined;
			return panelParams?.panelType === "chat" || panelParams?.panelType === "narrator";
		});
	return {
		id: panelInstanceId,
		component: "plugin",
		title: input.pick.title,
		params,
		...(secondary?.group
			? { position: { referenceGroup: secondary.group } }
			: anchor
				? { position: { referencePanel: anchor.id, direction: "right" as const } }
				: {}),
	};
}

let panelInstanceCounter = 0;

/** Generate a collision-proof panel instance id for a newly opened plugin panel. */
export function nextPluginPanelInstanceId(pluginId: string, contributionId: string): string {
	panelInstanceCounter += 1;
	const sanitize = (value: string) => value.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 48);
	return `pui_${sanitize(pluginId)}_${sanitize(contributionId)}_${Date.now().toString(36)}_${panelInstanceCounter.toString(36)}`;
}

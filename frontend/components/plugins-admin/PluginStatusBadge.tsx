import { Badge, Group } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type {
	PluginCompatibilityState,
	PluginDesiredState,
	PluginRuntimeState,
	PluginSummary,
} from "../../lib/api/plugins";

const DESIRED_STATE_COLORS: Record<PluginDesiredState, string> = {
	enabled: "green",
	disabled: "gray",
	uninstalling: "orange",
};

const RUNTIME_STATE_COLORS: Record<PluginRuntimeState, string> = {
	inactive: "gray",
	starting: "blue",
	handshaking: "blue",
	activating: "blue",
	active: "green",
	degraded: "yellow",
	draining: "orange",
	deactivating: "orange",
	stopped: "gray",
	crashed: "red",
	backoff: "orange",
	failed: "red",
	quarantine: "red",
};

const COMPATIBILITY_COLORS: Record<PluginCompatibilityState, string> = {
	unknown: "gray",
	compatible: "green",
	incompatible: "red",
};

function isDesiredState(value: unknown): value is PluginDesiredState {
	return value === "enabled" || value === "disabled" || value === "uninstalling";
}

export function PluginStatusBadge({ plugin }: { plugin: PluginSummary }) {
	const { t } = useTranslation("plugins");
	const desiredState: PluginDesiredState = isDesiredState(plugin.desiredState)
		? plugin.desiredState
		: "disabled";
	const runtimeState = plugin.runtimeState;
	const compatibility = plugin.compatibility;

	return (
		<Group gap={4} wrap="wrap">
			<Badge color={DESIRED_STATE_COLORS[desiredState]} variant="light" size="sm">
				{t(`admin.status.${desiredState}`)}
			</Badge>
			{runtimeState && runtimeState !== "inactive" && (
				<Badge color={RUNTIME_STATE_COLORS[runtimeState] ?? "gray"} variant="outline" size="sm">
					{t(`admin.runtime.${runtimeState}`, { defaultValue: runtimeState })}
				</Badge>
			)}
			{compatibility && compatibility !== "compatible" && (
				<Badge color={COMPATIBILITY_COLORS[compatibility] ?? "gray"} variant="outline" size="sm">
					{t(`admin.compatibility.${compatibility}`, { defaultValue: compatibility })}
				</Badge>
			)}
		</Group>
	);
}

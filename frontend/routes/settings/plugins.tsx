import { createFileRoute, Outlet } from "@tanstack/react-router";
import { usePluginEventRefresh } from "../../hooks/usePluginEventRefresh";

function PluginSettingsLayout() {
	// Live refresh for plugin management data: pushed plugin events invalidate
	// the matching queries; foreground polling remains the fallback.
	usePluginEventRefresh();
	return <Outlet />;
}

export const Route = createFileRoute("/settings/plugins")({
	component: PluginSettingsLayout,
});

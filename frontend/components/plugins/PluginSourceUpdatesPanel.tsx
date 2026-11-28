import { Stack } from "@mantine/core";
import { useState } from "react";
import { PluginSourcePanel } from "./PluginSourcePanel";
import { PluginUpdatePanel } from "./PluginUpdatePanel";

export function PluginSourceUpdatesPanel({
	pluginId,
	canManage = false,
	disabled = false,
}: {
	pluginId: string;
	canManage?: boolean;
	disabled?: boolean;
}) {
	const [dirty, setDirty] = useState(false);
	return (
		<Stack gap="md">
			<PluginSourcePanel
				key={`source/${pluginId}`}
				pluginId={pluginId}
				canManage={canManage}
				disabled={disabled}
				onDirtyChange={setDirty}
			/>
			<PluginUpdatePanel
				key={`updates/${pluginId}`}
				pluginId={pluginId}
				canManage={canManage}
				disabled={disabled}
				sourceDirty={dirty}
			/>
		</Stack>
	);
}

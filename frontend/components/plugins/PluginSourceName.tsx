import { Anchor, Text } from "@mantine/core";
import type { PluginSource } from "@shared/plugin-source";
import { pluginSourceHomepage } from "./plugin-source-management";

export function PluginSourceName({ name, source }: { name: string; source?: PluginSource | null }) {
	const homepage = pluginSourceHomepage(source);
	if (!homepage)
		return (
			<Text component="span" inherit>
				{name}
			</Text>
		);
	return (
		<Anchor
			href={homepage}
			target="_blank"
			rel="noopener noreferrer"
			inherit
			onClick={(event) => event.stopPropagation()}
		>
			{name}
		</Anchor>
	);
}

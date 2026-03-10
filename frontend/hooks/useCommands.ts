import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { CommandItem } from "../components/narrator/CommandPopover";
import { api } from "../lib/api";

export function useNarratorCommands(narratorId: string | undefined) {
	const { i18n } = useTranslation();
	const isZh = i18n.language?.startsWith("zh");
	return useQuery({
		queryKey: ["narrator-commands", narratorId],
		queryFn: () => api.getNarratorCommands(narratorId as string),
		enabled: !!narratorId,
		staleTime: 30_000,
		select: (data): CommandItem[] => {
			const commands: CommandItem[] = (data.commands ?? []).map((c) => ({
				name: c.name,
				prompt: c.prompt,
				description: c.description,
				source: c.source,
				type: "command" as const,
				params: c.params,
			}));
			const skills: CommandItem[] = (data.skills ?? []).map((s) => ({
				name: s.name,
				prompt: "",
				description: s.description,
				source: s.source,
				type: "skill" as const,
			}));

			const toolItems = data.tools ?? [];
			const items: CommandItem[] = [...commands, ...skills];

			// Add a single "/load" entry when tools are available
			if (toolItems.length > 0) {
				const toolNames = toolItems
					.map(
						(t: { id: string; toolName: string; descriptionEn: string; descriptionZh: string }) =>
							t.id,
					)
					.join(", ");
				items.push({
					name: "load",
					prompt: "",
					description: isZh
						? `加载可选工具到当前会话 (${toolNames})`
						: `Load an optional tool into the session (${toolNames})`,
					source: "builtin",
					type: "tool" as const,
				});
				// Add sub-items for each tool: "load <id>"
				for (const t of toolItems as Array<{
					id: string;
					toolName: string;
					descriptionEn: string;
					descriptionZh: string;
				}>) {
					items.push({
						name: `load ${t.id}`,
						prompt: "",
						description: isZh ? t.descriptionZh : t.descriptionEn,
						source: "builtin",
						type: "tool" as const,
					});
				}
			}

			return items;
		},
	});
}

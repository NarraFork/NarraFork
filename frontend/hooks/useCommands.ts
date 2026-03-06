import { useQuery } from "@tanstack/react-query";
import type { CommandItem } from "../components/narrator/CommandPopover";
import { api } from "../lib/api";

export function useNarratorCommands(narratorId: string | undefined) {
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
			}));
			const skills: CommandItem[] = (data.skills ?? []).map((s) => ({
				name: s.name,
				prompt: "",
				description: s.description,
				source: s.source,
				type: "skill" as const,
			}));
			return [...commands, ...skills];
		},
	});
}

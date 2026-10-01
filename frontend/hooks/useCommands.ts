import { pickLocalizedValue } from "@shared/i18n-locales";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { CommandItem } from "../components/narrator/composer/CommandPopover";
import { api } from "../lib/api";

const NARRATOR_COMMANDS_GC_TIME_MS = 60_000;

export function useNarratorCommands(narratorId: string | undefined) {
	const { i18n } = useTranslation();
	const locale = i18n.resolvedLanguage ?? i18n.language;
	const localize = (en: string, zhCN: string) => pickLocalizedValue({ en, "zh-CN": zhCN }, locale);
	return useQuery({
		queryKey: ["narrator-commands", narratorId],
		queryFn: () => api.getNarratorCommands(narratorId as string),
		enabled: !!narratorId,
		staleTime: 10_000,
		gcTime: NARRATOR_COMMANDS_GC_TIME_MS,
		select: (data): CommandItem[] => {
			const commands: CommandItem[] = [
				{
					name: "new",
					prompt: "/new [message]",
					description: localize(
						"Create and open a session in the current working directory; send trailing text as the first message",
						"按当前工作目录新建并打开会话；后续文本会作为首条消息发送",
					),
					source: "builtin",
					type: "command" as const,
				},
				{
					name: "fork",
					prompt: "",
					description: localize(
						"Fork a new session from the latest message (same as its right-click fork)",
						"从最新消息分叉出新会话（等同于最新消息的右键分叉）",
					),
					source: "builtin",
					type: "command" as const,
				},
				{
					name: "compact",
					prompt: "",
					description: localize(
						"Compact the conversation context now (same as the context-ring action)",
						"立即压缩当前会话上下文（等同于上下文圆环的“立即压缩”）",
					),
					source: "builtin",
					type: "command" as const,
				},
				...(data.commands ?? []).map((c) => ({
					name: c.name,
					prompt: c.prompt,
					description: c.description,
					source: c.source,
					type: "command" as const,
					runBashFirst: c.runBashFirst,
					bashCommand: c.bashCommand,
					params: c.params,
				})),
			];
			const skillList = data.skills ?? [];
			const skills: CommandItem[] = skillList
				.filter((s) => !s.blocked)
				.map((s) => ({
					name: s.name,
					prompt: "",
					description: s.description,
					source: s.source,
					type: "skill" as const,
				}));

			const toolItems = data.tools ?? [];
			const items: CommandItem[] = [...commands, ...skills];

			// Skill blocking: /unload skill <name> / /unload all_skills and the
			// symmetric /load ... to lift the restriction.
			const allSkillsBlocked = data.allSkillsBlocked ?? false;
			const blockedNames = skillList.filter((s) => s.blocked).map((s) => s.name);
			if (skillList.length > 0 || allSkillsBlocked) {
				items.push(
					{
						name: "unload all_skills",
						prompt: "",
						description: localize("Block all skills for this session", "屏蔽当前会话的所有技能"),
						source: "builtin",
						type: "tool" as const,
					},
					{
						name: "load all_skills",
						prompt: "",
						description: localize("Unblock all skills", "解除所有技能屏蔽"),
						source: "builtin",
						type: "tool" as const,
					},
				);
				// Per-skill block sub-items (only for currently visible/unblocked skills).
				for (const s of skillList) {
					if (s.blocked) continue;
					items.push({
						name: `unload skill ${s.name}`,
						prompt: "",
						description: localize(`Block skill: ${s.name}`, `屏蔽技能：${s.name}`),
						source: "builtin",
						type: "tool" as const,
					});
				}
				// Per-skill unblock sub-items for currently blocked skills.
				for (const name of blockedNames) {
					items.push({
						name: `load skill ${name}`,
						prompt: "",
						description: localize(`Unblock skill: ${name}`, `解除屏蔽技能：${name}`),
						source: "builtin",
						type: "tool" as const,
					});
				}
			}

			// Add "/load" and "/unload" entries when optional tools are available
			if (toolItems.length > 0) {
				const typedToolItems = toolItems as Array<{
					id: string;
					toolName: string;
					descriptionEn: string;
					descriptionZh: string;
				}>;
				const toolNames = typedToolItems.map((t) => t.id).join(", ");
				items.push(
					{
						name: "load",
						prompt: "",
						description: localize(
							`Load an optional tool into the session (${toolNames})`,
							`加载可选工具到当前会话 (${toolNames})`,
						),
						source: "builtin",
						type: "tool" as const,
					},
					{
						name: "unload",
						prompt: "",
						description: localize(
							`Unload an optional tool from the session (${toolNames})`,
							`从当前会话卸载可选工具 (${toolNames})`,
						),
						source: "builtin",
						type: "tool" as const,
					},
				);
				// Add sub-items for each tool: "load <id>" and "unload <id>"
				for (const t of typedToolItems) {
					items.push(
						{
							name: `load ${t.id}`,
							prompt: "",
							description: localize(t.descriptionEn, t.descriptionZh),
							source: "builtin",
							type: "tool" as const,
						},
						{
							name: `unload ${t.id}`,
							prompt: "",
							description: localize(t.descriptionEn, t.descriptionZh),
							source: "builtin",
							type: "tool" as const,
						},
					);
				}
			}

			return items;
		},
	});
}

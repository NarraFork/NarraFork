import { Badge, Group, Paper, ScrollArea, Stack, Text } from "@mantine/core";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Z } from "../../lib/z-index";
import type { CommandItem, CommandParam } from "./CommandPopover";

interface CommandParamHelperProps {
	command: CommandItem;
	input: string;
	visible: boolean;
}

const MAX_COMMAND_ARG_PARSE_CHARS = 50_000;
const MAX_COMMAND_PREVIEW_CHARS = 20_000;
const MAX_COMMAND_PARAM_BADGES = 24;

function capCommandPreview(text: string): string {
	if (text.length <= MAX_COMMAND_PREVIEW_CHARS) return text;
	return `${text.slice(0, MAX_COMMAND_PREVIEW_CHARS)}\n…`;
}

/** Parse positional args from user input based on command param definitions. */
function parseArgs(
	input: string,
	params: CommandParam[],
): { args: Record<string, string>; currentIndex: number } {
	const spaceIdx = input.indexOf(" ");
	const rawArgsStr = spaceIdx >= 0 ? input.slice(spaceIdx + 1) : "";
	const argsStr =
		rawArgsStr.length > MAX_COMMAND_ARG_PARSE_CHARS
			? rawArgsStr.slice(0, MAX_COMMAND_ARG_PARSE_CHARS)
			: rawArgsStr;

	if (!params.length) {
		// Legacy {{input}} mode
		return { args: { input: argsStr }, currentIndex: 0 };
	}

	const tokens = argsStr.split(/\s+/).filter(Boolean);
	const args: Record<string, string> = {};

	for (let i = 0; i < params.length; i++) {
		if (i === params.length - 1) {
			args[params[i].name] = tokens.slice(i).join(" ") || (params[i].defaultValue ?? "");
		} else {
			args[params[i].name] = tokens[i] ?? params[i].defaultValue ?? "";
		}
	}

	// Current param = first unfilled or the last one if all have values
	const currentIndex = Math.min(tokens.length > 0 ? tokens.length - 1 : 0, params.length - 1);

	return { args, currentIndex };
}

/** Build preview text by substituting params into the prompt template. */
function buildPreview(
	prompt: string,
	params: CommandParam[] | undefined,
	args: Record<string, string>,
): string {
	let result = prompt;
	if (params?.length) {
		for (const p of params) {
			const val = args[p.name];
			result = result.replaceAll(`{{${p.name}}}`, val || `[${p.name}]`);
		}
	} else if (result.includes("{{input}}")) {
		result = result.replaceAll("{{input}}", args.input || "[input]");
	}
	return capCommandPreview(result);
}

export function CommandParamHelper({ command, input, visible }: CommandParamHelperProps) {
	const { t } = useTranslation("narrator");

	const params = command.params ?? [];
	const hasParams = params.length > 0;
	const hasBashFirst = !!(command.runBashFirst && command.bashCommand);
	const hasInputPlaceholder =
		!hasParams &&
		(command.prompt.includes("{{input}}") || command.bashCommand?.includes("{{input}}"));

	// For commands with no params, no {{input}}, and no Bash pre-step, show nothing
	const shouldShow = visible && (hasParams || hasInputPlaceholder || hasBashFirst);

	const { args, currentIndex } = useMemo(
		() => parseArgs(input, hasParams ? params : hasInputPlaceholder ? [{ name: "input" }] : []),
		[input, hasParams, hasInputPlaceholder, params],
	);

	const preview = useMemo(
		() => buildPreview(command.prompt, hasParams ? params : undefined, args),
		[command.prompt, hasParams, params, args],
	);
	const bashPreview = useMemo(
		() =>
			command.bashCommand
				? buildPreview(command.bashCommand, hasParams ? params : undefined, args)
				: undefined,
		[command.bashCommand, hasParams, params, args],
	);

	if (!shouldShow) return null;

	const displayParams = (
		hasParams
			? params
			: hasInputPlaceholder
				? [{ name: "input", description: undefined } as CommandParam]
				: []
	).slice(0, MAX_COMMAND_PARAM_BADGES);
	const hiddenParamCount = Math.max(
		0,
		(hasParams ? params.length : displayParams.length) - displayParams.length,
	);

	return (
		<Paper
			shadow="sm"
			radius="sm"
			withBorder
			style={{
				position: "absolute",
				bottom: "100%",
				left: 0,
				right: 0,
				marginBottom: 4,
				zIndex: Z.dropdown,
			}}
		>
			<Stack gap={0}>
				{hasBashFirst && bashPreview && (
					<ScrollArea.Autosize mah={80} p="xs">
						<Group gap={6} mb={4}>
							<Badge size="xs" variant="light" color="yellow">
								{t("commandRunBashFirstBadge")}
							</Badge>
							<Text size="xs" c="dimmed" fw={600}>
								{t("commandBashPreview")}
							</Text>
						</Group>
						<Text
							size="xs"
							style={{ whiteSpace: "pre-wrap", fontFamily: "monospace", lineHeight: 1.5 }}
						>
							{bashPreview}
						</Text>
					</ScrollArea.Autosize>
				)}

				{/* Prompt preview */}
				<ScrollArea.Autosize
					mah={120}
					p="xs"
					style={hasBashFirst ? { borderTop: "1px solid var(--mantine-color-dark-4)" } : undefined}
				>
					<Text size="xs" c="dimmed" fw={600} mb={4}>
						{t("commandPreview")}
					</Text>
					<Text
						size="xs"
						style={{ whiteSpace: "pre-wrap", fontFamily: "monospace", lineHeight: 1.5 }}
					>
						{preview}
					</Text>
				</ScrollArea.Autosize>

				{/* Param badges */}
				{displayParams.length > 0 && (
					<Group
						gap={6}
						p="xs"
						style={{
							borderTop: "1px solid var(--mantine-color-dark-4)",
						}}
					>
						{displayParams.map((p, i) => {
							const filled = !!args[p.name];
							const isCurrent = i === currentIndex;
							return (
								<Badge
									key={p.name}
									size="sm"
									variant={isCurrent ? "filled" : filled ? "light" : "outline"}
									color={isCurrent ? "indigo" : filled ? "teal" : "gray"}
									title={p.description}
								>
									{p.name}
									{p.description ? `: ${p.description}` : ""}
								</Badge>
							);
						})}
						{hiddenParamCount > 0 && (
							<Badge size="sm" variant="outline" color="gray">
								+{hiddenParamCount}
							</Badge>
						)}
					</Group>
				)}
			</Stack>
		</Paper>
	);
}

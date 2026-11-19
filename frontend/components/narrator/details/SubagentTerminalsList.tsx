import { Anchor, Badge, Group, Stack, Text } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { TreeTerminal } from "../../../lib/api/terminals";

/**
 * The running terminals of the subagents below this session, read-only: which subagent runs
 * which terminal. Opening one (its subagent's session, where the terminal panel lives) is
 * offered only to people with write access, the same authority the server checks before it
 * lets anyone watch or type into a subagent's terminal.
 */
export function SubagentTerminalsList({
	terminals,
	truncated,
	canOpen,
	onOpenSession,
}: {
	terminals: readonly TreeTerminal[];
	truncated: boolean;
	canOpen: boolean;
	onOpenSession: (narratorId: string) => void;
}) {
	const { t } = useTranslation("narrator");
	if (terminals.length === 0) {
		return (
			<Text size="sm" c="dimmed">
				{t("details.none")}
			</Text>
		);
	}
	return (
		<Stack gap={6} align="flex-end" data-testid="subagent-terminals">
			{terminals.map((terminal) => {
				const owner = terminal.narratorTitle || terminal.subagentType || terminal.narratorId;
				return (
					<Group
						key={terminal.id}
						gap={6}
						justify="flex-end"
						wrap="nowrap"
						maw="100%"
						data-testid="subagent-terminal-row"
					>
						<Badge
							variant="outline"
							tt="none"
							maw={110}
							style={{ flexShrink: 0 }}
							title={terminal.name}
						>
							{terminal.name}
						</Badge>
						{canOpen ? (
							<Anchor
								component="button"
								type="button"
								size="sm"
								truncate
								maw={220}
								miw={0}
								title={terminal.cwd ?? undefined}
								aria-label={t("details.subagentTerminalsOpen", { name: owner })}
								onClick={() => onOpenSession(terminal.narratorId)}
							>
								{owner}
							</Anchor>
						) : (
							<Text size="sm" truncate maw={220} miw={0} title={terminal.cwd ?? undefined}>
								{owner}
							</Text>
						)}
					</Group>
				);
			})}
			{truncated ? (
				<Text size="xs" c="dimmed">
					{t("details.subagentTerminalsTruncated", { count: terminals.length })}
				</Text>
			) : null}
			{canOpen ? null : (
				<Text size="xs" c="dimmed" ta="right" maw={360}>
					{t("details.subagentTerminalsOpenHint")}
				</Text>
			)}
		</Stack>
	);
}

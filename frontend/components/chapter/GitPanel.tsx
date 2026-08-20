import { ActionIcon, Group, Tabs, Text, Tooltip } from "@mantine/core";
import { IconCheck, IconCopy, IconGitBranch } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { useClipboard } from "../../hooks/useClipboard";
import { useGitStatus } from "../../hooks/useGit";
import { GitChangesTab } from "./GitChangesTab";
import { GitCommitsTab } from "./GitCommitsTab";
import { GitStashTab } from "./GitStashTab";

/**
 * Only the ACTIVE panel is mounted (`keepMounted={false}`), so it can safely take
 * all the remaining height. `minHeight: 0` is what lets the inner scroll area
 * shrink instead of pushing the flex parent taller.
 */
const TAB_PANEL_STYLE = {
	flex: 1,
	minHeight: 0,
	display: "flex",
	flexDirection: "column",
} as const;

/**
 * Branch identity + one-click copy.
 *
 * Lives here rather than in each host (dock tab, mobile drawer, detached window)
 * because "which branch am I staging into" is a question every host of this panel
 * raises. Reads `useGitStatus`, which the Changes tab already fetches under the
 * same query key — the header is free rather than a second request, and it names
 * the branch git actually reports for the worktree rather than the chapter record.
 *
 * The name is `user-select: text` and carries a `title`: the copy button is the
 * fast path, not the only one, and a truncated long branch name must still be
 * readable and selectable.
 */
function GitBranchHeader({ chapterId }: { chapterId: string }) {
	const { t } = useTranslation("git");
	const { data: gitStatus } = useGitStatus(chapterId);
	const clipboard = useClipboard({ timeout: 1500 });

	const branch = gitStatus?.branch;
	if (!branch) return null;

	return (
		<Group
			gap={6}
			wrap="nowrap"
			px="xs"
			py={4}
			style={{
				flexShrink: 0,
				borderBottom: "1px solid var(--mantine-color-default-border)",
			}}
		>
			{/* Branch group: icon, name and copy button stay adjacent so the button
			    reads as belonging to the branch. Putting it after the HEAD sha (as an
			    earlier revision did) made it look like it copied the commit id. */}
			<Group gap={4} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
				<IconGitBranch size={14} color="var(--mantine-color-dimmed)" style={{ flexShrink: 0 }} />
				<Text
					size="xs"
					ff="monospace"
					truncate
					title={branch}
					style={{ minWidth: 0, userSelect: "text" }}
				>
					{branch}
				</Text>
				<Tooltip label={clipboard.copied ? t("panel.branchCopied") : t("panel.copyBranch")}>
					<ActionIcon
						variant="subtle"
						color={clipboard.copied ? "green" : "gray"}
						size="sm"
						style={{ flexShrink: 0 }}
						aria-label={t("panel.copyBranch")}
						onClick={() => clipboard.copy(branch)}
					>
						{clipboard.copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
					</ActionIcon>
				</Tooltip>
			</Group>
			{gitStatus.headSha && (
				<Text
					size="xs"
					c="dimmed"
					ff="monospace"
					title={gitStatus.headSha}
					style={{ flexShrink: 0, userSelect: "text" }}
				>
					{gitStatus.headSha.slice(0, 7)}
				</Text>
			)}
		</Group>
	);
}

export function GitPanel({ chapterId }: { chapterId: string }) {
	const { t } = useTranslation("git");

	return (
		<div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
			<GitBranchHeader chapterId={chapterId} />
			<Tabs
				defaultValue="changes"
				variant="outline"
				keepMounted={false}
				// The panel host gives this component the full dock height, so the tab body
				// must claim what is left after the tab strip. Without this the tabs collapse
				// to their content height and each tab has to guess a pixel cap of its own.
				style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
			>
				<Tabs.List style={{ flexShrink: 0 }}>
					<Tabs.Tab value="changes">{t("panel.changes")}</Tabs.Tab>
					<Tabs.Tab value="commits">{t("panel.commits")}</Tabs.Tab>
					<Tabs.Tab value="stash">{t("panel.stash")}</Tabs.Tab>
				</Tabs.List>

				<Tabs.Panel value="changes" pt="xs" style={TAB_PANEL_STYLE}>
					<GitChangesTab chapterId={chapterId} />
				</Tabs.Panel>
				<Tabs.Panel value="commits" pt="xs" style={TAB_PANEL_STYLE}>
					<GitCommitsTab chapterId={chapterId} />
				</Tabs.Panel>
				<Tabs.Panel value="stash" pt="xs" style={TAB_PANEL_STYLE}>
					<GitStashTab chapterId={chapterId} />
				</Tabs.Panel>
			</Tabs>
		</div>
	);
}

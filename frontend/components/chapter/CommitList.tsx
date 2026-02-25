import { Badge, Group, Stack, Text, Tooltip } from "@mantine/core";
import { IconGitCommit, IconRobot } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";

interface Commit {
	id: string;
	sha: string;
	message: string;
	authorName: string | null;
	authoredAt: string;
	source: "manual" | "auto" | "merge" | "cherry_pick" | "initial";
	narratorId: string | null;
	filesChanged: number | null;
	linesAdded: number | null;
	linesRemoved: number | null;
}

interface CommitListProps {
	commits: Commit[];
	maxItems?: number;
}

const SOURCE_COLORS: Record<string, string> = {
	auto: "indigo",
	manual: "gray",
	merge: "green",
	cherry_pick: "grape",
	initial: "blue",
};

function formatRelativeTime(dateStr: string): string {
	const ts = new Date(dateStr).getTime();
	if (Number.isNaN(ts)) return "";
	const diff = Date.now() - ts;
	if (diff < 0) return "<1m";
	const mins = Math.floor(diff / 60000);
	if (mins < 1) return "<1m";
	if (mins < 60) return `${mins}m`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	return `${days}d`;
}

export function CommitList({ commits, maxItems }: CommitListProps) {
	const { t } = useTranslation("graph");
	const displayed = maxItems ? commits.slice(0, maxItems) : commits;

	if (displayed.length === 0) {
		return (
			<Text size="xs" c="dimmed">
				{t("sidePanel.noCommits")}
			</Text>
		);
	}

	return (
		<Stack gap={4}>
			{displayed.map((commit) => (
				<Group key={commit.id} gap={6} wrap="nowrap" align="flex-start">
					<Text size="xs" c="dimmed" ff="monospace" style={{ flexShrink: 0 }}>
						{commit.sha.slice(0, 7)}
					</Text>

					{commit.source !== "manual" && (
						<Tooltip label={commit.source}>
							<Badge
								size="xs"
								variant="dot"
								color={SOURCE_COLORS[commit.source] ?? "gray"}
								style={{ flexShrink: 0 }}
							>
								{commit.source === "auto" ? <IconRobot size={10} /> : <IconGitCommit size={10} />}
							</Badge>
						</Tooltip>
					)}

					<Text size="xs" lineClamp={1} style={{ flex: 1, minWidth: 0 }}>
						{commit.message}
					</Text>

					{commit.linesAdded != null &&
						commit.linesRemoved != null &&
						(commit.linesAdded > 0 || commit.linesRemoved > 0) && (
							<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
								<Text span c="green" size="xs">
									+{commit.linesAdded}
								</Text>{" "}
								<Text span c="red" size="xs">
									-{commit.linesRemoved}
								</Text>
							</Text>
						)}

					<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
						{formatRelativeTime(commit.authoredAt)}
					</Text>
				</Group>
			))}
		</Stack>
	);
}

import { Badge, Group, Stack, Text, Tooltip, UnstyledButton } from "@mantine/core";
import { IconGitCommit, IconRobot } from "@tabler/icons-react";
import { useTranslation } from "react-i18next";
import { formatRelativeTime } from "../../lib/format";

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
	onCommitClick?: (sha: string) => void;
}

const SOURCE_COLORS: Record<string, string> = {
	auto: "indigo",
	manual: "gray",
	merge: "green",
	cherry_pick: "grape",
	initial: "blue",
};
const MAX_COMMIT_LIST_MESSAGE_CHARS = 1_000;

function clampCommitListText(value: string): string {
	return value.length > MAX_COMMIT_LIST_MESSAGE_CHARS
		? `${value.slice(0, MAX_COMMIT_LIST_MESSAGE_CHARS)}…`
		: value;
}

function CommitRow({ commit }: { commit: Commit }) {
	return (
		<Group gap={6} wrap="nowrap" align="flex-start">
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
				{clampCommitListText(commit.message)}
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
	);
}

export function CommitList({ commits, maxItems, onCommitClick }: CommitListProps) {
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
		<Stack gap={2}>
			{displayed.map((commit) =>
				onCommitClick ? (
					<UnstyledButton
						key={commit.id}
						onClick={() => onCommitClick(commit.sha)}
						py={2}
						px={4}
						style={{ borderRadius: 4 }}
					>
						<CommitRow commit={commit} />
					</UnstyledButton>
				) : (
					<CommitRow key={commit.id} commit={commit} />
				),
			)}
		</Stack>
	);
}

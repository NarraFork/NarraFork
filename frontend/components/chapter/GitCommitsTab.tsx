import {
	Button,
	Group,
	Loader,
	Menu,
	ScrollArea,
	Stack,
	Text,
	UnstyledButton,
} from "@mantine/core";
import { IconDots } from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useGitLog, useGitReset } from "../../hooks/useGit";

const LIMIT = 50;

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

export function GitCommitsTab({ chapterId }: { chapterId: string }) {
	const { t } = useTranslation("git");
	const [skip, setSkip] = useState(0);
	const { data: commits, isLoading } = useGitLog(chapterId, LIMIT, skip);
	const reset = useGitReset(chapterId);

	function handleReset(sha: string, mode: "soft" | "hard") {
		if (mode === "hard" && !window.confirm(t("resetConfirm"))) return;
		reset.mutate({ target: sha, mode });
	}

	if (isLoading) {
		return <Loader size="sm" />;
	}

	if (!commits || commits.length === 0) {
		return (
			<Text size="sm" c="dimmed" py="md" ta="center">
				{t("commitEmpty")}
			</Text>
		);
	}

	return (
		<ScrollArea.Autosize mah={300}>
			<Stack gap={2}>
				{commits.map((c) => (
					<Group key={c.sha} gap={6} wrap="nowrap" py={2} px={4}>
						<Text size="xs" c="dimmed" ff="monospace" style={{ flexShrink: 0 }}>
							{c.shortSha}
						</Text>
						<Text size="xs" lineClamp={1} style={{ flex: 1, minWidth: 0 }}>
							{c.message}
						</Text>
						<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
							{c.author}
						</Text>
						<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
							{formatRelativeTime(c.date)}
						</Text>
						<Menu position="bottom-end" withinPortal>
							<Menu.Target>
								<UnstyledButton onClick={(e) => e.stopPropagation()} style={{ lineHeight: 1 }}>
									<IconDots size={14} />
								</UnstyledButton>
							</Menu.Target>
							<Menu.Dropdown>
								<Menu.Item onClick={() => handleReset(c.sha, "soft")}>{t("resetSoft")}</Menu.Item>
								<Menu.Item color="red" onClick={() => handleReset(c.sha, "hard")}>
									{t("resetHard")}
								</Menu.Item>
							</Menu.Dropdown>
						</Menu>
					</Group>
				))}

				{commits.length === LIMIT && (
					<Button
						size="compact-xs"
						variant="subtle"
						fullWidth
						onClick={() => setSkip((s) => s + LIMIT)}
					>
						{t("loadMore")}
					</Button>
				)}
			</Stack>
		</ScrollArea.Autosize>
	);
}

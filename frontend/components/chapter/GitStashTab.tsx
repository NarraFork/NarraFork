import { Box, Button, Group, Loader, ScrollArea, Stack, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useGitStash, useGitStashList } from "../../hooks/useGit";
import { type GitTarget, gitCanWrite } from "../../lib/api/git";
import { useConfirmDialog } from "../common/confirm-dialog-context";

const MAX_GIT_STASH_TEXT_CHARS = 1_000;

function clampGitStashText(value: string | null | undefined): string {
	if (!value) return "";
	return value.length > MAX_GIT_STASH_TEXT_CHARS
		? `${value.slice(0, MAX_GIT_STASH_TEXT_CHARS)}…`
		: value;
}

export function GitStashTab({
	chapterId,
	target = chapterId ?? "",
}: {
	chapterId?: string;
	target?: GitTarget;
}) {
	const canWrite = gitCanWrite(target);
	const confirm = useConfirmDialog();
	const { t } = useTranslation("git");
	const { data: stashes, isLoading, error } = useGitStashList(target);
	const stash = useGitStash(target);
	const [stashMsg, setStashMsg] = useState("");

	function handlePush() {
		if (!canWrite) return;
		stash.mutate(
			{ action: "push", message: stashMsg.trim() || undefined },
			{ onSuccess: () => setStashMsg("") },
		);
	}

	if (isLoading) {
		return <Loader size="sm" />;
	}

	return (
		<Box style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
			{(error || stash.error) && (
				<Text c="red" size="xs">
					{(error || stash.error)?.message}
				</Text>
			)}
			{stash.error && (
				<Text c="dimmed" size="xs">
					{t("workspace.writeFailureHint")}
				</Text>
			)}
			{stash.data?.hasConflicts && (
				<Text c="yellow" size="sm">
					{t("stashConflicts")}
				</Text>
			)}
			{/* The push box stays put; only the stash list scrolls. */}
			<Group gap="xs" wrap="nowrap" pb="xs" style={{ flexShrink: 0 }}>
				<TextInput
					placeholder={t("stashMessage")}
					value={stashMsg}
					onChange={(e) => setStashMsg(e.currentTarget.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") handlePush();
					}}
					size="xs"
					style={{ flex: 1 }}
				/>
				<Button
					size="compact-xs"
					onClick={handlePush}
					disabled={!canWrite}
					loading={stash.isPending}
				>
					{t("stashPush")}
				</Button>
			</Group>

			<ScrollArea style={{ flex: 1, minHeight: 0 }}>
				<Stack gap="xs">
					{!error && (!stashes || stashes.length === 0) && (
						<Text size="sm" c="dimmed" py="md" ta="center">
							{t("stashEmpty")}
						</Text>
					)}

					{stashes?.map((s) => (
						<Group key={s.index} gap="xs" wrap="nowrap" py={2} px={4}>
							<Text size="xs" c="dimmed" ff="monospace" style={{ flexShrink: 0 }}>
								stash@{"{"}
								{s.index}
								{"}"}
							</Text>
							<Text size="xs" lineClamp={1} style={{ flex: 1, minWidth: 0 }}>
								{clampGitStashText(s.message)}
							</Text>
							<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
								{clampGitStashText(s.date)}
							</Text>
							<Group gap={4} style={{ flexShrink: 0 }}>
								<Button
									size="compact-xs"
									variant="subtle"
									onClick={() => stash.mutate({ action: "pop", index: s.index })}
									disabled={!canWrite}
									loading={stash.isPending}
								>
									{t("stashPop")}
								</Button>
								<Button
									size="compact-xs"
									variant="subtle"
									color="red"
									onClick={async () => {
										if (await confirm({ message: t("stashDropConfirm", { index: s.index }) }))
											stash.mutate({ action: "drop", index: s.index });
									}}
									disabled={!canWrite}
									loading={stash.isPending}
								>
									{t("stashDrop")}
								</Button>
							</Group>
						</Group>
					))}
				</Stack>
			</ScrollArea>
		</Box>
	);
}

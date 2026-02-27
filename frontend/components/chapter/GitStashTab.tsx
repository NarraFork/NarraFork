import { Button, Group, Loader, ScrollArea, Stack, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useGitStash, useGitStashList } from "../../hooks/useGit";

export function GitStashTab({ chapterId }: { chapterId: string }) {
	const { t } = useTranslation("git");
	const { data: stashes, isLoading } = useGitStashList(chapterId);
	const stash = useGitStash(chapterId);
	const [stashMsg, setStashMsg] = useState("");

	function handlePush() {
		stash.mutate(
			{ action: "push", message: stashMsg.trim() || undefined },
			{ onSuccess: () => setStashMsg("") },
		);
	}

	if (isLoading) {
		return <Loader size="sm" />;
	}

	return (
		<ScrollArea.Autosize mah={300}>
			<Stack gap="xs">
				<Group gap="xs" wrap="nowrap">
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
					<Button size="compact-xs" onClick={handlePush} loading={stash.isPending}>
						{t("stashPush")}
					</Button>
				</Group>

				{(!stashes || stashes.length === 0) && (
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
							{s.message}
						</Text>
						<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
							{s.date}
						</Text>
						<Group gap={4} style={{ flexShrink: 0 }}>
							<Button
								size="compact-xs"
								variant="subtle"
								onClick={() => stash.mutate({ action: "pop", index: s.index })}
								loading={stash.isPending}
							>
								{t("stashPop")}
							</Button>
							<Button
								size="compact-xs"
								variant="subtle"
								color="red"
								onClick={() => stash.mutate({ action: "drop", index: s.index })}
								loading={stash.isPending}
							>
								{t("stashDrop")}
							</Button>
						</Group>
					</Group>
				))}
			</Stack>
		</ScrollArea.Autosize>
	);
}

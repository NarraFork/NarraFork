import { api } from "@frontend/lib/api";
import { statusRegistry } from "@frontend/lib/status-registry";
import {
	Badge,
	Box,
	Code,
	Collapse,
	Divider,
	Group,
	Loader,
	Modal,
	ScrollArea,
	Stack,
	Text,
	UnstyledButton,
} from "@mantine/core";
import {
	IconChevronDown,
	IconChevronRight,
	IconFile,
	IconFileMinus,
	IconFilePlus,
	IconFileSymlink,
	IconPencil,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

interface CommitDetailModalProps {
	chapterId: string;
	commitSha: string | null;
	opened: boolean;
	onClose: () => void;
}

const STATUS_ICONS: Record<string, typeof IconFile> = {
	added: IconFilePlus,
	deleted: IconFileMinus,
	modified: IconPencil,
	renamed: IconFileSymlink,
};

function DiffBlock({ diff }: { diff: string }) {
	const lines = diff
		.split("\n")
		.filter(
			(l) =>
				!l.startsWith("diff --git") &&
				!l.startsWith("index ") &&
				!l.startsWith("old mode") &&
				!l.startsWith("new mode"),
		);

	if (lines.length === 0) return null;

	return (
		<Box
			style={{
				borderRadius: 4,
				border: "1px solid var(--mantine-color-dark-4)",
				overflow: "hidden",
				marginBottom: 8,
			}}
		>
			{lines.map((line, i) => {
				let bg: string | undefined;
				let color: string | undefined;
				if (line.startsWith("+") && !line.startsWith("+++")) {
					bg = "rgba(40, 167, 69, 0.12)";
					color = "var(--mantine-color-green-4)";
				} else if (line.startsWith("-") && !line.startsWith("---")) {
					bg = "rgba(220, 53, 69, 0.12)";
					color = "var(--mantine-color-red-4)";
				} else if (line.startsWith("@@")) {
					color = "var(--mantine-color-blue-4)";
				}
				return (
					<Box
						// biome-ignore lint/suspicious/noArrayIndexKey: diff lines have no stable key
						key={i}
						component="pre"
						style={{
							margin: 0,
							padding: "0 8px",
							backgroundColor: bg,
							color,
							fontSize: 12,
							fontFamily: "var(--mantine-font-family-monospace)",
							lineHeight: 1.6,
							whiteSpace: "pre-wrap",
							wordBreak: "break-all",
						}}
					>
						{line}
					</Box>
				);
			})}
		</Box>
	);
}

/** Single file row — uses inline diff if available, otherwise loads on demand. */
function FileDiffRow({
	chapterId,
	sha,
	file,
	inlineDiff,
}: {
	chapterId: string;
	sha: string;
	file: {
		path: string;
		oldPath?: string;
		status: string;
		linesAdded: number;
		linesRemoved: number;
	};
	/** Pre-loaded diff content (for small commits). */
	inlineDiff?: string;
}) {
	const hasInline = inlineDiff != null;
	const [expanded, setExpanded] = useState(hasInline);
	const StatusIcon = STATUS_ICONS[file.status] ?? IconFile;
	const statusColor = statusRegistry.gitFileStatus(file.status).color;

	// Only fetch diff when expanded AND no inline diff was provided
	const { data: diffData, isLoading } = useQuery({
		queryKey: ["commitFileDiff", chapterId, sha, file.path],
		queryFn: () => api.getCommitFileDiff(chapterId, sha, file.path),
		enabled: expanded && !hasInline,
		staleTime: 5 * 60_000,
	});

	const resolvedDiff = hasInline ? inlineDiff : diffData?.diff;
	const toggle = useCallback(() => setExpanded((v) => !v), []);

	return (
		<Box>
			<UnstyledButton onClick={toggle} w="100%" py={4} px={8}>
				<Group gap={8} wrap="nowrap">
					{expanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
					<StatusIcon size={14} color={`var(--mantine-color-${statusColor}-5)`} />
					<Text size="sm" ff="monospace" style={{ flex: 1, minWidth: 0 }} lineClamp={1}>
						{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
					</Text>
					<Group gap={4} style={{ flexShrink: 0 }}>
						{file.linesAdded > 0 && (
							<Text size="xs" c="green">
								+{file.linesAdded}
							</Text>
						)}
						{file.linesRemoved > 0 && (
							<Text size="xs" c="red">
								-{file.linesRemoved}
							</Text>
						)}
					</Group>
				</Group>
			</UnstyledButton>
			<Collapse in={expanded}>
				<Box px={8} pb={4}>
					{isLoading && <Loader size="xs" my={4} />}
					{resolvedDiff && <DiffBlock diff={resolvedDiff} />}
					{!hasInline && diffData?.truncated && (
						<Badge size="xs" color="orange" mb={4}>
							truncated
						</Badge>
					)}
					{expanded && !resolvedDiff && !isLoading && (
						<Text size="xs" c="dimmed">
							(binary or empty diff)
						</Text>
					)}
				</Box>
			</Collapse>
		</Box>
	);
}

export function CommitDetailModal({
	chapterId,
	commitSha,
	opened,
	onClose,
}: CommitDetailModalProps) {
	const { t } = useTranslation("chapters");

	const { data, isLoading } = useQuery({
		queryKey: ["commitDetail", chapterId, commitSha],
		queryFn: () => api.getChapterCommit(chapterId, commitSha ?? ""),
		enabled: opened && !!commitSha,
	});

	const totalAdded = data?.files.reduce((s, f) => s + f.linesAdded, 0) ?? 0;
	const totalRemoved = data?.files.reduce((s, f) => s + f.linesRemoved, 0) ?? 0;

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={
				<Group gap={8}>
					<Code>{commitSha?.slice(0, 10)}</Code>
					<Text size="sm" lineClamp={1}>
						{data?.message}
					</Text>
				</Group>
			}
			size="xl"
			styles={{
				body: { padding: 0 },
				header: { paddingBottom: 0 },
			}}
		>
			{isLoading && (
				<Group justify="center" py="xl">
					<Loader size="sm" />
				</Group>
			)}

			{data && (
				<Stack gap={0}>
					<Box px="md" py="sm">
						<Group gap="xs" mb={4}>
							<Text size="xs" c="dimmed">
								{data.authorName}
							</Text>
							<Text size="xs" c="dimmed">
								·
							</Text>
							<Text size="xs" c="dimmed">
								{new Date(data.authoredAt).toLocaleString()}
							</Text>
							<Badge size="xs" variant="light" color="gray">
								{data.source}
							</Badge>
						</Group>
						{data.fullMessage && data.fullMessage !== data.message && (
							<Text size="xs" c="dimmed" style={{ whiteSpace: "pre-wrap" }} mt={4}>
								{data.fullMessage}
							</Text>
						)}
						<Group gap="xs" mt={4}>
							<Text size="xs" c="dimmed">
								{data.files.length} file(s)
							</Text>
							{totalAdded > 0 && (
								<Text size="xs" c="green">
									+{totalAdded}
								</Text>
							)}
							{totalRemoved > 0 && (
								<Text size="xs" c="red">
									-{totalRemoved}
								</Text>
							)}
						</Group>
					</Box>

					<Divider />

					<ScrollArea.Autosize mah="65vh" px="sm" py="xs">
						<Stack gap={0}>
							{data.files.map((file) => (
								<FileDiffRow
									key={file.path}
									chapterId={chapterId}
									sha={data.sha}
									file={file}
									inlineDiff={data.diffInlined ? file.diff : undefined}
								/>
							))}
							{data.files.length === 0 && (
								<Text size="sm" c="dimmed" ta="center" py="xl">
									{t("commitDetail.noDiff", "No file changes in this commit.")}
								</Text>
							)}
						</Stack>
					</ScrollArea.Autosize>
				</Stack>
			)}
		</Modal>
	);
}

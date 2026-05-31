import { api } from "@frontend/lib/api";
import { statusRegistry } from "@frontend/lib/status-registry";
import {
	Badge,
	Box,
	Button,
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
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useChapterSplitCapability } from "../../hooks/usePlatform";
import { ChapterSplitModal } from "./ChapterSplitModal";

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

const MAX_DIFF_RENDER_LINES = 3_000;
const MAX_DIFF_RENDER_CHARS = 160_000;
const MAX_COMMIT_FILES_RENDERED = 1_000;
const MAX_COMMIT_FULL_MESSAGE_CHARS = 20_000;
const MAX_COMMIT_DETAIL_INLINE_TEXT_CHARS = 1_000;

function clampCommitDetailInlineText(value: string | undefined): string {
	if (!value) return "";
	return value.length > MAX_COMMIT_DETAIL_INLINE_TEXT_CHARS
		? `${value.slice(0, MAX_COMMIT_DETAIL_INLINE_TEXT_CHARS)}…`
		: value;
}

function formatCommitFilePath(file: { path: string; oldPath?: string }): string {
	const path = clampCommitDetailInlineText(file.path);
	if (!file.oldPath) return path;
	return `${clampCommitDetailInlineText(file.oldPath)} → ${path}`;
}

function isDiffMetadataLine(line: string): boolean {
	return (
		line.startsWith("diff --git") ||
		line.startsWith("index ") ||
		line.startsWith("old mode") ||
		line.startsWith("new mode")
	);
}

function buildDiffPreview(diff: string): { lines: string[]; truncated: boolean } {
	const lines: string[] = [];
	let renderedChars = 0;
	let truncated = false;
	let start = 0;

	while (start <= diff.length) {
		const newline = diff.indexOf("\n", start);
		const end = newline === -1 ? diff.length : newline;
		const line = diff.slice(start, end);
		start = newline === -1 ? diff.length + 1 : newline + 1;
		if (isDiffMetadataLine(line)) continue;
		if (
			lines.length >= MAX_DIFF_RENDER_LINES ||
			renderedChars + line.length > MAX_DIFF_RENDER_CHARS
		) {
			truncated = true;
			break;
		}
		lines.push(line);
		renderedChars += line.length + 1;
	}

	return { lines, truncated };
}

function DiffBlock({ diff }: { diff: string }) {
	const { t } = useTranslation("chapters");
	const { lines, truncated } = useMemo(() => buildDiffPreview(diff), [diff]);

	if (lines.length === 0) return null;

	return (
		<>
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
			{truncated && (
				<Badge size="xs" color="orange" mb={4}>
					{t("commitDetail.diffPreviewTruncated")}
				</Badge>
			)}
		</>
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
		gcTime: 30_000,
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
						{formatCommitFilePath(file)}
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
	const chapterSplitCapability = useChapterSplitCapability();
	const splitUnsupportedReason = chapterSplitCapability.supported
		? undefined
		: chapterSplitCapability.reason || t("splitUnsupported");
	const [splitOpened, setSplitOpened] = useState(false);

	const { data, isLoading } = useQuery({
		queryKey: ["commitDetail", chapterId, commitSha],
		queryFn: () => api.getChapterCommit(chapterId, commitSha ?? ""),
		enabled: opened && !!commitSha,
		gcTime: 30_000,
	});

	const totalAdded = data?.files.reduce((s, f) => s + f.linesAdded, 0) ?? 0;
	const totalRemoved = data?.files.reduce((s, f) => s + f.linesRemoved, 0) ?? 0;
	const displayedFiles = data?.files.slice(0, MAX_COMMIT_FILES_RENDERED) ?? [];
	const hiddenFiles = Math.max(0, (data?.files.length ?? 0) - displayedFiles.length);
	const displayedFullMessage =
		data?.fullMessage && data.fullMessage.length > MAX_COMMIT_FULL_MESSAGE_CHARS
			? data.fullMessage.slice(0, MAX_COMMIT_FULL_MESSAGE_CHARS)
			: data?.fullMessage;
	const fullMessageTruncated = !!data?.fullMessage && displayedFullMessage !== data.fullMessage;

	return (
		<>
			<Modal
				opened={opened}
				onClose={onClose}
				title={
					<Group gap={8}>
						<Code>{commitSha?.slice(0, 10)}</Code>
						<Text size="sm" lineClamp={1}>
							{clampCommitDetailInlineText(data?.message)}
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
								<Button
									size="compact-xs"
									variant="light"
									disabled={!chapterSplitCapability.supported || !commitSha}
									title={splitUnsupportedReason}
									onClick={() => {
										if (!chapterSplitCapability.supported || !commitSha) return;
										setSplitOpened(true);
									}}
								>
									{t("splitHere")}
								</Button>
							</Group>
							{displayedFullMessage && displayedFullMessage !== data.message && (
								<>
									<Text size="xs" c="dimmed" style={{ whiteSpace: "pre-wrap" }} mt={4}>
										{displayedFullMessage}
									</Text>
									{fullMessageTruncated && (
										<Text size="xs" c="orange" mt={2}>
											{t("commitDetail.messagePreviewTruncated")}
										</Text>
									)}
								</>
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
								{displayedFiles.map((file) => (
									<FileDiffRow
										key={file.path}
										chapterId={chapterId}
										sha={data.sha}
										file={file}
										inlineDiff={data.diffInlined ? file.diff : undefined}
									/>
								))}
								{hiddenFiles > 0 && (
									<Text size="xs" c="dimmed" ta="center" py="sm">
										{t("commitDetail.filesPreviewTruncated", { count: hiddenFiles })}
									</Text>
								)}
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
			<ChapterSplitModal
				chapterId={chapterId}
				commitSha={commitSha}
				commitMessage={data?.message}
				opened={splitOpened}
				onClose={() => setSplitOpened(false)}
			/>
		</>
	);
}

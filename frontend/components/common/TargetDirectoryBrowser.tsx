import {
	ActionIcon,
	Alert,
	Button,
	Group,
	Loader,
	ScrollArea,
	Stack,
	Text,
	TextInput,
	UnstyledButton,
} from "@mantine/core";
import { IconArrowUp, IconFolder, IconRefresh } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteDirectoryListing } from "../../lib/api/devices";
import { DIRECTORY_BROWSER_ROOT_STYLE } from "./directory-browser-modal";

/** Presentation only: the supplied lister owns target authorization semantics. */
export function TargetDirectoryBrowser({
	initialPath,
	deviceLabel,
	listDirectory,
	queryKey,
	mode = "existing",
	checkNewTarget,
	onSelect,
	onCancel,
}: {
	initialPath?: string;
	deviceLabel: string;
	listDirectory: (path: string | undefined, signal: AbortSignal) => Promise<RemoteDirectoryListing>;
	queryKey: readonly unknown[];
	mode?: "existing" | "newTarget";
	/** Existence is checked on the target, never on the NarraFork host. */
	checkNewTarget?: (path: string) => Promise<boolean>;
	onSelect: (path: string) => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation("common");
	const [path, setPath] = useState(initialPath);
	const [input, setInput] = useState(initialPath ?? "");
	const [leaf, setLeaf] = useState("");
	const query = useQuery({
		queryKey: [...queryKey, "targetBrowser", path],
		queryFn: ({ signal }) => listDirectory(path, signal),
		retry: false,
		gcTime: 30_000,
	});
	const navigate = (next: string) => {
		setPath(next);
		setInput(next);
	};
	const data = query.isError ? undefined : query.data;
	const name = leaf.trim();
	const windows = data?.sep === "\\";
	const [selecting, setSelecting] = useState(false);
	const [selectionError, setSelectionError] = useState<string>();
	const validLeaf =
		!!name &&
		name !== "." &&
		name !== ".." &&
		!/[/\\\0]/.test(name) &&
		Array.from(name).every((character) => character.charCodeAt(0) >= 32) &&
		(!windows ||
			(!/[<>:"|?*]|[. ]$/.test(name) &&
				!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))) &&
		!data?.entries.some((entry) =>
			windows ? entry.name.toLowerCase() === name.toLowerCase() : entry.name === name,
		);
	const selected =
		mode === "newTarget"
			? data?.path && validLeaf
				? `${data.path.replace(/[/\\]$/, "")}${data.sep}${leaf.trim()}`
				: undefined
			: data?.path;
	const selectedRef = useRef(selected);
	selectedRef.current = selected;
	const select = async () => {
		if (!selected) return;
		const frozen = selected;
		setSelecting(true);
		setSelectionError(undefined);
		try {
			if (mode === "newTarget" && checkNewTarget && !(await checkNewTarget(frozen))) {
				if (selectedRef.current === frozen) setSelectionError(t("directoryTargetExists"));
				return;
			}
			if (selectedRef.current === frozen) onSelect(frozen);
		} catch (error) {
			if (selectedRef.current === frozen)
				setSelectionError(error instanceof Error ? error.message : String(error));
		} finally {
			setSelecting(false);
		}
	};
	return (
		<Stack gap="xs" p="md" style={DIRECTORY_BROWSER_ROOT_STYLE}>
			<Text size="xs" c="dimmed">
				{deviceLabel}
			</Text>
			<Group gap="xs" wrap="nowrap">
				<ActionIcon
					variant="default"
					disabled={!data?.parent}
					aria-label={t("goUp")}
					onClick={() => data?.parent && navigate(data.parent)}
				>
					<IconArrowUp size={15} />
				</ActionIcon>
				<TextInput
					style={{ flex: 1 }}
					value={input}
					onChange={(event) => setInput(event.currentTarget.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") navigate(input);
					}}
					aria-label={t("directoryPath")}
				/>
				<ActionIcon
					variant="subtle"
					aria-label={t("refresh")}
					onClick={() => {
						if (input !== path) navigate(input);
						else void query.refetch();
					}}
				>
					<IconRefresh size={15} />
				</ActionIcon>
			</Group>
			{query.error && <Alert color="red">{query.error.message}</Alert>}
			{selectionError && <Alert color="red">{selectionError}</Alert>}
			<ScrollArea style={{ flex: 1, minHeight: 0 }}>
				{query.isLoading ? (
					<Loader size="sm" />
				) : (
					<Stack gap={2}>
						{data?.entries
							.filter((entry) => entry.isDirectory)
							.map((entry) => (
								<UnstyledButton key={entry.path} onClick={() => navigate(entry.path)} p={6}>
									<Group gap="xs">
										<IconFolder size={15} />
										<Text size="xs">{entry.name}</Text>
									</Group>
								</UnstyledButton>
							))}
					</Stack>
				)}
				{data?.truncated && (
					<Text size="xs" c="orange">
						{t("directoryListingTruncated")}
					</Text>
				)}
			</ScrollArea>
			{mode === "newTarget" && (
				<TextInput
					label={t("newDirectoryName")}
					aria-label={t("newDirectoryName")}
					value={leaf}
					onChange={(event) => setLeaf(event.currentTarget.value)}
				/>
			)}
			<Group justify="flex-end">
				<Button size="xs" variant="default" onClick={onCancel}>
					{t("cancel")}
				</Button>
				<Button
					size="xs"
					disabled={!selected || !!query.error || query.isFetching || selecting}
					loading={selecting}
					onClick={() => void select()}
				>
					{t("selectThisDirectory")}
				</Button>
			</Group>
		</Stack>
	);
}

import { Button, Center, Group, Loader, NumberInput, Stack, Text } from "@mantine/core";
import {
	FILE_PANEL_PAGE_BYTES,
	type FilePanelPage,
	MAX_FILE_PANEL_BYTES,
} from "@shared/file-reference";
import { type ReactNode, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type FilePanelReadOrigin, fileReferenceApi } from "../../../lib/api/file-references";

export const FILE_PANEL_AUTO_LOAD_BYTES = 1024 * 1024;

export function filePanelSizeLabel(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 ** 2) return `${(size / 1024).toFixed(2)} KiB`;
	if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(2)} MiB`;
	return `${(size / 1024 ** 3).toFixed(2)} GiB`;
}

export function filePanelLoadPolicy(size: number): "auto" | "confirm" | "blocked" {
	if (size > MAX_FILE_PANEL_BYTES) return "blocked";
	return size > FILE_PANEL_AUTO_LOAD_BYTES ? "confirm" : "auto";
}

interface Props {
	narratorId?: string;
	deviceId?: string;
	/** Scoped references never inherit the ordinary local editor's broader read boundary. */
	referenceOrigin?: boolean;
	/** Ordinary off-dock previews preserve /fs/preview policy, not the editor's write boundary. */
	legacyViewer?: boolean;
	filePath: string;
	confirmed?: boolean;
	onConfirm?: () => void;
	children: ReactNode;
	/** Off-dock drawer only: its owning narrator is its persistent pane identity. */
	persistenceKey?: string;
	enabled?: boolean;
}

/** Mounting the ordinary viewer is itself a content read, so defer it until stat completes. */
export function LargeFileGate(props: Props) {
	if (props.enabled === false) return props.children;
	return (
		<LargeFileResource
			key={JSON.stringify([props.narratorId, props.deviceId ?? "local", props.filePath])}
			{...props}
		/>
	);
}

function LargeFileResource({
	narratorId,
	deviceId = "local",
	referenceOrigin = false,
	legacyViewer = false,
	filePath,
	confirmed,
	onConfirm,
	children,
	persistenceKey,
}: Props) {
	const { t } = useTranslation("narrator");
	const [allowed, setAllowed] = useState(() => {
		if (confirmed === true) return true;
		try {
			return !!persistenceKey && localStorage.getItem(persistenceKey) === "true";
		} catch {
			return false;
		}
	});
	const origin: FilePanelReadOrigin =
		!referenceOrigin && deviceId === "local" ? (legacyViewer ? "preview" : "legacy") : "reference";
	const [info, setInfo] = useState<{ fileName: string; size: number } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [retry, setRetry] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly reissues the bounded request
	useEffect(() => {
		if (!narratorId) return;
		const controller = new AbortController();
		// Revalidating a legacy-to-reference upgrade must not dispose a loaded draft.
		// Resource identity changes already remount this component with empty metadata.
		setError(null);
		void fileReferenceApi
			.info(narratorId, { deviceId, path: filePath }, controller.signal, origin)
			.then((value) => {
				if (!controller.signal.aborted) setInfo(value);
			})
			.catch((reason: unknown) => {
				if (!controller.signal.aborted)
					setError(String(reason instanceof Error ? reason.message : reason));
			});
		return () => controller.abort();
	}, [narratorId, deviceId, filePath, origin, retry]);

	// Legacy unbound local previews retain their existing bounded reader.
	if (!narratorId) return children;
	if (error)
		return (
			<Center h="100%">
				<Stack align="center" p="md">
					<Text c="red" size="sm">
						{error}
					</Text>
					<Button onClick={() => setRetry((value) => value + 1)}>{t("largeFile.retry")}</Button>
				</Stack>
			</Center>
		);
	if (!info)
		return (
			<Center h="100%">
				<Loader size="sm" />
			</Center>
		);
	const policy = filePanelLoadPolicy(info.size);
	if (policy === "auto") return children;
	if (policy === "confirm" && (allowed || confirmed)) {
		return (
			<LargeFilePages
				narratorId={narratorId}
				deviceId={deviceId}
				filePath={filePath}
				info={info}
				origin={origin}
			/>
		);
	}
	return (
		<Center h="100%">
			<Stack align="center" p="xl" maw="100%">
				<Text fw={600} style={{ overflowWrap: "anywhere" }}>
					{info.fileName}
				</Text>
				<Text size="sm" c="dimmed">
					{t("largeFile.size", {
						size: filePanelSizeLabel(info.size),
						bytes: info.size.toLocaleString(),
					})}
				</Text>
				<Text size="sm" ta="center">
					{t(policy === "blocked" ? "largeFile.blocked" : "largeFile.deferred")}
				</Text>
				{policy !== "blocked" && (
					<Button
						onClick={() => {
							setAllowed(true);
							if (persistenceKey) {
								try {
									localStorage.setItem(persistenceKey, "true");
								} catch {
									/* Storage is optional; this mounted pane still remembers. */
								}
							}
							onConfirm?.();
						}}
					>
						{t("largeFile.viewAnyway")}
					</Button>
				)}
			</Stack>
		</Center>
	);
}

function LargeFilePages({
	narratorId,
	deviceId,
	filePath,
	info,
	origin,
}: {
	narratorId: string;
	deviceId: string;
	filePath: string;
	info: { fileName: string; size: number };
	origin: FilePanelReadOrigin;
}) {
	const { t } = useTranslation("narrator");
	const [offset, setOffset] = useState(0);
	const [previous, setPrevious] = useState<number[]>([]);
	const [jump, setJump] = useState<string | number>(1);
	const [page, setPage] = useState<FilePanelPage | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [retry, setRetry] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly reissues the bounded request
	useEffect(() => {
		const controller = new AbortController();
		setPage(null);
		setError(null);
		void fileReferenceApi
			.page(narratorId, { deviceId, path: filePath }, offset, controller.signal, origin)
			.then((value) => {
				if (!controller.signal.aborted) setPage(value);
			})
			.catch((reason: unknown) => {
				if (!controller.signal.aborted)
					setError(reason instanceof Error ? reason.message : String(reason));
			});
		return () => controller.abort();
	}, [narratorId, deviceId, filePath, offset, origin, retry]);
	const size = page?.size ?? info.size;
	const pageCount = Math.max(1, Math.ceil(size / FILE_PANEL_PAGE_BYTES));
	return (
		<Stack h="100%" gap={0} style={{ minHeight: 0 }}>
			<Stack p="sm" gap="xs" style={{ flexShrink: 0 }}>
				<Text size="sm" fw={600} style={{ overflowWrap: "anywhere" }}>
					{info.fileName} · {filePanelSizeLabel(size)}
				</Text>
				<Text size="xs" c="dimmed">
					{t("largeFile.pagedReadOnly")}
				</Text>
				<Group gap="xs">
					<Button
						size="compact-xs"
						disabled={!previous.length}
						onClick={() => {
							setOffset(previous[previous.length - 1] ?? 0);
							setPrevious((value) => value.slice(0, -1));
						}}
					>
						{t("largeFile.previous")}
					</Button>
					<Button
						size="compact-xs"
						disabled={!page || page.nextOffset === null}
						onClick={() => {
							if (page?.nextOffset != null) {
								setPrevious((value) => [...value, page.offset]);
								setOffset(page.nextOffset);
							}
						}}
					>
						{t("largeFile.next")}
					</Button>
					<Text size="xs">
						{t("largeFile.byteRange", {
							start: (page?.offset ?? offset).toLocaleString(),
							end: (page?.nextOffset ?? (page ? size : offset)).toLocaleString(),
						})}
					</Text>
					<NumberInput
						size="xs"
						w={100}
						min={1}
						max={pageCount}
						allowDecimal={false}
						value={jump}
						onChange={setJump}
						aria-label={t("largeFile.pageNumber")}
					/>
					<Button
						size="compact-xs"
						onClick={() => {
							const value = Number(jump);
							if (Number.isSafeInteger(value) && value >= 1 && value <= pageCount) {
								setPrevious([]);
								setOffset((value - 1) * FILE_PANEL_PAGE_BYTES);
							}
						}}
					>
						{t("largeFile.go")}
					</Button>
				</Group>
			</Stack>
			{error ? (
				<Stack p="md">
					<Text size="sm" c="red">
						{error}
					</Text>
					<Button onClick={() => setRetry((value) => value + 1)}>{t("largeFile.retry")}</Button>
				</Stack>
			) : !page ? (
				<Center style={{ flex: 1 }}>
					<Loader size="sm" />
				</Center>
			) : (
				<pre
					key={offset}
					style={{
						flex: 1,
						minHeight: 0,
						overflow: "auto",
						margin: 0,
						padding: 12,
						fontSize: 13,
						whiteSpace: "pre-wrap",
						overflowWrap: "anywhere",
					}}
				>
					{page.content}
				</pre>
			)}
		</Stack>
	);
}

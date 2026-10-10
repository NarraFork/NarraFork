import { Center, Loader } from "@mantine/core";
import type { FileSelection, FileTarget } from "@shared/file-reference";
import { lazy, Suspense } from "react";
import type { FileEditorContentProps } from "../file-editor/FileEditorContent";
import { getFilePreviewType } from "./FilePreviewModal";
import { LargeFileGate } from "./LargeFileGate";

const FileEditorContent = lazy(() =>
	import("../file-editor/FileEditorContent").then((m) => ({ default: m.FileEditorContent })),
);
const FileViewerContent = lazy(() =>
	import("../file-viewer/FileViewerContent").then((m) => ({ default: m.FileViewerContent })),
);

export interface FilePanelContentProps {
	filePath: string;
	narratorId?: string;
	deviceId?: string;
	referenceOrigin?: boolean;
	selection?: FileSelection;
	navigationRequestId?: string;
	onFileReferenceSelectionChange?: FileEditorContentProps["onFileReferenceSelectionChange"];
	onDirtyChange?: (dirty: boolean) => void;
	onOpenFileTarget?: (target: FileTarget) => void;
	confirmed?: boolean;
	onConfirm?: () => void;
	persistenceKey?: string;
}

/** Shared ordinary file pane; tool-edit snapshots remain a host-owned branch. */
export function FilePanelContent({
	filePath,
	narratorId,
	deviceId,
	referenceOrigin,
	selection,
	navigationRequestId,
	onFileReferenceSelectionChange,
	onDirtyChange,
	onOpenFileTarget,
	confirmed,
	onConfirm,
	persistenceKey,
}: FilePanelContentProps) {
	// Navigation updates the current document without discarding its unsaved draft.
	const identity = JSON.stringify([narratorId, deviceId ?? "local", filePath]);
	return (
		<Suspense
			fallback={
				<Center h="100%">
					<Loader size="sm" />
				</Center>
			}
		>
			{getFilePreviewType(filePath) === "text" ? (
				<LargeFileGate
					narratorId={narratorId}
					deviceId={deviceId}
					referenceOrigin={referenceOrigin}
					filePath={filePath}
					confirmed={confirmed}
					onConfirm={onConfirm}
					persistenceKey={persistenceKey}
				>
					<FileEditorContent
						key={identity}
						filePath={filePath}
						narratorId={narratorId}
						deviceId={deviceId}
						referenceOrigin={referenceOrigin}
						selection={selection}
						navigationRequestId={navigationRequestId}
						onFileReferenceSelectionChange={onFileReferenceSelectionChange}
						onDirtyChange={onDirtyChange}
					/>
				</LargeFileGate>
			) : (
				<FileViewerContent
					key={identity}
					filePath={filePath}
					narratorId={narratorId}
					deviceId={deviceId}
					referenceOrigin={referenceOrigin}
					selection={selection}
					highlightRequestId={navigationRequestId}
					onFileReferenceSelectionChange={onFileReferenceSelectionChange}
					onOpenFileTarget={onOpenFileTarget}
				/>
			)}
		</Suspense>
	);
}

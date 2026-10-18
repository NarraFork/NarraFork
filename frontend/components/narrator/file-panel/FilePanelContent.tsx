import { Center, Loader } from "@mantine/core";
import type { FileSelection, FileTarget } from "@shared/file-reference";
import { lazy, Suspense, useEffect, useRef } from "react";
import { EditorRecoveryBoundary } from "../file-editor/EditorRecoveryBoundary";
import { editorDocumentRegistry } from "../file-editor/editor-document-registry";
import type { FileEditorContentProps } from "../file-editor/FileEditorContent";
import {
	NarratorPanelVisibilityProvider,
	useEditorPanelVisible,
} from "../narrator-panel-visibility";
import { getFilePreviewType } from "./FilePreviewModal";
import { LargeFileGate } from "./LargeFileGate";

const FileEditorContent = lazy(() =>
	import("../file-editor/FileEditorContent").then((m) => ({ default: m.FileEditorContent })),
);
const FileViewerContent = lazy(() =>
	import("../file-viewer/FileViewerContent").then((m) => ({ default: m.FileViewerContent })),
);

export interface FilePanelContentProps {
	/** Host visibility, never keyboard focus. Document visibility is applied independently. */
	visible?: boolean;
	filePath: string;
	narratorId?: string;
	deviceId?: string;
	referenceOrigin?: boolean;
	/** Explicit compatibility entry for a v1-only participant. */
	rawProtocol?: boolean;
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
export function FilePanelContent(props: FilePanelContentProps) {
	return (
		<FilePanelVisibilityContent
			key={JSON.stringify([props.narratorId, props.deviceId ?? "local", props.filePath])}
			{...props}
		/>
	);
}
function FilePanelVisibilityContent(props: FilePanelContentProps) {
	const visible = useEditorPanelVisible(props.visible);
	const displayed = useRef(false);
	if (visible) displayed.current = true;
	useEffect(() => editorDocumentRegistry.registerTab(), []);
	return (
		<NarratorPanelVisibilityProvider value={visible}>
			{displayed.current && <FilePanelBody {...props} />}
		</NarratorPanelVisibilityProvider>
	);
}
function FilePanelBody({
	filePath,
	narratorId,
	deviceId,
	referenceOrigin,
	rawProtocol,
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
	const isText = getFilePreviewType(filePath) === "text";
	const content = (
		<Suspense
			fallback={
				<Center h="100%">
					<Loader size="sm" />
				</Center>
			}
		>
			{isText ? (
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
						rawProtocol={rawProtocol}
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
	return isText ? (
		<EditorRecoveryBoundary
			filePath={filePath}
			narratorId={narratorId}
			deviceId={deviceId}
			referenceOrigin={referenceOrigin}
			rawProtocol={rawProtocol}
		>
			{content}
		</EditorRecoveryBoundary>
	) : (
		content
	);
}

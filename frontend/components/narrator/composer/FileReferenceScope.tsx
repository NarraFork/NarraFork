import { createSharedContext } from "@frontend/lib/shared-context";
import type {
	FileReference,
	FileReferenceContext,
	FileReferenceEditorSelection,
	FileTarget,
} from "@shared/file-reference";
import { type ReactNode, useContext, useMemo } from "react";

export interface FileNavigationOptions {
	/** The initiating row/capability can disappear while authorization is in flight. */
	signal?: AbortSignal;
	/** Check at asynchronous boundaries and immediately before publishing an open/error. */
	isCurrent?: () => boolean;
}

export interface FileReferenceScopeValue {
	narratorId?: string;
	/** null explicitly disables inferred relative paths in historical content. */
	context?: FileReferenceContext | null;
	/** Async implementations must honor cancellation before publishing navigation. */
	openFile?: (target: FileTarget, options?: FileNavigationOptions) => void;
	addReference?: (reference: FileReference) => void;
	selection?: FileReferenceEditorSelection | null;
	setSelection?: (selection: FileReferenceEditorSelection | null) => void;
}

const FileReferenceScope = createSharedContext<FileReferenceScopeValue>(
	"narrator-file-references",
	{},
);

export function useFileReferenceScope(): FileReferenceScopeValue {
	return useContext(FileReferenceScope);
}

/** No layout element: nesting a file's directory must not alter measured markdown geometry. */
export function FileReferenceScopeProvider({
	value,
	children,
}: {
	value: FileReferenceScopeValue;
	children: ReactNode;
}) {
	const parent = useFileReferenceScope();
	const merged = useMemo(() => ({ ...parent, ...value }), [parent, value]);
	return <FileReferenceScope.Provider value={merged}>{children}</FileReferenceScope.Provider>;
}

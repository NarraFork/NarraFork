import { createSharedContext } from "@frontend/lib/shared-context";
import type {
	FileReference,
	FileReferenceContext,
	FileReferenceEditorSelection,
	FileTarget,
} from "@shared/file-reference";
import { type ReactNode, useContext, useMemo } from "react";

export interface FileReferenceScopeValue {
	narratorId?: string;
	/** null explicitly disables inferred relative paths in historical content. */
	context?: FileReferenceContext | null;
	openFile?: (target: FileTarget) => void;
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

let sequence = 0;

/** Browser-local correlation only, never an authorization token or server resource ID. */
export function createEditorLocalId(): string {
	return (
		globalThis.crypto?.randomUUID?.() ??
		`editor-${Date.now().toString(36)}-${(++sequence).toString(36)}-${Math.random().toString(36).slice(2)}`
	);
}

import { QueryClientContext } from "@tanstack/react-query";
import { useContext, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { getToken, onTokenChange } from "../../../lib/api/client";
import { narratorWSManager } from "../../../lib/narrator-ws-manager";
import { editorDocumentRegistry } from "./editor-document-registry";

function principalObservation() {
	try {
		const token = getToken();
		if (!token) return null;
		// Cancellation hint only, never proof of identity or permission.
		try {
			return (
				JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub ?? token
			);
		} catch {
			return token;
		}
	} catch {
		return null;
	}
}

/** Observations only cancel old bindings; only the create endpoint grants sharing authority. */
export function useEditorAuthority(narratorId: string | undefined, reason: string) {
	const client = useContext(QueryClientContext);
	const snapshot = () => {
		const context = client?.getQueryData<{ contextKey: string; revision: number }>([
			"workspaceContext",
			narratorId,
		]);
		const user = client?.getQueryData<{ id: string }>(["auth", "me"]);
		return JSON.stringify([
			principalObservation(),
			user?.id,
			context?.contextKey,
			context?.revision,
		]);
	};
	const identity = useSyncExternalStore(
		(listener) => {
			const cache = client?.getQueryCache().subscribe(listener);
			const token = onTokenChange(listener);
			const storage = (event: StorageEvent) => {
				if (event.key === "narrafork_token" || event.key === null) listener();
			};
			if (typeof window !== "undefined") window.addEventListener("storage", storage);
			return () => {
				cache?.();
				token();
				if (typeof window !== "undefined") window.removeEventListener("storage", storage);
			};
		},
		snapshot,
		snapshot,
	);
	const previous = useRef(identity);
	useLayoutEffect(() => {
		const before = JSON.parse(previous.current);
		const after = JSON.parse(identity);
		if (
			narratorId &&
			(before[0] !== after[0] ||
				(before[1] && before[1] !== after[1]) ||
				(before[2] && (before[2] !== after[2] || before[3] !== after[3])))
		)
			editorDocumentRegistry.invalidateNarrator(narratorId, reason);
		previous.current = identity;
	}, [identity, narratorId, reason]);
	useEffect(() => {
		if (!narratorId) return;
		const handle = narratorWSManager.addListener(
			{ narratorIds: [narratorId], types: ["workspace_context_changed"] },
			() => {
				editorDocumentRegistry.invalidateNarrator(narratorId, reason);
			},
		);
		return () => narratorWSManager.removeListener(handle);
	}, [narratorId, reason]);
	// Only principal changes remount the consumer. Context switches freeze old drafts visibly.
	return JSON.stringify([
		principalObservation(),
		client?.getQueryData<{ id: string }>(["auth", "me"])?.id,
	]);
}

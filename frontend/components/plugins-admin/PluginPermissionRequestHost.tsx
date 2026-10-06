import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useCurrentUser } from "../../hooks/useAuth";
import { LazyOverlayBoundary } from "../common/LazyOverlayBoundary";
import { PermissionPromptQueue } from "./permission-prompt-queue";

const PluginPermissionRequestModal = lazy(() =>
	import("./PluginPermissionRequestModal").then((m) => ({
		default: m.PluginPermissionRequestModal,
	})),
);

/**
 * Global host for the plugin runtime permission prompt.
 *
 * Mirrors BrokenModelMigrationHost: the event listener stays mounted cheaply and
 * the dialog chunk only loads once it is actually needed. Plugin events are
 * broadcast to every connected session, but only admins can decide them — so
 * non-admins never see the prompt. Queueing/dedup policy lives in
 * PermissionPromptQueue; this component only mirrors it into React state.
 */
export function PluginPermissionRequestHost() {
	const { data: user } = useCurrentUser();
	const isAdmin = user?.role === "admin";
	const queueRef = useRef(new PermissionPromptQueue());
	const [currentPluginId, setCurrentPluginId] = useState<string | undefined>();

	useEffect(() => {
		const handle = (event: Event) => {
			if (!isAdmin) return;
			const detail = (
				event as CustomEvent<{
					type?: string;
					pluginId?: string;
					requestId?: string;
					source?: string;
				}>
			).detail;
			setCurrentPluginId(queueRef.current.handleEvent(detail));
		};
		window.addEventListener("narrafork:plugin-event", handle);
		return () => window.removeEventListener("narrafork:plugin-event", handle);
	}, [isAdmin]);

	const handleClose = useCallback((dismissedRequestIds: string[]) => {
		setCurrentPluginId(queueRef.current.close(dismissedRequestIds));
	}, []);

	if (!isAdmin || !currentPluginId) return null;

	return (
		// Mounted by the app shell, so an unhandled chunk failure here would
		// otherwise reach the root boundary and unmount the whole shell.
		<LazyOverlayBoundary resetKey={currentPluginId}>
			<Suspense fallback={null}>
				{/* Keyed so busy/error state never carries over to the next plugin. */}
				<PluginPermissionRequestModal
					key={currentPluginId}
					pluginId={currentPluginId}
					onClose={handleClose}
				/>
			</Suspense>
		</LazyOverlayBoundary>
	);
}

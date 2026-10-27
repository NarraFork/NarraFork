import { Drawer, type DrawerProps, Group, Loader, Modal, type ModalProps } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { Component, type ReactNode, Suspense, useEffect, useRef, useState } from "react";
import i18n from "../../lib/i18n";

interface Props {
	children: ReactNode;
	/**
	 * Changing this value clears a caught error so the overlay can be retried —
	 * typically the flag that opened it, so closing and reopening tries again.
	 */
	resetKey?: unknown;
	/** Identifies the overlay in the failure notification. */
	label?: string;
	/** Optional replacement for a failed body. The historical default is an empty body. */
	fallback?: ReactNode;
}

interface State {
	failed: boolean;
	resetKey: unknown;
}

/** A rejected dynamic import, as reported by browsers when the module cannot be fetched. */
function isChunkLoadError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(
		message,
	);
}

/**
 * Isolates a lazily-imported overlay (modal, drawer, wizard) from the app shell.
 *
 * These components are mounted BY the shell rather than by a route, so a rejected
 * dynamic import propagates past every route boundary to the root
 * `errorComponent` — which unmounts the entire shell, navigation included. The
 * user is then stranded on a bare error screen with no links, and since
 * `React.lazy` caches the rejection, only a full page load recovers.
 *
 * That is a wildly disproportionate outcome for an optional overlay, and it is
 * reachable in practice: the single-threaded backend serves these chunks itself,
 * so any long synchronous job (a storage scan on a multi-GB database is the known
 * case) can make the request fail.
 *
 * A failed overlay therefore renders nothing and reports itself through a
 * notification. The shell stays interactive, and reopening retries the import.
 */
export class LazyOverlayBoundary extends Component<Props, State> {
	state: State = { failed: false, resetKey: undefined };

	static getDerivedStateFromError(): Partial<State> {
		return { failed: true };
	}

	static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
		if (state.failed && state.resetKey !== props.resetKey) {
			return { failed: false, resetKey: props.resetKey };
		}
		if (state.resetKey !== props.resetKey) return { resetKey: props.resetKey };
		return null;
	}

	componentDidCatch(error: unknown): void {
		// Non-chunk errors are real bugs in the overlay; keep them visible in the
		// console rather than swallowing them silently along with the render.
		if (!isChunkLoadError(error)) {
			console.error("Lazy overlay failed to render:", error);
		}
		notifications.show({
			color: "red",
			title: i18n.t("common:overlayLoadFailedTitle"),
			message: this.props.label
				? i18n.t("common:overlayLoadFailedNamed", { name: this.props.label })
				: i18n.t("common:overlayLoadFailedDesc"),
		});
	}

	render(): ReactNode {
		if (this.state.failed) return this.props.fallback ?? null;
		return this.props.children;
	}
}

type LazyOverlayShellBaseProps = {
	opened: boolean;
	onClose: () => void;
	children: ReactNode;
	/** Keep the shell visible without mounting the body (for example while resolving context). */
	busy?: boolean;
	/** Identifies the body in a chunk-load failure notification. */
	label?: string;
	loadingFallback?: ReactNode;
};

export type LazyOverlayShellProps = LazyOverlayShellBaseProps &
	(
		| ({ type: "modal" } & Omit<ModalProps, "opened" | "onClose" | "children">)
		| ({ type: "drawer" } & Omit<DrawerProps, "opened" | "onClose" | "children">)
	);

const defaultLoadingFallback = (
	<Group justify="center" py="md" aria-busy="true">
		<Loader size="sm" />
	</Group>
);

/** Owns the single Mantine overlay while only its body is lazy-loaded. */
export function LazyOverlayShell(props: LazyOverlayShellProps) {
	const { opened, onClose, children, busy = false, label, loadingFallback, type } = props;
	const [mounted, setMounted] = useState(opened);
	const openedRef = useRef(opened);
	const previousOpenedRef = useRef(opened);
	const openGenerationRef = useRef(0);
	openedRef.current = opened;
	if (opened && !previousOpenedRef.current) openGenerationRef.current += 1;
	previousOpenedRef.current = opened;

	useEffect(() => {
		if (opened) setMounted(true);
	}, [opened]);

	if (!opened && !mounted) return null;

	const handleExitTransitionEnd = () => {
		// Mantine may finish an old exit after a rapid reopen. Only that still-closed
		// generation is allowed to release the body and its local state.
		if (!openedRef.current) setMounted(false);
	};
	const body = (
		// Closing must preserve the failed boundary: resetting it here would rethrow the
		// cached lazy rejection during the exit transition. Only a fresh open retries it.
		<LazyOverlayBoundary
			resetKey={openGenerationRef.current}
			label={label}
			fallback={loadingFallback}
		>
			<Suspense fallback={loadingFallback ?? defaultLoadingFallback}>
				{busy ? (loadingFallback ?? defaultLoadingFallback) : children}
			</Suspense>
		</LazyOverlayBoundary>
	);

	if (type === "modal") {
		const {
			opened: _opened,
			onClose: _onClose,
			children: _children,
			busy: _busy,
			label: _label,
			loadingFallback: _loadingFallback,
			type: _type,
			onExitTransitionEnd,
			...modalProps
		} = props;
		return (
			<Modal
				{...modalProps}
				opened={opened}
				onClose={onClose}
				onExitTransitionEnd={() => {
					onExitTransitionEnd?.();
					handleExitTransitionEnd();
				}}
			>
				{body}
			</Modal>
		);
	}

	const {
		opened: _opened,
		onClose: _onClose,
		children: _children,
		busy: _busy,
		label: _label,
		loadingFallback: _loadingFallback,
		type: _type,
		onExitTransitionEnd,
		...drawerProps
	} = props;
	return (
		<Drawer
			{...drawerProps}
			opened={opened}
			onClose={onClose}
			onExitTransitionEnd={() => {
				onExitTransitionEnd?.();
				handleExitTransitionEnd();
			}}
		>
			{body}
		</Drawer>
	);
}

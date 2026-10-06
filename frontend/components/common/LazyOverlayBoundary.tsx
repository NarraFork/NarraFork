import { notifications } from "@mantine/notifications";
import { Component, type ReactNode } from "react";
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
		if (this.state.failed) return null;
		return this.props.children;
	}
}

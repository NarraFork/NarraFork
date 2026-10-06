import {
	Activity,
	type Dispatch,
	memo,
	type ReactNode,
	type SetStateAction,
	useCallback,
	useState,
} from "react";

/** Keep the exit DOM alive until Mantine finishes its transition, not for a guessed timeout. */
export function useDetailsPanelLifecycle(opened: boolean, drawer: boolean) {
	const [state, setState] = useState({ opened, mounted: opened, exiting: false });
	if (state.opened !== opened) {
		setState({ opened, mounted: state.mounted || opened, exiting: !opened && drawer });
	}
	const onExitTransitionEnd = useCallback(() => {
		// A late callback from a cancelled exit must not hide a reopened panel.
		setState((current) =>
			current.opened || !current.exiting ? current : { ...current, exiting: false },
		);
	}, []);
	return {
		mounted: state.mounted || opened,
		active: opened || (drawer && state.exiting),
		onExitTransitionEnd,
	};
}

// Freeze parent props while closed, including during the exit animation. Unlike a
// memo around query-owning content alone, Activity also disconnects subscriptions
// in the entire subtree (access controls, avatars, etc.) once the exit finishes.
// Never compare away a real reopen: the newest element/props must reach the body.
const FrozenDetailsChildren = memo(
	({ children }: { opened: boolean; children: ReactNode }) => children,
	(_previous, next) => !next.opened,
);

export function DetailsPanelContentLifetime({
	opened,
	active,
	mounted,
	children,
}: {
	opened: boolean;
	active: boolean;
	mounted: boolean;
	children: ReactNode;
}) {
	if (!mounted) return null;
	return (
		<Activity mode={active ? "visible" : "hidden"}>
			<FrozenDetailsChildren opened={opened}>{children}</FrozenDetailsChildren>
		</Activity>
	);
}

/** Effect reconnection must not reinitialize unsaved edits after Activity resumes. */
export function useDetailsDraft<T>(source: T) {
	const [state, setState] = useState({ source, value: source, dirty: false });
	if (!Object.is(state.source, source)) {
		setState({ ...state, source, value: state.dirty ? state.value : source });
	}
	const setValue: Dispatch<SetStateAction<T>> = useCallback((update) => {
		setState((current) => ({
			...current,
			value: typeof update === "function" ? (update as (value: T) => T)(current.value) : update,
			dirty: true,
		}));
	}, []);
	const reset = (value: T) => setState({ source, value, dirty: false });
	return { value: state.value, setValue, dirty: state.dirty, reset };
}

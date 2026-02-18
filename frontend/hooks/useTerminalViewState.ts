import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";
import { api } from "../lib/api";

interface ViewState {
	layout: string;
	activeTabId: string | null;
	panelAssignments: Record<string, string> | null;
}

export function useTerminalViewState(opts: { chapterId?: string; narratorId?: string }) {
	const qc = useQueryClient();
	const debounceRef = useRef<ReturnType<typeof setTimeout>>();

	const query = useQuery({
		queryKey: ["terminalViewState", opts],
		queryFn: () => api.getTerminalViewState(opts),
		enabled: !!(opts.chapterId || opts.narratorId),
	});

	const mutation = useMutation({
		mutationFn: (data: Partial<ViewState>) => api.updateTerminalViewState({ ...opts, ...data }),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["terminalViewState", opts] }),
	});

	const mutateRef = useRef(mutation.mutate);
	mutateRef.current = mutation.mutate;

	const update = useCallback(
		(data: Partial<ViewState>) => {
			// Optimistic update in cache
			qc.setQueryData(["terminalViewState", opts], (old: ViewState | undefined) => ({
				...(old ?? { layout: "single", activeTabId: null, panelAssignments: null }),
				...data,
			}));
			// Debounced persist
			clearTimeout(debounceRef.current);
			debounceRef.current = setTimeout(() => {
				mutateRef.current(data);
			}, 500);
		},
		[opts, qc],
	);

	// Cleanup debounce on unmount
	useEffect(() => {
		return () => clearTimeout(debounceRef.current);
	}, []);

	return {
		data: query.data as ViewState | undefined,
		isLoading: query.isLoading,
		update,
	};
}

import { api } from "@frontend/lib/api";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

export function useUpdateGraphPositions(projectId: string) {
	const pendingRef = useRef<Map<string, { x: number; y: number }>>(new Map());
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const mutation = useMutation({
		mutationFn: (positions: Array<{ chapterId: string; x: number; y: number }>) =>
			api.updateGraphPositions(projectId, positions),
	});

	const flush = useCallback(() => {
		if (pendingRef.current.size === 0) return;
		const positions = Array.from(pendingRef.current.entries()).map(([chapterId, pos]) => ({
			chapterId,
			...pos,
		}));
		pendingRef.current.clear();
		mutation.mutate(positions);
	}, [mutation]);

	useEffect(() => {
		return () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, []);

	const savePosition = useCallback(
		(chapterId: string, x: number, y: number) => {
			pendingRef.current.set(chapterId, { x, y });
			if (timerRef.current) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(flush, 500);
		},
		[flush],
	);

	return { savePosition };
}

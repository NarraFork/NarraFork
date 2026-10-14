import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type LegacyMigrationPreview, legacyMigrationApi } from "../lib/api/legacy-migration";

export function legacyMigrationPollInterval(opened: boolean, draining: boolean, failed: boolean) {
	return opened && draining && !failed ? 2000 : false;
}

export function useLegacyMigration(
	projectId: string,
	opened: boolean,
	canManage: boolean,
	allowReceiptLookup = false,
) {
	const qc = useQueryClient();
	const [draining, setDraining] = useState(false);
	const [drainTimedOut, setDrainTimedOut] = useState(false);
	useEffect(() => {
		if (!draining) return;
		// Bound polling when drain completion is not confirmed. syncDisabled alone
		// is never proof that existing workers have exited.
		const timer = setTimeout(() => {
			setDraining(false);
			setDrainTimedOut(true);
		}, 30_000);
		return () => clearTimeout(timer);
	}, [draining]);
	const [syncDisabled, setSyncDisabled] = useState(false);
	const [receiptRecovered, setReceiptRecovered] = useState(false);
	const queryKey = ["legacy-migration", projectId];
	const migration = useMutation({
		mutationFn: (revision: string) => legacyMigrationApi.migrate(projectId, revision),
		onSuccess: (result) => {
			setSyncDisabled(true);
			setDraining(false);
			setDrainTimedOut(false);
			if (result.phase !== "completed") void qc.invalidateQueries({ queryKey });
			// Refresh list summaries and only retained narrator detail records. Avoid
			// invalidating message histories or removed project/chapter detail queries.
			void qc.invalidateQueries({
				queryKey: ["narrators"],
				predicate: (query) =>
					query.queryKey.length === 1 ||
					typeof query.queryKey[1] !== "string" ||
					query.queryKey[1] === "paginated" ||
					query.queryKey[1] === "project-compatibility",
			});
			for (const narratorId of result.narratorIds) {
				void qc.invalidateQueries({ queryKey: ["narrators", narratorId], exact: true });
			}
			// Keep the response: project/chapter records may already have been deleted.
			// Do not invalidate their detail queries or refetch preview after completion.
		},
		onError: () => {
			// A rejected conversion may already have durably stopped sync.
			void qc.invalidateQueries({ queryKey });
		},
	});
	const preview = useQuery({
		queryKey,
		queryFn: () => legacyMigrationApi.preview(projectId),
		enabled:
			opened &&
			(canManage || allowReceiptLookup) &&
			!!projectId &&
			migration.data?.phase !== "completed" &&
			!receiptRecovered,
		retry: false,
		refetchOnWindowFocus: false,
		refetchInterval: (query) =>
			legacyMigrationPollInterval(
				opened && canManage,
				draining && query.state.data?.syncDrained !== true,
				query.state.status === "error",
			),
	});
	useEffect(() => {
		if (preview.isFetchedAfterMount && !preview.isError && preview.data?.phase === "completed") {
			setReceiptRecovered(true);
		}
	}, [preview.isFetchedAfterMount, preview.isError, preview.data?.phase]);
	useEffect(() => {
		if (!preview.data?.syncDisabled || preview.data.syncDrained === undefined) return;
		setDraining(!preview.data.syncDrained);
		if (preview.data.syncDrained) setDrainTimedOut(false);
	}, [preview.data?.syncDisabled, preview.data?.syncDrained]);
	const disable = useMutation({
		mutationFn: () => legacyMigrationApi.disableSync(projectId),
		onSuccess: (result) => {
			setSyncDisabled(true);
			setDraining(!result.drained);
			setDrainTimedOut(false);
			qc.setQueryData<LegacyMigrationPreview>(queryKey, (old) =>
				old ? { ...old, syncDisabled: true, syncDrained: result.drained } : old,
			);
			void qc.invalidateQueries({ queryKey });
		},
	});
	return {
		preview,
		migration,
		disable,
		draining,
		drainTimedOut,
		syncDisabled: syncDisabled || preview.data?.syncDisabled === true,
	};
}

import { useCallback, useSyncExternalStore } from "react";
import { toggleExpandedPath } from "../components/git/git-folder-prefs";

export const GIT_STAGING_FOLDER_PREFS_KEY = "narrafork_git_staging_expansion";
const MAX_DOCUMENT_LENGTH = 256 * 1024;
const MAX_STRING_LENGTH = 4096;
const MAX_ARRAY_LENGTH = 2048;

type ScopePrefs = { groups: string[]; folders: Record<string, string[]> };
type StagingFolderPrefs = Record<string, ScopePrefs>;
const EMPTY_SCOPE: ScopePrefs = { groups: [], folders: {} };
const EMPTY_PREFS: StagingFolderPrefs = {};
const listeners = new Set<() => void>();
let snapshot: StagingFolderPrefs | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isPreferenceString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= MAX_STRING_LENGTH;
}
function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.length <= MAX_ARRAY_LENGTH && value.every(isPreferenceString)
	);
}
function stringArray(value: unknown): string[] {
	return isStringArray(value) ? [...new Set(value)] : [];
}
function parse(raw: string | null): StagingFolderPrefs {
	if (!raw || raw.length > MAX_DOCUMENT_LENGTH) return EMPTY_PREFS;
	try {
		const value: unknown = JSON.parse(raw);
		if (!isRecord(value)) return EMPTY_PREFS;
		const entries: [string, ScopePrefs][] = [];
		for (const [scope, entry] of Object.entries(value)) {
			if (!isPreferenceString(scope) || !isRecord(entry)) continue;
			const folders = isRecord(entry.folders)
				? Object.fromEntries(
						Object.entries(entry.folders)
							.filter(([id]) => isPreferenceString(id))
							.map(([id, paths]) => [id, stringArray(paths)]),
					)
				: {};
			entries.push([scope, { groups: stringArray(entry.groups), folders }]);
		}
		return Object.fromEntries(entries);
	} catch {
		return EMPTY_PREFS;
	}
}
function getSnapshot(): StagingFolderPrefs {
	if (snapshot === undefined) {
		try {
			snapshot = parse(
				typeof window === "undefined"
					? null
					: window.sessionStorage.getItem(GIT_STAGING_FOLDER_PREFS_KEY),
			);
		} catch {
			snapshot = EMPTY_PREFS;
		}
	}
	return snapshot;
}
function getServerSnapshot() {
	return EMPTY_PREFS;
}
function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
function scopePrefs(prefs: StagingFolderPrefs, scope: string): ScopePrefs {
	return Object.hasOwn(prefs, scope) ? prefs[scope] : EMPTY_SCOPE;
}
function persist(scope: string, next: ScopePrefs) {
	if (!scope) return;
	const prefs = { ...getSnapshot(), [scope]: next };
	// User-created expansion remains authoritative even when storage cannot hold it.
	snapshot = prefs;
	for (const listener of listeners) listener();
	// Persist only documents the bounded parser can restore. Larger preferences stay
	// in memory across component remounts; a page reload restores the last saved view.
	if (
		Object.entries(prefs).some(
			([key, entry]) =>
				!isPreferenceString(key) ||
				!isStringArray(entry.groups) ||
				Object.entries(entry.folders).some(
					([id, paths]) => !isPreferenceString(id) || !isStringArray(paths),
				),
		)
	)
		return;
	const raw = JSON.stringify(prefs);
	if (raw.length > MAX_DOCUMENT_LENGTH) return;
	try {
		if (typeof window !== "undefined")
			window.sessionStorage.setItem(GIT_STAGING_FOLDER_PREFS_KEY, raw);
	} catch {
		// Session preferences remain usable until the tab closes.
	}
}

/** Test-only: simulate a fresh page's module cache while retaining sessionStorage. */
export function __resetGitStagingFolderPrefsCache() {
	snapshot = undefined;
}

/** Expansion only: scope is narrator/workspace/principal, never observation or selection. */
export function useGitStagingFolderPrefs(scope: string) {
	const prefs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
	const { groups, folders } = scopePrefs(prefs, scope);
	const toggleGroup = useCallback(
		(id: string) => {
			if (!id) return;
			const current = scopePrefs(getSnapshot(), scope);
			const next = current.groups.includes(id)
				? current.groups.filter((entry) => entry !== id)
				: [...current.groups, id];
			persist(scope, { ...current, groups: next });
		},
		[scope],
	);
	const toggleFolder = useCallback(
		(id: string, path: string) => {
			if (!id || !path) return;
			const current = scopePrefs(getSnapshot(), scope);
			const paths = Object.hasOwn(current.folders, id) ? current.folders[id] : [];
			const next = [...toggleExpandedPath(paths, path)];
			persist(scope, { ...current, folders: { ...current.folders, [id]: next } });
		},
		[scope],
	);
	return { groups, folders, toggleGroup, toggleFolder };
}

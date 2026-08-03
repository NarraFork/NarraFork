import { Combobox, Group, Loader, Text, TextInput, useCombobox } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconFolder } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import type { RemoteDirectoryListing } from "../../lib/api/devices";

const MAX_PATH_OPTIONS = 120;

/**
 * Fetches one level of a remote directory. Supplied by the caller because the
 * authorized endpoint differs by context: admins browse via /api/devices, while
 * a narrator's rule editor browses through its own device authorization.
 */
export type RemoteDirectoryLister = (path?: string) => Promise<RemoteDirectoryListing>;

/**
 * Path input with autocomplete against a remote device's filesystem.
 *
 * Mirrors the local `PathInput` behaviour (type to filter, Tab to complete,
 * click to drill down) but sources candidates over the device RPC bridge
 * instead of the server's own filesystem. Directory creation is intentionally
 * absent: permission rules should reference directories that already exist on
 * the target.
 */
export function RemotePathInput({
	value,
	onChange,
	onBlur,
	onSubmit,
	listDirectory,
	queryKey,
	enabled = true,
	placeholder,
	error,
	rightSection,
}: {
	value: string;
	onChange: (value: string) => void;
	onBlur?: () => void;
	/** Enter with no dropdown option highlighted (i.e. confirming typed text). */
	onSubmit?: () => void;
	listDirectory: RemoteDirectoryLister;
	/** Stable cache key identifying the device being browsed. */
	queryKey: readonly unknown[];
	enabled?: boolean;
	placeholder?: string;
	error?: string;
	rightSection?: React.ReactNode;
}) {
	const { t } = useTranslation("common");
	const [debounced] = useDebouncedValue(value, 200);
	const inputRef = useRef<HTMLInputElement>(null);
	const interactedRef = useRef(false);
	const combobox = useCombobox({
		onDropdownClose: () => combobox.resetSelectedOption(),
	});

	const parsed = parseRemotePath(debounced);
	const {
		data,
		isFetching,
		isError: listingFailed,
	} = useQuery({
		queryKey: [...queryKey, parsed.dir],
		queryFn: () => listDirectory(parsed.dir || undefined),
		enabled: enabled && parsed.dir.length > 0,
		staleTime: 5_000,
		gcTime: 30_000,
		retry: false,
	});

	const filterLower = parsed.filter.toLowerCase();
	const options =
		data?.entries.filter(
			(entry) => !filterLower || entry.name.toLowerCase().includes(filterLower),
		) ?? [];
	const displayedOptions = options.slice(0, MAX_PATH_OPTIONS);
	const hiddenOptions = Math.max(0, options.length - displayedOptions.length);

	const submitOption = useCallback(
		(optionPath: string) => {
			// Append the device's separator so the next keystroke drills deeper.
			const sep = data?.sep || "/";
			onChange(optionPath.endsWith(sep) ? optionPath : optionPath + sep);
			combobox.closeDropdown();
			setTimeout(() => inputRef.current?.focus(), 0);
		},
		[data?.sep, onChange, combobox],
	);

	const handleKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === "Tab" && combobox.dropdownOpened && displayedOptions.length > 0) {
			event.preventDefault();
			const index = combobox.getSelectedOptionIndex();
			if (index !== -1) combobox.selectOption(index);
			else submitOption(displayedOptions[0].path);
			return;
		}
		if (event.key === "Enter") {
			// Let Combobox handle an explicitly arrow-highlighted option; otherwise
			// Enter confirms whatever the user typed.
			if (combobox.dropdownOpened && combobox.getSelectedOptionIndex() !== -1) return;
			event.preventDefault();
			combobox.closeDropdown();
			onSubmit?.();
		}
	};

	return (
		<Combobox store={combobox} onOptionSubmit={submitOption} withinPortal>
			<Combobox.Target>
				<TextInput
					ref={inputRef}
					size="xs"
					value={value}
					placeholder={placeholder}
					error={error}
					onChange={(event) => {
						interactedRef.current = true;
						onChange(event.currentTarget.value);
						combobox.openDropdown();
						combobox.resetSelectedOption();
					}}
					onFocus={() => {
						interactedRef.current = true;
						if (displayedOptions.length > 0) combobox.openDropdown();
					}}
					onBlur={() => {
						combobox.closeDropdown();
						onBlur?.();
					}}
					onKeyDown={handleKeyDown}
					rightSection={rightSection ?? (isFetching ? <Loader size={14} /> : undefined)}
					styles={{ input: { fontFamily: "monospace", fontSize: 12 } }}
					style={{ flex: 1 }}
				/>
			</Combobox.Target>
			<Combobox.Dropdown>
				<Combobox.Options mah={250} style={{ overflowY: "auto" }}>
					{displayedOptions.length === 0 && (
						<Combobox.Empty>
							<Text size="xs" c="dimmed">
								{listingFailed ? t("remotePathListingFailed") : "—"}
							</Text>
						</Combobox.Empty>
					)}
					{displayedOptions.map((entry) => (
						<Combobox.Option key={entry.path} value={entry.path}>
							<Group gap={8} wrap="nowrap">
								<IconFolder size={14} style={{ flexShrink: 0, opacity: 0.5 }} />
								<Text size="xs" truncate>
									{filterLower ? highlightMatch(entry.name, filterLower) : entry.name}
								</Text>
							</Group>
						</Combobox.Option>
					))}
					{hiddenOptions > 0 && (
						<Combobox.Option value="__more__" disabled>
							<Text size="xs" c="dimmed" ta="center">
								{t("pathInputMoreResults", { count: hiddenOptions })}
							</Text>
						</Combobox.Option>
					)}
				</Combobox.Options>
			</Combobox.Dropdown>
		</Combobox>
	);
}

/**
 * Split a partially typed remote path into a listable directory and a trailing
 * filter segment. Separator is inferred from the text itself so one component
 * serves both POSIX devices and Windows devices (including UNC roots).
 */
export function parseRemotePath(raw: string): { dir: string; filter: string } {
	const trimmed = raw.trim();
	if (!trimmed) return { dir: "", filter: "" };

	const sep = trimmed.includes("\\") ? "\\" : "/";
	if (trimmed.endsWith(sep)) {
		// Keep the root itself listable ("/" or "C:\").
		const withoutTrailing = trimmed.slice(0, -sep.length);
		return { dir: withoutTrailing || sep, filter: "" };
	}

	const lastSep = trimmed.lastIndexOf(sep);
	if (lastSep === -1) {
		// A bare drive letter is a root, not a filter segment.
		if (/^[A-Za-z]:$/.test(trimmed)) return { dir: `${trimmed}\\`, filter: "" };
		return { dir: "", filter: trimmed };
	}
	return {
		dir: lastSep === 0 ? sep : trimmed.slice(0, lastSep),
		filter: trimmed.slice(lastSep + sep.length),
	};
}

function highlightMatch(name: string, filter: string): React.ReactNode {
	const index = name.toLowerCase().indexOf(filter);
	if (index === -1) return name;
	return (
		<>
			{name.slice(0, index)}
			<span style={{ fontWeight: 700, color: "var(--mantine-color-indigo-4)" }}>
				{name.slice(index, index + filter.length)}
			</span>
			{name.slice(index + filter.length)}
		</>
	);
}

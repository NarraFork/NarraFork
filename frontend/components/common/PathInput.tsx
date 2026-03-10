import { Combobox, Group, Loader, Text, TextInput, useCombobox } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconFolder } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";

interface PathInputProps {
	/** Called when the user confirms a path (Enter key or option click). */
	onConfirm: (path: string) => void;
	placeholder?: string;
	/** Auto-focus on mount */
	autoFocus?: boolean;
}

/**
 * A path input with real-time filesystem autocomplete.
 *
 * Typing triggers a browse request for the parent directory, then filters
 * child entries by the trailing segment. Clicking an option fills it in
 * and immediately browses into it. Enter confirms the current value.
 *
 * Supports both Unix (`/`) and Windows (`C:\`) path formats.
 */
export function PathInput({ onConfirm, placeholder, autoFocus }: PathInputProps) {
	const [value, setValue] = useState("");
	const [debounced] = useDebouncedValue(value, 150);
	const inputRef = useRef<HTMLInputElement>(null);
	const combobox = useCombobox({
		onDropdownClose: () => combobox.resetSelectedOption(),
	});

	// Parse the input into a browsable directory and a trailing filter segment.
	// e.g. "/home/user/pro" → dir="/home/user", filter="pro"
	// e.g. "/home/user/"    → dir="/home/user", filter=""
	// e.g. "C:\Users\foo"   → dir="C:\Users",   filter="foo"
	const parsed = parsePath(debounced);

	const {
		data,
		isFetching,
		error: _error,
	} = useQuery({
		queryKey: ["fs-browse", parsed.dir],
		queryFn: () => api.fsBrowse(parsed.dir || undefined),
		enabled: parsed.dir.length > 0,
		staleTime: 5000,
		retry: false,
	});

	// Filter entries by the trailing segment
	const filterLower = parsed.filter.toLowerCase();
	const options =
		data?.entries.filter((e) => !filterLower || e.name.toLowerCase().includes(filterLower)) ?? [];

	// Open dropdown when we have options
	// biome-ignore lint/correctness/useExhaustiveDependencies: combobox methods are unstable refs — depend only on data triggers
	useEffect(() => {
		if (options.length > 0 && value.length > 0) {
			combobox.openDropdown();
		} else {
			combobox.closeDropdown();
		}
	}, [options.length, value.length]);

	useEffect(() => {
		if (autoFocus) inputRef.current?.focus();
	}, [autoFocus]);

	const handleOptionSubmit = useCallback(
		(optionPath: string) => {
			// Fill the path and append separator so user can keep drilling down
			const sep = data?.sep || "/";
			const next = optionPath.endsWith(sep) ? optionPath : optionPath + sep;
			setValue(next);
			combobox.closeDropdown();
			// Re-focus so user can keep typing
			setTimeout(() => inputRef.current?.focus(), 0);
		},
		[data?.sep, combobox],
	);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			// If dropdown is open but no option is actively highlighted, confirm the typed value
			if (combobox.dropdownOpened) {
				const idx = combobox.getSelectedOptionIndex();
				if (idx === -1) {
					e.preventDefault();
					combobox.closeDropdown();
					const v = value.trim();
					if (v) {
						onConfirm(v);
						setValue("");
					}
				}
				// else let Combobox handle the option selection
			} else {
				e.preventDefault();
				const v = value.trim();
				if (v) {
					onConfirm(v);
					setValue("");
				}
			}
		}
	};

	return (
		<Combobox store={combobox} onOptionSubmit={handleOptionSubmit} withinPortal>
			<Combobox.Target>
				<TextInput
					ref={inputRef}
					size="xs"
					placeholder={placeholder}
					value={value}
					onChange={(e) => {
						setValue(e.currentTarget.value);
						combobox.openDropdown();
						combobox.resetSelectedOption();
					}}
					onFocus={() => {
						if (options.length > 0) combobox.openDropdown();
					}}
					onBlur={() => combobox.closeDropdown()}
					onKeyDown={handleKeyDown}
					rightSection={isFetching ? <Loader size={14} /> : undefined}
					styles={{ input: { fontFamily: "monospace", fontSize: 12 } }}
					style={{ flex: 1 }}
				/>
			</Combobox.Target>
			<Combobox.Dropdown>
				<Combobox.Options mah={250} style={{ overflowY: "auto" }}>
					{options.length === 0 && (
						<Combobox.Empty>
							<Text size="xs" c="dimmed">
								—
							</Text>
						</Combobox.Empty>
					)}
					{options.map((entry) => (
						<Combobox.Option key={entry.path} value={entry.path}>
							<Group gap={8} wrap="nowrap">
								<IconFolder size={14} style={{ flexShrink: 0, opacity: 0.5 }} />
								<Text size="xs" truncate>
									{filterLower ? highlightMatch(entry.name, filterLower) : entry.name}
								</Text>
							</Group>
						</Combobox.Option>
					))}
				</Combobox.Options>
			</Combobox.Dropdown>
		</Combobox>
	);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parsePath(raw: string): { dir: string; filter: string } {
	const trimmed = raw.trim();
	if (!trimmed) return { dir: "", filter: "" };

	// Detect separator: backslash for Windows-style paths, forward slash otherwise
	const hasBackslash = trimmed.includes("\\");
	const sep = hasBackslash ? "\\" : "/";

	// If the path ends with a separator, the whole thing is the directory
	if (trimmed.endsWith(sep)) {
		return { dir: trimmed.slice(0, -sep.length) || sep, filter: "" };
	}

	const lastSep = trimmed.lastIndexOf(sep);
	if (lastSep === -1) {
		// No separator at all — on Windows could be "C:" which is a drive root
		if (/^[A-Za-z]:$/.test(trimmed)) {
			return { dir: `${trimmed}\\`, filter: "" };
		}
		return { dir: "", filter: trimmed };
	}

	// Unix root: "/foo" → dir="/", filter="foo"
	const dir = lastSep === 0 ? sep : trimmed.slice(0, lastSep);
	const filter = trimmed.slice(lastSep + sep.length);
	return { dir, filter };
}

function highlightMatch(name: string, filter: string): React.ReactNode {
	const idx = name.toLowerCase().indexOf(filter);
	if (idx === -1) return name;
	return (
		<>
			{name.slice(0, idx)}
			<span style={{ fontWeight: 700, color: "var(--mantine-color-indigo-4)" }}>
				{name.slice(idx, idx + filter.length)}
			</span>
			{name.slice(idx + filter.length)}
		</>
	);
}

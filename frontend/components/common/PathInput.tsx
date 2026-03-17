import { Combobox, Group, Loader, Text, TextInput, useCombobox } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconFolder, IconFolderPlus } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

interface PathInputBaseProps {
	placeholder?: string;
	/** Auto-focus on mount */
	autoFocus?: boolean;
	label?: string;
	description?: string;
	error?: string;
	disabled?: boolean;
	required?: boolean;
	leftSection?: React.ReactNode;
	rightSection?: React.ReactNode;
	rightSectionWidth?: number;
}

interface UncontrolledPathInputProps extends PathInputBaseProps {
	/** Called when the user confirms a path (Enter key or option click). Clears after confirm. */
	onConfirm: (path: string) => void;
	value?: undefined;
	onChange?: undefined;
}

interface ControlledPathInputProps extends PathInputBaseProps {
	/** Controlled value */
	value: string;
	/** Called on every change (typing or option selection) */
	onChange: (path: string) => void;
	onConfirm?: undefined;
}

type PathInputProps = UncontrolledPathInputProps | ControlledPathInputProps;

/**
 * A path input with real-time filesystem autocomplete.
 *
 * Typing triggers a browse request for the parent directory, then filters
 * child entries by the trailing segment. Clicking an option fills it in
 * and immediately browses into it.
 *
 * When the typed trailing segment doesn't match any existing directory,
 * a "Create <name>" option appears at the bottom of the dropdown.
 *
 * Two modes:
 * - Uncontrolled: pass `onConfirm` — Enter confirms and clears the input.
 * - Controlled: pass `value` + `onChange` — behaves like a normal input with autocomplete.
 *
 * Supports both Unix (`/`) and Windows (`C:\`) path formats.
 */
export function PathInput(props: PathInputProps) {
	const {
		placeholder,
		autoFocus,
		label,
		description,
		error,
		disabled,
		required,
		leftSection,
		rightSection: rightSectionProp,
		rightSectionWidth,
	} = props;
	const isControlled = props.value !== undefined;
	const { t } = useTranslation("common");
	const queryClient = useQueryClient();

	const [internalValue, setInternalValue] = useState("");
	const value = isControlled ? props.value : internalValue;
	const setValue = isControlled ? (v: string) => props.onChange(v) : setInternalValue;

	const [debounced] = useDebouncedValue(value, 150);
	const inputRef = useRef<HTMLInputElement>(null);
	// Track whether the user has interacted — prevents auto-opening on mount
	// when a controlled value is already populated.
	const interactedRef = useRef(false);
	const combobox = useCombobox({
		onDropdownClose: () => combobox.resetSelectedOption(),
	});

	// Parse the input into a browsable directory and a trailing filter segment.
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

	// Show "Create <name>" option when:
	// - there's a filter segment typed (user is typing a name)
	// - the parent directory exists (we got data back)
	// - no existing entry matches the filter exactly
	const canCreate =
		parsed.filter.length > 0 &&
		!!data?.path &&
		!data.entries.some((e) => e.name.toLowerCase() === filterLower);

	const mkdirMutation = useMutation({
		mutationFn: ({ parent, name }: { parent: string; name: string }) => api.fsMkdir(parent, name),
		onSuccess: (result) => {
			queryClient.invalidateQueries({ queryKey: ["fs-browse", parsed.dir] });
			// Fill in the newly created path
			const sep = data?.sep || "/";
			const next = result.path.endsWith(sep) ? result.path : result.path + sep;
			setValue(next);
			combobox.closeDropdown();
			setTimeout(() => inputRef.current?.focus(), 0);
		},
	});

	// Determine if dropdown should show (has options or can create)
	const hasDropdownContent = options.length > 0 || canCreate;

	// Open dropdown when we have content (only after user interaction)
	// biome-ignore lint/correctness/useExhaustiveDependencies: combobox methods are unstable refs — depend only on data triggers
	useEffect(() => {
		if (!interactedRef.current) return;
		if (hasDropdownContent && value.length > 0) {
			combobox.openDropdown();
		} else {
			combobox.closeDropdown();
		}
	}, [hasDropdownContent, value.length]);

	useEffect(() => {
		if (autoFocus) inputRef.current?.focus();
	}, [autoFocus]);

	const CREATE_OPTION_VALUE = "__create__";

	const handleOptionSubmit = useCallback(
		(optionValue: string) => {
			if (optionValue === CREATE_OPTION_VALUE) {
				// Create the directory
				if (data?.path && parsed.filter) {
					mkdirMutation.mutate({ parent: data.path, name: parsed.filter });
				}
				return;
			}
			// Fill the path and append separator so user can keep drilling down
			const sep = data?.sep || "/";
			const next = optionValue.endsWith(sep) ? optionValue : optionValue + sep;
			setValue(next);
			combobox.closeDropdown();
			// Re-focus so user can keep typing
			setTimeout(() => inputRef.current?.focus(), 0);
		},
		[data?.sep, data?.path, parsed.filter, combobox, setValue, mkdirMutation],
	);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			// When dropdown is open, try to fill the first option on Enter
			if (combobox.dropdownOpened) {
				const idx = combobox.getSelectedOptionIndex();
				if (idx === -1 && options.length > 0) {
					// No highlighted option — select the first candidate
					e.preventDefault();
					handleOptionSubmit(options[0].path);
					return;
				}
				if (idx !== -1) {
					// Let Combobox handle the highlighted option selection
					return;
				}
			}

			if (isControlled) {
				// Controlled mode: just close dropdown on Enter
				combobox.closeDropdown();
				return;
			}
			// Uncontrolled mode: confirm and clear
			e.preventDefault();
			combobox.closeDropdown();
			const v = value.trim();
			if (v) {
				props.onConfirm(v);
				setValue("");
			}
		}
	};

	return (
		<Combobox store={combobox} onOptionSubmit={handleOptionSubmit} withinPortal>
			<Combobox.Target>
				<TextInput
					ref={inputRef}
					size="xs"
					label={label}
					description={description}
					error={error}
					placeholder={placeholder}
					disabled={disabled}
					required={required}
					value={value}
					onChange={(e) => {
						interactedRef.current = true;
						setValue(e.currentTarget.value);
						combobox.openDropdown();
						combobox.resetSelectedOption();
					}}
					onFocus={() => {
						interactedRef.current = true;
						if (hasDropdownContent) combobox.openDropdown();
					}}
					onBlur={() => combobox.closeDropdown()}
					onKeyDown={handleKeyDown}
					leftSection={leftSection}
					rightSection={rightSectionProp ?? (isFetching ? <Loader size={14} /> : undefined)}
					rightSectionWidth={rightSectionWidth}
					styles={{ input: { fontFamily: "monospace", fontSize: 12 } }}
					style={{ flex: 1 }}
				/>
			</Combobox.Target>
			<Combobox.Dropdown>
				<Combobox.Options mah={250} style={{ overflowY: "auto" }}>
					{options.length === 0 && !canCreate && (
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
					{canCreate && (
						<Combobox.Option value={CREATE_OPTION_VALUE} disabled={mkdirMutation.isPending}>
							<Group gap={8} wrap="nowrap">
								<IconFolderPlus
									size={14}
									style={{ flexShrink: 0, color: "var(--mantine-color-indigo-5)" }}
								/>
								<Text size="xs" c="indigo" truncate>
									{mkdirMutation.isPending ? `${t("create")}…` : `${t("create")} ${parsed.filter}`}
								</Text>
							</Group>
						</Combobox.Option>
					)}
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

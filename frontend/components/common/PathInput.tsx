import { Combobox, Group, Loader, Text, TextInput, useCombobox } from "@mantine/core";
import { useDebouncedValue } from "@mantine/hooks";
import { IconFolder, IconFolderPlus, IconFolderSymlink } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useFileSystemCapability } from "../../hooks/usePlatform";
import { api } from "../../lib/api";

const MAX_PATH_OPTIONS = 120;

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
	/** Preferred side for path suggestions; top keeps actions below the input accessible. */
	dropdownPosition?: "top" | "bottom";
	/** Called after the dropdown closes on blur, for callers that persist on blur. */
	onBlur?: () => void;
	/**
	 * Controlled mode only: Enter confirmed the typed value (no dropdown option
	 * was highlighted). Lets a parent form submit on Enter.
	 */
	onSubmit?: () => void;
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
		dropdownPosition = "bottom",
		onBlur,
		onSubmit,
	} = props;
	const isControlled = props.value !== undefined;
	const { t } = useTranslation("common");
	const queryClient = useQueryClient();
	const fsCapability = useFileSystemCapability();
	const browseSupported = fsCapability.browse.supported;
	const mkdirSupported = fsCapability.mkdir.supported;

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
		enabled: browseSupported && parsed.dir.length > 0,
		staleTime: 5000,
		gcTime: 30_000,
		retry: false,
	});

	// Filter entries by the trailing segment
	const filterLower = parsed.filter.toLowerCase();
	const options =
		data?.entries.filter((e) => !filterLower || e.name.toLowerCase().includes(filterLower)) ?? [];
	const displayedOptions = options.slice(0, MAX_PATH_OPTIONS);
	const hiddenOptions = Math.max(0, options.length - displayedOptions.length);

	// Show "Create <name>" option when:
	// - there's a filter segment typed (user is typing a name)
	// - the parent directory exists (we got data back)
	// - no existing entry matches the filter exactly
	const canCreate =
		mkdirSupported &&
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
	const MORE_OPTION_VALUE = "__more__";

	const handleOptionSubmit = useCallback(
		(optionValue: string) => {
			if (optionValue === MORE_OPTION_VALUE) return;
			if (optionValue === CREATE_OPTION_VALUE) {
				// Create the directory
				if (mkdirSupported && data?.path && parsed.filter) {
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
		[data?.sep, data?.path, parsed.filter, combobox, setValue, mkdirMutation, mkdirSupported],
	);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		// Tab = autocomplete first candidate (like shell tab-completion)
		if (e.key === "Tab" && combobox.dropdownOpened && displayedOptions.length > 0) {
			e.preventDefault();
			const idx = combobox.getSelectedOptionIndex();
			if (idx !== -1) {
				// Highlighted option — select it
				combobox.selectOption(idx);
			} else {
				// No highlight — pick the first displayed candidate
				handleOptionSubmit(displayedOptions[0].path);
			}
			return;
		}

		if (e.key === "Enter") {
			if (combobox.dropdownOpened) {
				const idx = combobox.getSelectedOptionIndex();
				if (idx !== -1) {
					// User explicitly highlighted an option with arrow keys — let Combobox handle it
					return;
				}
				// No highlighted option — close dropdown and confirm the current value
				// (don't auto-select the first candidate, so the user can confirm the typed path)
			}

			e.preventDefault();
			combobox.closeDropdown();

			if (isControlled) {
				// Controlled mode: the parent owns the value, so Enter only signals
				// intent to confirm it.
				onSubmit?.();
				return;
			}
			// Uncontrolled mode: confirm and clear
			const v = value.trim();
			if (v) {
				props.onConfirm(v);
				setValue("");
			}
		}
	};

	return (
		<Combobox
			store={combobox}
			onOptionSubmit={handleOptionSubmit}
			position={dropdownPosition}
			middlewares={{ flip: dropdownPosition !== "top" }}
			withinPortal
		>
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
					}}
					onBlur={() => {
						combobox.closeDropdown();
						onBlur?.();
					}}
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
					{displayedOptions.map((entry) => {
						const EntryIcon = entry.isSymlink ? IconFolderSymlink : IconFolder;
						return (
							<Combobox.Option
								key={entry.path}
								value={entry.path}
								title={entry.isSymlink ? t("symlinkDirectory") : undefined}
							>
								<Group gap={8} wrap="nowrap">
									<EntryIcon size={14} style={{ flexShrink: 0, opacity: 0.5 }} />
									<Text size="xs" truncate>
										{filterLower ? highlightMatch(entry.name, filterLower) : entry.name}
									</Text>
								</Group>
							</Combobox.Option>
						);
					})}
					{hiddenOptions > 0 && (
						<Combobox.Option value={MORE_OPTION_VALUE} disabled>
							<Text size="xs" c="dimmed" ta="center">
								{t("pathInputMoreResults", { count: hiddenOptions })}
							</Text>
						</Combobox.Option>
					)}
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

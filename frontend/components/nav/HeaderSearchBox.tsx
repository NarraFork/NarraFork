import { ActionIcon, Group, TextInput } from "@mantine/core";
import { IconSearch, IconX } from "@tabler/icons-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * Header search box (desktop input + mobile toggle).
 *
 * `query` changes on every keystroke, so it MUST live here and not in
 * `AppRootLayout`: as AppShell-level state, each keystroke re-rendered the
 * entire application shell (header, nav, outlet) — measurable as multi-second
 * input lag once the tree is large. `searchOpen` stays with the parent because
 * it is a rare toggle AND the parent needs it to hide the mobile title.
 */
export function HeaderSearchBox({
	searchOpen,
	onSearchOpenChange,
}: {
	searchOpen: boolean;
	onSearchOpenChange: (open: boolean) => void;
}) {
	const { t } = useTranslation("nav");
	const navigate = useNavigate();
	const [query, setQuery] = useState("");

	const handleSearch = () => {
		const q = query.trim();
		if (!q) return;
		navigate({ to: "/search", search: { q } });
		onSearchOpenChange(false);
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") handleSearch();
		if (e.key === "Escape") onSearchOpenChange(false);
	};

	return (
		<>
			{/* Desktop: always show search input */}
			<TextInput
				placeholder={t("searchPlaceholder")}
				size="sm"
				style={{ width: 300 }}
				value={query}
				onChange={(e) => setQuery(e.currentTarget.value)}
				onKeyDown={handleKeyDown}
				rightSection={
					<ActionIcon size="sm" variant="subtle" onClick={handleSearch}>
						<IconSearch size={16} />
					</ActionIcon>
				}
				visibleFrom="sm"
			/>
			{/* Mobile: toggle search input via icon */}
			{searchOpen ? (
				<Group wrap="nowrap" gap="xs" hiddenFrom="sm" style={{ flex: 1, minWidth: 0 }}>
					<TextInput
						placeholder={t("searchPlaceholder")}
						size="sm"
						style={{ flex: 1, minWidth: 0 }}
						value={query}
						onChange={(e) => setQuery(e.currentTarget.value)}
						onKeyDown={handleKeyDown}
						rightSection={
							<ActionIcon size="sm" variant="subtle" onClick={handleSearch}>
								<IconSearch size={16} />
							</ActionIcon>
						}
						autoFocus
					/>
					<ActionIcon variant="subtle" color="gray" onClick={() => onSearchOpenChange(false)}>
						<IconX size={18} />
					</ActionIcon>
				</Group>
			) : (
				<ActionIcon
					variant="subtle"
					color="gray"
					onClick={() => onSearchOpenChange(true)}
					title={t("searchPlaceholder")}
					hiddenFrom="sm"
				>
					<IconSearch size={18} />
				</ActionIcon>
			)}
		</>
	);
}

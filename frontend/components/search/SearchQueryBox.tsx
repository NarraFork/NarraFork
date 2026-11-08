import { CloseButton, TextInput } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { subscribeSearchPageFocus, takeSearchPageFocusRequest } from "../../lib/search-page-focus";

/**
 * The search page's query box. Enter runs the search (the URL owns the query, so a
 * search survives reloads and shared links); Escape clears what was typed. Focused on
 * arrival, and again whenever ⌘K / Ctrl+K asks for it while the page is open.
 *
 * `initial` is the URL's query; the parent remounts this box (by key) when the URL query
 * changes, so typing here is never overwritten mid-edit by a re-render.
 */
export function SearchQueryBox({
	initial,
	onSubmit,
}: {
	initial: string;
	onSubmit: (q: string) => void;
}) {
	const { t } = useTranslation("search");
	const [value, setValue] = useState(initial);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const focus = () => {
			const input = inputRef.current;
			if (!input) return;
			input.focus();
			input.select();
		};
		// Arriving at the page is itself the request to type: always focus then. Later
		// requests (⌘K while already here) come through the subscription.
		takeSearchPageFocusRequest();
		focus();
		return subscribeSearchPageFocus(() => {
			if (takeSearchPageFocusRequest()) focus();
		});
	}, []);

	const submit = () => onSubmit(value.trim());

	return (
		<TextInput
			ref={inputRef}
			size="md"
			radius="md"
			style={{ flex: 1 }}
			placeholder={t("queryPlaceholder")}
			aria-label={t("queryPlaceholder")}
			value={value}
			onChange={(e) => setValue(e.currentTarget.value)}
			onKeyDown={(e) => {
				if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
				if (e.key === "Escape" && value) {
					e.preventDefault();
					setValue("");
				}
			}}
			leftSection={<IconSearch size={18} />}
			rightSection={
				value ? (
					<CloseButton
						size="sm"
						aria-label={t("clearQuery")}
						onClick={() => {
							setValue("");
							inputRef.current?.focus();
						}}
					/>
				) : undefined
			}
		/>
	);
}

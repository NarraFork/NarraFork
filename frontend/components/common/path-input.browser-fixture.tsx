/**
 * PathInput in a dialog with a submit button right below it, as in the new-project dialog.
 * The browse API and the platform capability are replaced by the test's bundler plugin
 * (`path-input.browser.test.ts`); everything else is the production component and CSS.
 */
import "@mantine/core/styles.css";
import { Button, MantineProvider, Modal, Stack, TextInput } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import enCommon from "../../locales/en/common.json";
import { PathInput } from "./PathInput";

const root = createRoot(document.getElementById("root") as HTMLElement);
const instance = i18next.createInstance();
await instance.use(initReactI18next).init({
	lng: "en",
	resources: { en: { common: enCommon } },
	react: { useSuspense: false },
});

let submits = 0;

function Dialog({ position, initial }: { position: "top" | "bottom"; initial: string }) {
	const [value, setValue] = useState(initial);
	return (
		<Modal opened onClose={() => {}} title="New project" closeOnEscape>
			<Stack>
				<TextInput label="Name" data-testid="name" />
				<TextInput label="Other" data-testid="other" />
				<PathInput
					label="Directory"
					value={value}
					onChange={setValue}
					dropdownPosition={position}
				/>
				<Button data-testid="submit" onClick={() => submits++}>
					Create
				</Button>
			</Stack>
		</Modal>
	);
}

export function start(position: "top" | "bottom", initial = "") {
	submits = 0;
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	root.render(
		<I18nextProvider i18n={instance}>
			<MantineProvider defaultColorScheme="dark">
				<QueryClientProvider client={client}>
					<Dialog key={`${position}:${initial}`} position={position} initial={initial} />
				</QueryClientProvider>
			</MantineProvider>
		</I18nextProvider>,
	);
}

export function submitCount() {
	return submits;
}

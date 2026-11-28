import { afterAll, describe, expect, mock, test } from "bun:test";
import { MantineProvider } from "@mantine/core";
import { renderToStaticMarkup } from "react-dom/server";

const original = { ...(await import("react-i18next")) };
let chinese = false;
mock.module("react-i18next", () => ({
	...original,
	useTranslation: () => ({
		t: (key: string, fallback?: string) => {
			if (key === "credentialTransfer.kinds.credential") return chinese ? "凭据" : "Credential";
			if (key === "credentialTransfer.selectAll") return "All credentials";
			return fallback ?? key;
		},
	}),
}));

const { CredentialChecklist } = await import("./CredentialTransferCard");

function render() {
	return renderToStaticMarkup(
		<MantineProvider>
			<CredentialChecklist
				list={[{ kind: "credential", id: "key", label: "Kimi · backup" }]}
				selected={new Set(["credential:key"])}
				onChange={() => {}}
			/>
		</MantineProvider>,
	);
}

describe("CredentialTransferCard", () => {
	test("uses one credential badge for every template, in English and Chinese", () => {
		expect(render()).toContain("Credential");
		chinese = true;
		expect(render()).toContain("凭据");
	});
});

afterAll(() => mock.restore());

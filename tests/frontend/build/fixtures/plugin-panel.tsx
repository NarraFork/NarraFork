import { Button } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import React, { useState } from "react";
import { jsx } from "react/jsx-runtime";
import { createRoot } from "react-dom/client";

function Panel() {
	const [opened, { toggle }] = useDisclosure(false);
	return <Button onClick={toggle}>{opened ? "Open" : "Closed"}</Button>;
}

// A minimal plain-script iframe entry. The SDK handshake remains the host's concern.
Object.assign(globalThis, {
	pluginPanel: {
		mount(root: HTMLElement) {
			const mounted = createRoot(root);
			mounted.render(<Panel />);
			return () => mounted.unmount();
		},
		// Expose references only for this fixture's identity assertions.
		React,
		useState,
		createRoot,
		Button,
		useDisclosure,
		jsx,
		element: <Button>Shared runtime</Button>,
		mode: process.env.NODE_ENV,
	},
});

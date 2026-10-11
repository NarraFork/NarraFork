package handlers

import (
	"runtime"
	"slices"
	"strings"
	"testing"
)

func TestInteractiveAndNonInteractiveShellAreSeparate(t *testing.T) {
	interactive := interactiveShell()
	command, args := loginShell("echo test")
	if runtime.GOOS == "windows" {
		if interactive[0] != "powershell.exe" || slices.Contains(interactive, "-NonInteractive") || slices.Contains(interactive, "-l") {
			t.Fatal(interactive)
		}
		if command != "powershell.exe" || !slices.Contains(args, "-NonInteractive") || !slices.Contains(args, "-Command") {
			t.Fatal(command, args)
		}
	} else if !slices.Contains(interactive, "-l") || !slices.Contains(args, "-c") {
		t.Fatal(interactive, args)
	}
}
func TestFreshEnvironmentDoesNotInheritExecutorSecrets(t *testing.T) {
	t.Setenv("NARRAFORK_TEST_SECRET", "must-not-inherit")
	env := commandEnv(true, map[string]any{"env": map[string]any{"CUSTOM_UNICODE": "你好"}})
	for _, entry := range env {
		if strings.HasPrefix(entry, "NARRAFORK_TEST_SECRET=") {
			t.Fatal("fresh shell inherited executor secret")
		}
	}
	if !slices.Contains(env, "CUSTOM_UNICODE=你好") {
		t.Fatal("explicit environment override lost")
	}
	if runtime.GOOS == "windows" {
		for _, entry := range env {
			if strings.HasPrefix(entry, "LANG=") || strings.HasPrefix(entry, "TERM=") || strings.HasPrefix(entry, "HOME=") {
				t.Fatal("fresh Windows shell inherited Unix-only bootstrap state")
			}
		}
	}
}

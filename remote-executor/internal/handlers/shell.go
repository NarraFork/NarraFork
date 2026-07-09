package handlers

import (
	"os"
	"runtime"
)

// loginShell returns the shell + args to run a command string, mirroring the
// server's LocalBackend shell selection at a basic level. On Windows it uses
// PowerShell; elsewhere it uses $SHELL (or /bin/sh) with -c.
func loginShell(command string) (string, []string) {
	if runtime.GOOS == "windows" {
		shell := "powershell.exe"
		return shell, []string{"-NoProfile", "-NonInteractive", "-Command", command}
	}
	shell := os.Getenv("SHELL")
	if shell == "" {
		shell = "/bin/sh"
	}
	return shell, []string{"-c", command}
}

// commandEnv builds the environment for an exec. In fresh mode it keeps a
// minimal set; otherwise it inherits the executor process env. Extra overrides
// from params.env are applied last.
func commandEnv(freshEnv bool, params map[string]any) []string {
	var env []string
	if freshEnv {
		env = []string{
			"HOME=" + os.Getenv("HOME"),
			"PATH=" + os.Getenv("PATH"),
			"TERM=" + orDefault(os.Getenv("TERM"), "xterm-256color"),
			"LANG=" + orDefault(os.Getenv("LANG"), "en_US.UTF-8"),
		}
	} else {
		env = os.Environ()
	}
	if overrides, ok := params["env"].(map[string]any); ok {
		for k, v := range overrides {
			if s, ok := v.(string); ok {
				env = append(env, k+"="+s)
			}
		}
	}
	return env
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

//go:build !windows

package main

import "context"

/*
Non-Windows builds have no Service Control Manager, so there is nothing to detect
and nothing to hand off to: the caller always runs inline.

Linux and macOS supervise the executor with systemd and launchd, which run an
ordinary foreground process and need no in-process cooperation at all — unlike the
SCM, which requires the process to connect to a dispatcher and report status.
*/
func runAsServiceIfLaunchedBySCM(_ func(context.Context, func()) error) (bool, error) {
	return false, nil
}

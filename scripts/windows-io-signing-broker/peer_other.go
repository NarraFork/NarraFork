//go:build !linux

package main

import (
	"errors"
	"net"
)

type processIdentity struct {
	PID                   int    `json:"pid"`
	UID                   uint32 `json:"uid"`
	ParentPID             int    `json:"parentPid"`
	StartTime             string `json:"startTime"`
	Exe                   string `json:"exe"`
	ExeSHA256             string `json:"exeSha256"`
	NoNewPrivileges       bool   `json:"noNewPrivileges"`
	EffectiveCapabilities uint64 `json:"effectiveCapabilities"`
	PermittedCapabilities uint64 `json:"permittedCapabilities"`
	AmbientCapabilities   uint64 `json:"ambientCapabilities"`
}

var unsupported = errors.New("WINDOWS_IO_UNIX_CUSTODY_REQUIRES_LINUX_SO_PEERCRED")

func peerIdentity(*net.UnixConn) (processIdentity, error)    { return processIdentity{}, unsupported }
func peerCredentials(*net.UnixConn) (processIdentity, error) { return processIdentity{}, unsupported }
func validateAuthCode(config) error                          { return unsupported }
func inspectProcess(int) (processIdentity, error)            { return processIdentity{}, unsupported }
func protectedPath(string, uint32, bool, bool) error         { return unsupported }
func checkPrivateFile(string, string, uint32) error          { return unsupported }
func verifySocket(string, config) error                      { return unsupported }
func inspectBrokerProcess(int) (processIdentity, error)      { return processIdentity{}, unsupported }
func verifyBrokerPeer(*net.UnixConn, config) (string, error) { return "", unsupported }
func nativeSupported() bool                                  { return false }

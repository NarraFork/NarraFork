//go:build linux

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"
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

// SO_PEERCRED is obtained from the kernel, never from a request field.
// Linux unix(7): credentials belong to the process at connect/listen time.
// Primary references: https://man7.org/linux/man-pages/man7/unix.7.html
// https://man7.org/linux/man-pages/man5/proc_pid_exe.5.html
// https://docs.kernel.org/userspace-api/no_new_privs.html
func peerCredentials(conn *net.UnixConn) (processIdentity, error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return processIdentity{}, err
	}
	var cred *syscall.Ucred
	var inner error
	err = raw.Control(func(fd uintptr) {
		cred, inner = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	})
	if err != nil {
		return processIdentity{}, err
	}
	if inner != nil {
		return processIdentity{}, inner
	}
	return processIdentity{PID: int(cred.Pid), UID: cred.Uid}, nil
}
func peerIdentity(conn *net.UnixConn) (processIdentity, error) {
	cred, err := peerCredentials(conn)
	if err != nil {
		return processIdentity{}, err
	}
	p, err := inspectProcess(cred.PID)
	if err == nil && p.UID != cred.UID {
		err = errors.New("peer credentials changed")
	}
	return p, err
}

func readLimited(path string, limit int64) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if int64(len(b)) > limit {
		return nil, errors.New("file budget exceeded")
	}
	return b, err
}

func inspectProcess(pid int) (processIdentity, error) { return inspectNativeProcess(pid, 0, true) }
func inspectBrokerProcess(pid int) (processIdentity, error) {
	return inspectNativeProcess(pid, 1<<19, true)
}
func inspectNativeProcess(pid int, allowedCapabilities uint64, executable bool) (processIdentity, error) {
	p := processIdentity{PID: pid}
	base := fmt.Sprintf("/proc/%d", pid)
	info, err := os.Stat(base)
	if err != nil {
		return p, err
	}
	p.UID = info.Sys().(*syscall.Stat_t).Uid
	stat, err := readLimited(base+"/stat", 16384)
	if err != nil {
		return p, err
	}
	end := strings.LastIndex(string(stat), ") ")
	if end < 0 {
		return p, errors.New("invalid proc stat")
	}
	fields := strings.Fields(string(stat)[end+2:])
	if len(fields) < 20 {
		return p, errors.New("short proc stat")
	}
	p.ParentPID, err = strconv.Atoi(fields[1])
	if err != nil {
		return p, err
	}
	p.StartTime = fields[19] // field 22 (starttime), after pid and comm.
	status, err := readLimited(base+"/status", 16384)
	if err != nil {
		return p, err
	}
	seen := map[string]bool{}
	for _, line := range strings.Split(string(status), "\n") {
		if strings.HasPrefix(line, "NoNewPrivs:") {
			seen["NoNewPrivs:"] = true
			fields := strings.Fields(line)
			if len(fields) != 2 {
				return p, errors.New("invalid no-new-privileges state")
			}
			p.NoNewPrivileges = fields[1] == "1"
		}
		if strings.HasPrefix(line, "Uid:") {
			seen["Uid:"] = true
			ids := strings.Fields(line)[1:]
			if len(ids) != 4 {
				return p, errors.New("invalid uid credentials")
			}
			for _, id := range ids {
				if id != strconv.FormatUint(uint64(p.UID), 10) {
					return p, errors.New("setuid process forbidden")
				}
			}
		}
		if strings.HasPrefix(line, "CapEff:") || strings.HasPrefix(line, "CapPrm:") || strings.HasPrefix(line, "CapAmb:") {
			x := strings.Fields(line)
			if len(x) != 2 {
				return p, errors.New("invalid capabilities")
			}
			seen[x[0]] = true
			cap, e := strconv.ParseUint(x[1], 16, 64)
			if e != nil || cap & ^allowedCapabilities != 0 {
				return p, errors.New("privileged process forbidden")
			}
			switch x[0] {
			case "CapEff:":
				p.EffectiveCapabilities = cap
			case "CapPrm:":
				p.PermittedCapabilities = cap
			case "CapAmb:":
				p.AmbientCapabilities = cap
			}
		}
	}
	if len(seen) != 5 {
		return p, errors.New("kernel process token context unavailable")
	}
	if executable {
		p.Exe, err = os.Readlink(base + "/exe")
		if err != nil {
			return p, err
		}
		if !filepath.IsAbs(p.Exe) || strings.HasSuffix(p.Exe, " (deleted)") {
			return p, errors.New("unregistered executable")
		}
		f, err := os.Open(base + "/exe")
		if err != nil {
			return p, err
		}
		defer f.Close()
		h := sha256.New()
		n, err := io.Copy(h, io.LimitReader(f, 256*1024*1024+1))
		if err != nil || n > 256*1024*1024 {
			return p, errors.New("executable hash budget exceeded")
		}
		p.ExeSHA256 = hex.EncodeToString(h.Sum(nil))
	}
	again, err := readLimited(base+"/stat", 16384)
	if err != nil {
		return p, errors.New("process vanished")
	}
	end = strings.LastIndex(string(again), ") ")
	if end < 0 || len(strings.Fields(string(again)[end+2:])) < 20 || strings.Fields(string(again)[end+2:])[19] != p.StartTime {
		return p, errors.New("process identity changed")
	}
	return p, nil
}

// Root/admin-controlled ancestors are checked individually; symlinks, writable
// ancestors, non-regular files and broker-owned installation/config are rejected.
// owner is allowed only for the final private service file/directory.
func protectedPath(path string, owner uint32, directory bool, private bool) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return errors.New("absolute clean path required")
	}
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	cur := "/"
	for i, part := range append([]string{""}, parts...) {
		if part != "" {
			cur = filepath.Join(cur, part)
		}
		info, err := os.Lstat(cur)
		if err != nil {
			return err
		}
		last := i == len(parts)
		st, ok := info.Sys().(*syscall.Stat_t)
		if !ok || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("symlink or unknown ownership")
		}
		if !last {
			if !info.IsDir() || st.Uid != 0 || info.Mode().Perm()&0022 != 0 {
				return errors.New("unsafe administrator ancestor")
			}
			continue
		}
		if st.Uid != owner || info.Mode().Perm()&0022 != 0 {
			return errors.New("unsafe final ownership or mode")
		}
		if directory != info.IsDir() || (!directory && !info.Mode().IsRegular()) {
			return errors.New("unexpected object type")
		}
		if private && info.Mode().Perm()&0077 != 0 {
			return errors.New("private service object is accessible to other identities")
		}
	}
	return nil
}

func checkPrivateFile(path, dir string, uid uint32) error {
	if filepath.Dir(path) != dir {
		return errors.New("private file outside service directory")
	}
	if err := protectedPath(dir, uid, true, true); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || st.Uid != uid || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || st.Nlink != 1 {
		return errors.New("unsafe private file")
	}
	return nil
}

func verifySocket(path string, c config) error {
	if err := protectedPath(filepath.Dir(path), c.BrokerUID, true, false); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok || info.Mode()&os.ModeSocket == 0 || st.Uid != c.BrokerUID || st.Gid != c.AuthGID || info.Mode().Perm() != 0660 {
		return errors.New("unsafe socket owner, group or mode")
	}
	return nil
}

// Bound the protected installation walk. A mutable workspace cannot be enrolled
// as the authority code installation. No symlink-based dependency escape is allowed.
func validateAuthCode(c config) error {
	if err := protectedPath(c.AuthCodeRoot, 0, true, false); err != nil {
		return err
	}
	if err := protectedPath(c.AuthEntry, 0, false, false); err != nil {
		return err
	}
	rel, err := filepath.Rel(c.AuthCodeRoot, c.AuthEntry)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return errors.New("auth entry outside protected code root")
	}
	count := 0
	deadline := time.Now().Add(2 * time.Second)
	err = filepath.WalkDir(c.AuthCodeRoot, func(path string, d os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		count++
		if count > 8192 || time.Now().After(deadline) {
			return errors.New("auth code installation inspection budget exceeded")
		}
		info, e := d.Info()
		if e != nil {
			return e
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		if !ok || st.Uid != 0 || info.Mode().Perm()&0022 != 0 || info.Mode()&os.ModeSymlink != 0 || (!info.IsDir() && !info.Mode().IsRegular()) {
			return errors.New("mutable auth code installation")
		}
		return nil
	})
	if err != nil {
		return err
	}
	cmd, err := readLimited(fmt.Sprintf("/proc/%d/cmdline", c.AuthProcess.PID), 65536)
	if err != nil {
		return err
	}
	args := strings.Split(strings.TrimSuffix(string(cmd), "\x00"), "\x00")
	// Deliberately require a bundled entry, no eval/loader/preload/flags. Deployment
	// supplies a root-owned immutable bundle rather than interpreter source in cwd.
	if len(args) != 2 || args[0] != c.AuthProcess.Exe || args[1] != c.AuthEntry {
		return errors.New("auth service command is not protected bundled entry")
	}
	return nil
}

// Ordinary auth callers cannot dereference /proc/<other uid>/exe. Here verify
// only actual kernel UID/PID/starttime/token against root enrollment; the pinned
// Ed25519 challenge proof separately binds the daemon's native self executable.
// No inaccessible exe is invented as an OS fact.
func verifyBrokerPeer(conn *net.UnixConn, c config) (string, error) {
	cred, e := peerCredentials(conn)
	if e != nil || cred.UID != c.BrokerUID || cred.PID != c.BrokerProcess.PID {
		return "", errors.New("server kernel peer mismatch")
	}
	actual, e := inspectNativeProcess(cred.PID, 1<<19, false)
	if e != nil {
		return "", e
	}
	expected := c.BrokerProcess
	expected.Exe = ""
	expected.ExeSHA256 = ""
	if !equalProcess(actual, expected) {
		return "", errors.New("server creation/token identity mismatch")
	}
	raw, e := canonical(actual)
	if e != nil {
		return "", e
	}
	return digest(raw), nil
}

func nativeSupported() bool { return true }

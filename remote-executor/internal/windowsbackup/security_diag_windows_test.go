//go:build windows

package windowsbackup

import (
	"fmt"
	"golang.org/x/sys/windows"
	"unsafe"
)

// All SD components are represented only by sizes/hashes and integer flags.
// SID/ACE/SD contents are deliberately never formatted or converted to SDDL.
func redactedSecurityDiagnostic(expected, current *Snapshot) []string {
	a, ae := descriptor(expected.Security)
	b, be := descriptor(current.Security)
	if ae != nil || be != nil {
		return []string{fmt.Sprintf("Security.decode: expectedValid=%t currentValid=%t", ae == nil, be == nil)}
	}
	ac, ar, ae := a.Control()
	bc, br, be := b.Control()
	output := []string{fmt.Sprintf("Security.control: equal=%t expected=0x%04x current=0x%04x changedBits=0x%04x expectedRevision=%d currentRevision=%d valid=%t", ac == bc, ac, bc, ac^bc, ar, br, ae == nil && be == nil)}
	owner, od, oe := a.Owner()
	owner2, od2, oe2 := b.Owner()
	group, gd, ge := a.Group()
	group2, gd2, ge2 := b.Group()
	sidBytes := func(s *windows.SID) []byte {
		if s == nil {
			return nil
		}
		return unsafe.Slice((*byte)(unsafe.Pointer(s)), s.Len())
	}
	component := func(name string, x, y []byte, defaulted, defaulted2 bool, valid bool) {
		output = append(output, fmt.Sprintf("Security.%s: equal=%t expected(len=%d sha256=%s defaulted=%t) current(len=%d sha256=%s defaulted=%t) valid=%t", name, Digest(x) == Digest(y) && defaulted == defaulted2, len(x), Digest(x), defaulted, len(y), Digest(y), defaulted2, valid))
	}
	component("owner", sidBytes(owner), sidBytes(owner2), od, od2, oe == nil && oe2 == nil)
	component("group", sidBytes(group), sidBytes(group2), gd, gd2, ge == nil && ge2 == nil)
	aclBytes := func(acl *windows.ACL) []byte {
		if acl == nil {
			return nil
		}
		size := int(*(*uint16)(unsafe.Add(unsafe.Pointer(acl), 2)))
		return unsafe.Slice((*byte)(unsafe.Pointer(acl)), size)
	}
	d, dd, de := a.DACL()
	d2, dd2, de2 := b.DACL()
	s, sd, se := a.SACL()
	s2, sd2, se2 := b.SACL()
	component("DACL", aclBytes(d), aclBytes(d2), dd, dd2, de == nil && de2 == nil)
	component("SACL", aclBytes(s), aclBytes(s2), sd, sd2, se == nil && se2 == nil)
	output = append(output, fmt.Sprintf("Security.DACL.control: expected=0x%04x current=0x%04x", ac&0x150c, bc&0x150c), fmt.Sprintf("Security.SACL.control: expected=0x%04x current=0x%04x", ac&0x2a30, bc&0x2a30))
	return output
}

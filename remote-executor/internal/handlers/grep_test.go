package handlers

import (
	"strings"
	"testing"
)

func intPtr(v int) *int { return &v }

func TestBuildGrepFallbackArgv(t *testing.T) {
	tests := []struct {
		name  string
		gp    grepParams
		isDir bool
		want  []string
	}{
		{
			name:  "content dir with line numbers",
			gp:    grepParams{pattern: "foo", searchPath: "/work", outputMode: "content", showLineNumbers: true},
			isDir: true,
			want:  []string{"grep", "-E", "-s", "-I", "-r", "-n", "-e", "foo", "--", "/work"},
		},
		{
			name:  "single file omits -r",
			gp:    grepParams{pattern: "foo", searchPath: "/work/a.txt", outputMode: "content"},
			isDir: false,
			want:  []string{"grep", "-E", "-s", "-I", "-e", "foo", "--", "/work/a.txt"},
		},
		{
			name:  "count mode",
			gp:    grepParams{pattern: "x", searchPath: "/work", outputMode: "count"},
			isDir: true,
			want:  []string{"grep", "-E", "-s", "-I", "-r", "-c", "-e", "x", "--", "/work"},
		},
		{
			name:  "files_with_matches + case insensitive + glob on dir",
			gp:    grepParams{pattern: "x", searchPath: "/work", outputMode: "files_with_matches", caseInsensitive: true, glob: "*.go"},
			isDir: true,
			want:  []string{"grep", "-E", "-s", "-I", "-r", "-l", "-i", "--include=*.go", "-e", "x", "--", "/work"},
		},
		{
			name:  "glob dropped for single file",
			gp:    grepParams{pattern: "x", searchPath: "/work/a.go", outputMode: "content", glob: "*.go"},
			isDir: false,
			want:  []string{"grep", "-E", "-s", "-I", "-e", "x", "--", "/work/a.go"},
		},
		{
			name:  "context lines",
			gp:    grepParams{pattern: "x", searchPath: "/work", outputMode: "content", contextLines: intPtr(2)},
			isDir: true,
			want:  []string{"grep", "-E", "-s", "-I", "-r", "-C", "2", "-e", "x", "--", "/work"},
		},
		{
			name:  "before/after context",
			gp:    grepParams{pattern: "x", searchPath: "/work", outputMode: "content", beforeContext: intPtr(1), afterContext: intPtr(3)},
			isDir: true,
			want:  []string{"grep", "-E", "-s", "-I", "-r", "-B", "1", "-A", "3", "-e", "x", "--", "/work"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildGrepFallbackArgv("grep", tt.gp, tt.isDir)
			if strings.Join(got, " ") != strings.Join(tt.want, " ") {
				t.Errorf("argv mismatch\n got: %v\nwant: %v", got, tt.want)
			}
		})
	}
}

func TestStripZeroCountLines(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{"path zero stripped", "a.txt:3\nb.txt:0\nc.txt:5\n", "a.txt:3\nc.txt:5\n"},
		{"bare zero stripped", "0\n", ""},
		{"bare nonzero kept", "7\n", "7\n"},
		{"all zero", "a:0\nb:0\n", ""},
		// The kept line retains the newline that separated it from the
		// stripped trailing line — matches the server-side TS reference.
		{"trailing zero line stripped keeps separator newline", "a:2\nb:0", "a:2\n"},
		{"count value ending in zero kept", "a.txt:10\n", "a.txt:10\n"},
		{"empty input", "", ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := string(stripZeroCountLines([]byte(tt.in)))
			if got != tt.want {
				t.Errorf("stripZeroCountLines(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

func TestBuildRipgrepArgv(t *testing.T) {
	gp := grepParams{pattern: "foo", searchPath: "/work", outputMode: "content", showLineNumbers: true, caseInsensitive: true}
	got := buildRipgrepArgv("rg", gp)
	want := []string{"rg", "--hidden", "--no-messages", "-n", "-i", "--regexp", "foo", "/work"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("argv mismatch\n got: %v\nwant: %v", got, want)
	}
}

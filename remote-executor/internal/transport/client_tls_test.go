package transport

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/narrafork/remote-executor/internal/config"
	"github.com/narrafork/remote-executor/internal/handlers"
	"github.com/narrafork/remote-executor/internal/rpc"
)

type testCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pem  []byte
	path string
}

func newTestCA(t *testing.T) testCA {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "executor test CA"},
		NotBefore: now.Add(-24 * time.Hour), NotAfter: now.Add(24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	data := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	path := filepath.Join(t.TempDir(), "server-ca.pem")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return testCA{cert: cert, key: key, pem: data, path: path}
}

func (ca testCA) serverCertificate(t *testing.T, hostnameValid bool, before, after time.Time) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "executor test server"},
		NotBefore: before, NotAfter: after,
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames: []string{"wrong.example.test"},
	}
	if hostnameValid {
		template.IPAddresses = []net.IP{net.ParseIP("127.0.0.1")}
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

func reverseTLSConfig(serverURL, caPath string) *config.Config {
	return &config.Config{ServerURL: serverURL, CAFile: caPath, DeviceRef: "test-device", Token: "rdev_test", ReconnectMaxSeconds: 1}
}

func TestReverseCATLSVerification(t *testing.T) {
	ca, otherCA := newTestCA(t), newTestCA(t)
	legacyPath, legacyKeyPath := writeSelfSignedCertificate(t)
	legacy, err := tls.LoadX509KeyPair(legacyPath, legacyKeyPath)
	if err != nil {
		t.Fatal(err)
	}
	legacyLeaf, err := x509.ParseCertificate(legacy.Certificate[0])
	if err != nil || legacyLeaf.IsCA {
		t.Fatalf("legacy fixture must be a self-signed non-CA leaf: %v", err)
	}
	now := time.Now()
	for _, tc := range []struct {
		name      string
		caPath    string
		hostValid bool
		before    time.Time
		after     time.Time
		failure   string
		legacy    bool
	}{
		{"trusted issuer", ca.path, true, now.Add(-time.Hour), now.Add(time.Hour), "", false},
		{"unknown issuer", otherCA.path, true, now.Add(-time.Hour), now.Add(time.Hour), "issuer", false},
		{"system only rejects private issuer", "", true, now.Add(-time.Hour), now.Add(time.Hour), "issuer", false},
		{"hostname mismatch", ca.path, false, now.Add(-time.Hour), now.Add(time.Hour), "hostname", false},
		{"expired", ca.path, true, now.Add(-2 * time.Hour), now.Add(-time.Hour), "validity", false},
		{"not yet valid", ca.path, true, now.Add(time.Hour), now.Add(2 * time.Hour), "validity", false},
		{"legacy self-signed non-CA leaf trusted explicitly", legacyPath, true, now.Add(-time.Hour), now.Add(time.Hour), "", true},
		{"legacy self-signed non-CA leaf untrusted by default", "", true, now.Add(-time.Hour), now.Add(time.Hour), "issuer", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hellos := make(chan rpc.HelloFrame, 1)
			server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := websocket.Accept(w, r, nil)
				if err != nil {
					return
				}
				defer conn.CloseNow()
				_, data, err := conn.Read(r.Context())
				if err != nil {
					return
				}
				var hello rpc.HelloFrame
				if json.Unmarshal(data, &hello) != nil {
					return
				}
				hellos <- hello
				_ = writeJSON(r.Context(), conn, rpc.HelloAckFrame{Type: "hello_ack", OK: true, SessionID: "tls-test"})
			}))
			server.Config.ErrorLog = log.New(io.Discard, "", 0)
			cert := ca.serverCertificate(t, tc.hostValid, tc.before, tc.after)
			if tc.legacy {
				cert = legacy
			}
			server.TLS = &tls.Config{Certificates: []tls.Certificate{cert}}
			server.StartTLS()
			defer server.Close()

			cfg := reverseTLSConfig(strings.Replace(server.URL, "https://", "wss://", 1), tc.caPath)
			httpClient, err := newReverseHTTPClient(cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer httpClient.CloseIdleConnections()
			client := NewClient(cfg, rpc.NewDispatcher(handlers.New(handlers.NewPathGuard(nil), 1024)), rpc.Platform{}, rpc.Capabilities{})
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			err = client.connectAndServe(ctx, httpClient)
			if tc.failure == "" {
				select {
				case hello := <-hellos:
					if hello.Token != cfg.Token || hello.DeviceRef != cfg.DeviceRef {
						t.Fatalf("incorrect hello: %+v", hello)
					}
				default:
					t.Fatalf("trusted issuer did not complete TLS and send hello: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatal("untrusted certificate unexpectedly accepted")
			}
			var issuerError x509.UnknownAuthorityError
			var hostError x509.HostnameError
			var validityError x509.CertificateInvalidError
			switch tc.failure {
			case "issuer":
				if !errors.As(err, &issuerError) {
					t.Fatalf("expected unknown authority error, got %v", err)
				}
			case "hostname":
				if !errors.As(err, &hostError) {
					t.Fatalf("expected hostname error, got %v", err)
				}
			case "validity":
				if !errors.As(err, &validityError) || validityError.Reason != x509.Expired {
					t.Fatalf("expected certificate validity error, got %v", err)
				}
			}
			select {
			case <-hellos:
				t.Fatal("registration token sent despite invalid TLS certificate")
			default:
			}
		})
	}
}

func TestReverseCAInvalidFilesFailBeforeReconnect(t *testing.T) {
	ca := newTestCA(t)
	for _, tc := range []struct {
		name string
		data []byte
		kind string
	}{
		{name: "missing", kind: "missing"},
		{name: "directory", kind: "directory"},
		{name: "empty", data: []byte(" \n")},
		{name: "not PEM", data: []byte("not a certificate")},
		{name: "invalid DER", data: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: []byte("invalid")})},
		{name: "wrong PEM type", data: pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: []byte("invalid")})},
		{name: "trailing garbage", data: append(bytes.Clone(ca.pem), []byte("garbage")...)},
		{name: "malformed before valid", data: append([]byte("-----BEGIN CERTIFICATE-----\ninvalid\n"), ca.pem...)},
		{name: "oversized", data: bytes.Repeat([]byte("x"), maxCAFileBytes+1)},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "ca.pem")
			switch tc.kind {
			case "missing":
			case "directory":
				if err := os.Mkdir(path, 0o700); err != nil {
					t.Fatal(err)
				}
			default:
				if err := os.WriteFile(path, tc.data, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			client := NewClient(reverseTLSConfig("wss://127.0.0.1:1/ws/device", path), nil, rpc.Platform{}, rpc.Capabilities{})
			ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
			defer cancel()
			err := client.Run(ctx)
			if err == nil || !strings.Contains(err.Error(), "caFile") || errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("invalid CA must fail startup without entering reconnect loop: %v", err)
			}
		})
	}
}

func TestReverseCARootsIncludeSystemRootsAndCacheFile(t *testing.T) {
	ca, secondCA := newTestCA(t), newTestCA(t)
	if err := os.WriteFile(ca.path, append(bytes.Clone(ca.pem), secondCA.pem...), 0o600); err != nil {
		t.Fatal(err)
	}
	client, err := newReverseHTTPClient(reverseTLSConfig("wss://localhost/ws/device", ca.path))
	if err != nil {
		t.Fatal(err)
	}
	defer client.CloseIdleConnections()
	want, err := x509.SystemCertPool()
	if err != nil {
		t.Fatal(err)
	}
	want.AddCert(ca.cert)
	want.AddCert(secondCA.cert)
	transport := client.Transport.(*http.Transport)
	if !transport.TLSClientConfig.RootCAs.Equal(want) {
		t.Fatal("CA bundle must extend, not replace, system roots")
	}
	if err := os.Remove(ca.path); err != nil {
		t.Fatal(err)
	}
	if !transport.TLSClientConfig.RootCAs.Equal(want) {
		t.Fatal("initialized client must retain its loaded CA snapshot")
	}
}

func TestReverseReconnectReusesLoadedCA(t *testing.T) {
	ca := newTestCA(t)
	connections := make(chan *websocket.Conn, 2)
	releaseHandlers := make(chan struct{})
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		if _, _, err := conn.Read(r.Context()); err != nil {
			return
		}
		if err := writeJSON(r.Context(), conn, rpc.HelloAckFrame{Type: "hello_ack", OK: true, SessionID: "reconnect-tls"}); err != nil {
			return
		}
		connections <- conn
		<-releaseHandlers
	}))
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	now := time.Now()
	server.TLS = &tls.Config{Certificates: []tls.Certificate{ca.serverCertificate(t, true, now.Add(-time.Hour), now.Add(time.Hour))}}
	server.StartTLS()
	defer server.Close()
	defer close(releaseHandlers)
	cfg := reverseTLSConfig(strings.Replace(server.URL, "https://", "wss://", 1), ca.path)
	client := NewClient(cfg, rpc.NewDispatcher(handlers.New(handlers.NewPathGuard(nil), 1024)), rpc.Platform{}, rpc.Capabilities{})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() { result <- client.Run(ctx) }()
	var first *websocket.Conn
	select {
	case first = <-connections:
	case <-ctx.Done():
		t.Fatal("first TLS connection did not complete")
	}
	if err := os.Remove(ca.path); err != nil {
		t.Fatal(err)
	}
	first.CloseNow()
	select {
	case <-connections:
	case <-ctx.Done():
		t.Fatal("reconnect reread the missing CA file instead of reusing loaded roots")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("unexpected client shutdown: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("client did not stop after cancellation")
	}
}

func TestReverseTLSClonesDefaultTransport(t *testing.T) {
	original := http.DefaultTransport
	base := original.(*http.Transport).Clone()
	proxy, err := url.Parse("http://127.0.0.1:12345")
	if err != nil {
		t.Fatal(err)
	}
	base.Proxy = http.ProxyURL(proxy)
	base.TLSHandshakeTimeout = 7 * time.Second
	base.ResponseHeaderTimeout = 13 * time.Second
	base.MaxIdleConns = 17
	base.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	http.DefaultTransport = base
	t.Cleanup(func() { http.DefaultTransport = original })
	ca := newTestCA(t)
	for _, insecure := range []bool{false, true} {
		cfg := reverseTLSConfig("wss://localhost/ws/device", ca.path)
		if insecure {
			cfg.CAFile = ""
			cfg.InsecureSkipVerify = true
		}
		client, err := newReverseHTTPClient(cfg)
		if err != nil {
			t.Fatal(err)
		}
		defer client.CloseIdleConnections()
		transport := client.Transport.(*http.Transport)
		if transport == base || transport.Proxy == nil || transport.DialContext == nil ||
			transport.TLSHandshakeTimeout != base.TLSHandshakeTimeout || transport.ResponseHeaderTimeout != base.ResponseHeaderTimeout ||
			transport.MaxIdleConns != base.MaxIdleConns || transport.IdleConnTimeout != base.IdleConnTimeout || transport.ForceAttemptHTTP2 != base.ForceAttemptHTTP2 {
			t.Fatal("TLS customization lost default transport behavior or mutated the original")
		}
		got, err := transport.Proxy(&http.Request{URL: &url.URL{Scheme: "https", Host: "localhost"}})
		if err != nil || got.String() != proxy.String() {
			t.Fatalf("proxy changed: %v, %v", got, err)
		}
		if transport.TLSClientConfig.InsecureSkipVerify != insecure || base.TLSClientConfig.InsecureSkipVerify ||
			transport.TLSClientConfig == base.TLSClientConfig || transport.TLSClientConfig.MinVersion != tls.VersionTLS12 || base.TLSClientConfig.RootCAs != nil {
			t.Fatal("TLS verification mode incorrect or shared default transport mutated")
		}
	}
}

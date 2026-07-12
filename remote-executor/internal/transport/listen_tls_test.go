package transport

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/narrafork/remote-executor/internal/config"
	"github.com/narrafork/remote-executor/internal/handlers"
	"github.com/narrafork/remote-executor/internal/rpc"
)

func TestDirectTLSServerEndToEnd(t *testing.T) {
	const token = "rdev_direct_tls_test"
	certPath, keyPath := writeSelfSignedCertificate(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("reserve listen address: %v", err)
	}
	addr := listener.Addr().String()
	_ = listener.Close()

	root := t.TempDir()
	cfg := &config.Config{
		ListenAddr: addr,
		DeviceRef:  "direct-tls-device",
		Token:      token,
		TLSCert:    certPath,
		TLSKey:     keyPath,
		AllowRoots: []string{root},
		DefaultCwd: root,
	}
	server := NewServer(
		cfg,
		rpc.NewDispatcher(handlers.New(handlers.NewPathGuard(cfg.AllowRoots), 10*1024*1024)),
		rpc.Platform{OS: "linux", Arch: "amd64"},
		rpc.Capabilities{},
	)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	serverErr := make(chan error, 1)
	go func() { serverErr <- server.Run(ctx) }()
	if !waitForPort(addr, 3*time.Second) {
		select {
		case err := <-serverErr:
			t.Fatalf("TLS listener failed: %v", err)
		default:
			t.Fatal("TLS listener did not start")
		}
	}

	legacyClient := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{
		InsecureSkipVerify: true,
		MaxVersion:         tls.VersionTLS11,
	}}}
	legacyCtx, legacyCancel := context.WithTimeout(context.Background(), 3*time.Second)
	legacyConn, _, legacyErr := websocket.Dial(
		legacyCtx,
		fmt.Sprintf("wss://%s/ws/device", addr),
		&websocket.DialOptions{HTTPClient: legacyClient},
	)
	legacyCancel()
	if legacyErr == nil {
		legacyConn.CloseNow()
		t.Fatal("TLS 1.1 client unexpectedly connected")
	}

	// The certificate is generated for this test and is not in the host trust
	// store. Skipping verification here only lets the test exercise the executor's
	// actual wss listener; production clients should trust the configured CA.
	httpClient := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{
		InsecureSkipVerify: true,
		MinVersion:         tls.VersionTLS12,
	}}}
	dialCtx, dialCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer dialCancel()
	conn, _, err := websocket.Dial(dialCtx, fmt.Sprintf("wss://%s/ws/device", addr), &websocket.DialOptions{
		HTTPClient:      httpClient,
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		t.Fatalf("dial TLS executor: %v", err)
	}
	defer conn.CloseNow()

	handshakeCtx, handshakeCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer handshakeCancel()
	performDirectHandshake(t, handshakeCtx, conn, token)
}

func writeSelfSignedCertificate(t *testing.T) (certPath string, keyPath string) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate TLS key: %v", err)
	}
	now := time.Now()
	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "narrafork-executor-test"},
		NotBefore:    now.Add(-time.Minute),
		NotAfter:     now.Add(time.Hour),
		KeyUsage:     x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("create TLS certificate: %v", err)
	}
	dir := t.TempDir()
	certPath = filepath.Join(dir, "cert.pem")
	keyPath = filepath.Join(dir, "key.pem")
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	if err := os.WriteFile(certPath, certPEM, 0o644); err != nil {
		t.Fatalf("write TLS certificate: %v", err)
	}
	if err := os.WriteFile(keyPath, keyPEM, 0o600); err != nil {
		t.Fatalf("write TLS private key: %v", err)
	}
	return certPath, keyPath
}

//go:build windows

package windowsbackup

import (
	"context"
	"fmt"
	"os"
	"runtime"
)

// Private IPC outcomes are never public completion claims. Only an independently
// verified captured-domain envelope can make the public capture RPC successful.
type firstCapturePipeOutcome struct {
	Attestation                                   FirstCaptureEnvelope
	NativeTerminal, ResourcesTerminal, Dispatched bool
}

func (c *PipeClient) firstPreauthorize(ctx context.Context, o FirstCaptureOrigin, p FirstCapturePreauthorizeParams, tokenDigest string, expiry uint64, file *os.File) (firstCapturePipeOutcome, error) {
	defer runtime.KeepAlive(file)
	if file == nil {
		return firstCapturePipeOutcome{}, ErrFirstCaptureNotReady
	}
	trace := &firstPipeExchangeState{}
	response, err := c.exchange(ctx, PipeRequest{Operation: "first_preauthorize", Version: 1, OrdinaryHandle: uint64(file.Fd()), FirstOrigin: &o, FirstPreauthorize: &p, FirstTokenDigest: tokenDigest, FirstExpiry: expiry}, trace)
	out := firstCapturePipeOutcome{Dispatched: trace.Dispatched}
	if response != nil {
		out.NativeTerminal = response.FirstNativeTerminal
		out.ResourcesTerminal = response.FirstResourcesTerminal
		if response.FirstAttestation != nil {
			out.Attestation = *response.FirstAttestation
		}
	}
	if err != nil {
		return out, err
	}
	if response == nil || response.FirstAttestation == nil || !out.NativeTerminal {
		return out, fmt.Errorf("helper preauthorization not proven")
	}
	return out, nil
}
func (c *PipeClient) firstChallenge(ctx context.Context, o FirstCaptureOrigin, p FirstCaptureParams, request MetadataCallback, file *os.File) (*MetadataCallback, error) {
	defer runtime.KeepAlive(file)
	if file == nil || request.Action != "capture_exact" {
		return nil, ErrFirstCaptureNotReady
	}
	trace := &firstPipeExchangeState{}
	response, err := c.exchange(ctx, PipeRequest{Operation: "first_capture_challenge", Version: 1, OrdinaryHandle: uint64(file.Fd()), FirstOrigin: &o, FirstCapture: &p, Callback: &request}, trace)
	if err != nil {
		return nil, err
	}
	if response == nil || response.Callback == nil {
		return nil, ErrFirstCaptureNotReady
	}
	return response.Callback, nil
}
func (c *PipeClient) firstExecute(ctx context.Context, o FirstCaptureOrigin, p FirstCaptureParams, ticket []byte, file *os.File) (firstCapturePipeOutcome, error) {
	defer runtime.KeepAlive(file)
	if file == nil {
		return firstCapturePipeOutcome{}, ErrFirstCaptureNotReady
	}
	challenge := extractFirstCaptureChallenge(ticket)
	if !validNonce(challenge) {
		return firstCapturePipeOutcome{}, ErrFirstCaptureNotReady
	}
	trace := &firstPipeExchangeState{}
	response, err := c.exchange(ctx, PipeRequest{Operation: "first_capture", Version: 1, OrdinaryHandle: uint64(file.Fd()), FirstOrigin: &o, FirstCapture: &p, Ticket: ticket, Challenge: challenge}, trace)
	out := firstCapturePipeOutcome{Dispatched: trace.Dispatched}
	if response != nil {
		out.NativeTerminal = response.FirstNativeTerminal
		out.ResourcesTerminal = response.FirstResourcesTerminal
		if response.FirstAttestation != nil {
			out.Attestation = *response.FirstAttestation
		}
	}
	if err != nil {
		return out, err
	}
	if response == nil || response.FirstAttestation == nil || !out.NativeTerminal || !out.ResourcesTerminal {
		return out, fmt.Errorf("helper capture/duplicate lifetime completion not proven")
	}
	return out, nil
}

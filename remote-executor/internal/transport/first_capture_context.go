package transport

import (
	"context"
	"fmt"

	"github.com/narrafork/remote-executor/internal/rpc"
	"github.com/narrafork/remote-executor/internal/windowsbackup"
)

func firstCaptureMethod(method string) bool {
	return method == windowsbackup.FirstCapturePreauthorizeMethod || method == windowsbackup.FirstCaptureMethod
}
func decodeFirstCaptureFrame(raw []byte, request *rpc.RequestFrame) error {
	if err := windowsbackup.DecodeFirstCaptureObject(raw, request, windowsbackup.FirstCaptureEnvelopeBytes); err != nil {
		return err
	}
	if request.Type != "rpc" || request.WindowsFirstCaptureOrigin == nil || !firstCaptureMethod(request.Method) {
		return windowsbackup.ErrFirstCaptureNotReady
	}
	_, err := windowsbackup.WithFirstCaptureRequest(context.Background(), request.Method, request.ID, *request.WindowsFirstCaptureOrigin)
	if err != nil {
		return err
	}
	if request.Method == windowsbackup.FirstCapturePreauthorizeMethod {
		var params windowsbackup.FirstCapturePreauthorizeParams
		return windowsbackup.DecodeFirstCaptureParams(request.Params, &params)
	}
	var params windowsbackup.FirstCaptureParams
	return windowsbackup.DecodeFirstCaptureParams(request.Params, &params)
}
func (s *connectionState) firstCaptureRequestContext(ctx context.Context, request rpc.RequestFrame, entry *requestCancel) (context.Context, error) {
	if !firstCaptureMethod(request.Method) {
		if request.WindowsFirstCaptureOrigin != nil {
			return nil, fmt.Errorf("first capture origin is forbidden on another method")
		}
		return ctx, nil
	}
	if request.WindowsFirstCaptureOrigin == nil || s.metadataSession == nil || !s.metadataParentCurrent(request.ID, entry) {
		return nil, windowsbackup.ErrFirstCaptureNotReady
	}
	o := *request.WindowsFirstCaptureOrigin
	session := s.metadataSession
	if session.ConnectionID != o.ConnectionID || session.SessionID != o.SessionID || session.RuntimeGeneration != o.RuntimeGeneration {
		return nil, windowsbackup.ErrFirstCaptureNotReady
	}
	return windowsbackup.WithFirstCaptureRequest(ctx, request.Method, request.ID, o)
}

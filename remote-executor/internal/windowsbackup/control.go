package windowsbackup

import (
	"context"
	"fmt"
)

type MetadataControlSend func(context.Context, []byte) ([]byte, error)
type MetadataControlFacts struct {
	Session    Session
	OuterRPCID string
	Send       MetadataControlSend
}
type metadataControlKey struct{}

// WithMetadataControl binds the existing authenticated outer transport context.
// These facts do NOT grant actor/helper authority: the native IPC peer and the
// helper's signed challenge must independently authenticate every callback.
func WithMetadataControl(ctx context.Context, session Session, outerRPCID string, send MetadataControlSend) context.Context {
	return context.WithValue(ctx, metadataControlKey{}, MetadataControlFacts{session, outerRPCID, send})
}
func MetadataControl(ctx context.Context) (MetadataControlFacts, error) {
	facts, ok := ctx.Value(metadataControlKey{}).(MetadataControlFacts)
	if !ok || facts.Send == nil || !validID(facts.OuterRPCID, 256) || !validID(facts.Session.ConnectionID, 256) || !validID(facts.Session.SessionID, 256) {
		return MetadataControlFacts{}, fmt.Errorf("Windows metadata control callback not available")
	}
	return facts, nil
}

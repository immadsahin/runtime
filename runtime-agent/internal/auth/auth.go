// Package auth verifies the short-lived Runtime tokens minted by the Next
// control plane. The agent trusts nothing else — no GitHub/Supabase/cookies.
//
// Tokens are HS256 JWTs signed with the per-computer secret. Verification uses
// only the standard library (no JWT dependency): split, HMAC-check, decode,
// expiry-check.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"runtime-agent/internal/protocol"
)

var (
	ErrMalformed = errors.New("malformed token")
	ErrSignature = errors.New("invalid token signature")
	ErrExpired   = errors.New("token expired")
)

// Verify checks an HS256 JWT against secret and returns its claims. It fails
// closed: any structural, signature, or expiry problem is an error.
func Verify(token, secret string) (*protocol.RuntimeTokenClaims, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 || parts[0] == "" || parts[1] == "" || parts[2] == "" {
		return nil, ErrMalformed
	}

	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(parts[0] + "." + parts[1]))
	expected := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if !hmac.Equal([]byte(expected), []byte(parts[2])) {
		return nil, ErrSignature
	}

	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, ErrMalformed
	}
	var claims protocol.RuntimeTokenClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		return nil, ErrMalformed
	}
	if claims.Exp > 0 && time.Now().Unix() > claims.Exp {
		return nil, ErrExpired
	}
	return &claims, nil
}

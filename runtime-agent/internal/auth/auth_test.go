package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"testing"
	"time"

	"runtime-agent/internal/protocol"
)

const secret = "per-computer-secret"

func mint(claims protocol.RuntimeTokenClaims) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	body, _ := json.Marshal(claims)
	payload := base64.RawURLEncoding.EncodeToString(body)
	signing := header + "." + payload
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(signing))
	sig := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return signing + "." + sig
}

func validClaims() protocol.RuntimeTokenClaims {
	return protocol.RuntimeTokenClaims{
		WorkspaceID: "ws-1", ProjectID: "p-1", ComputerID: "c-1", UserID: "u-1",
		Exp: time.Now().Add(5 * time.Minute).Unix(),
	}
}

func TestVerifyAcceptsValidToken(t *testing.T) {
	claims, err := Verify(mint(validClaims()), secret)
	if err != nil {
		t.Fatalf("expected valid token, got %v", err)
	}
	if claims.WorkspaceID != "ws-1" {
		t.Fatalf("wrong workspace: %s", claims.WorkspaceID)
	}
}

func TestVerifyRejectsTamperedSignature(t *testing.T) {
	tok := mint(validClaims()) + "x"
	if _, err := Verify(tok, secret); err == nil {
		t.Fatal("expected signature failure")
	}
}

func TestVerifyRejectsWrongSecret(t *testing.T) {
	if _, err := Verify(mint(validClaims()), "other-secret"); err == nil {
		t.Fatal("expected signature failure with wrong secret")
	}
}

func TestVerifyRejectsExpired(t *testing.T) {
	c := validClaims()
	c.Exp = time.Now().Add(-time.Minute).Unix()
	if _, err := Verify(mint(c), secret); err != ErrExpired {
		t.Fatalf("expected ErrExpired, got %v", err)
	}
}

func TestVerifyRejectsMalformed(t *testing.T) {
	if _, err := Verify("not-a-jwt", secret); err != ErrMalformed {
		t.Fatalf("expected ErrMalformed, got %v", err)
	}
}

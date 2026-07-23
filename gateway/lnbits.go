package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type lnbitsClient struct {
	baseURL *url.URL
	secret  string
	client  *http.Client
}

type admission struct {
	Admitted               bool   `json:"admitted"`
	GameID                 string `json:"gameId"`
	RoomKey                string `json:"roomKey"`
	PlayerID               string `json:"playerId"`
	PlayerName             string `json:"playerName"`
	MaxPlayers             int    `json:"maxPlayers"`
	DisconnectGraceSeconds int    `json:"disconnectGraceSeconds"`
	ReturnPath             string `json:"returnPath"`
}

type apiEnvelope[T any] struct {
	OK    bool   `json:"ok"`
	Data  T      `json:"data"`
	Error string `json:"error"`
}

func newLNbitsClient(cfg config) *lnbitsClient {
	return &lnbitsClient{
		baseURL: cfg.LNbitsURL,
		secret:  cfg.ServerSecret,
		client: &http.Client{
			Timeout: 20 * time.Second,
		},
	}
}

func (c *lnbitsClient) admit(
	ctx context.Context,
	gameID string,
	ticket string,
) (admission, error) {
	var result admission
	err := c.post(
		ctx,
		gameID,
		"admit",
		map[string]any{
			"serverSecret": c.secret,
			"playerToken":  ticket,
		},
		&result,
	)
	return result, err
}

func (c *lnbitsClient) report(ctx context.Context, event serverEvent) error {
	payload := map[string]any{
		"serverSecret": c.secret,
		"eventId":      event.ID,
	}
	switch event.Kind {
	case eventKill:
		payload["killerPlayerId"] = event.KillerPlayerID
		payload["victimPlayerId"] = event.VictimPlayerID
		return c.post(ctx, event.GameID, "kill", payload, nil)
	case eventDisconnect:
		payload["playerId"] = event.PlayerID
		return c.post(ctx, event.GameID, "disconnect", payload, nil)
	default:
		return fmt.Errorf("unknown event kind %q", event.Kind)
	}
}

func (c *lnbitsClient) post(
	ctx context.Context,
	gameID string,
	action string,
	payload any,
	result any,
) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	endpoint := strings.TrimRight(c.baseURL.String(), "/") +
		"/api/v1/ext/bananabreadwasm/games/" +
		url.PathEscape(gameID) + "/server/" + action
	request, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		endpoint,
		bytes.NewReader(body),
	)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "bananabreadwasm-gateway/0.2.0")
	response, err := c.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf(
			"LNbits returned %s: %s",
			response.Status,
			strings.TrimSpace(string(responseBody)),
		)
	}
	var envelope apiEnvelope[json.RawMessage]
	if err := json.Unmarshal(responseBody, &envelope); err != nil {
		return fmt.Errorf("decode LNbits response: %w", err)
	}
	if !envelope.OK {
		return fmt.Errorf("LNbits rejected server event: %s", envelope.Error)
	}
	if result == nil || len(envelope.Data) == 0 {
		return nil
	}
	if err := json.Unmarshal(envelope.Data, result); err != nil {
		return fmt.Errorf("decode LNbits response data: %w", err)
	}
	return nil
}

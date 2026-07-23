package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type eventKind string

const (
	eventKill       eventKind = "kill"
	eventDisconnect eventKind = "disconnect"
)

type serverEvent struct {
	ID             string    `json:"id"`
	Kind           eventKind `json:"kind"`
	GameID         string    `json:"gameId"`
	KillerPlayerID string    `json:"killerPlayerId,omitempty"`
	VictimPlayerID string    `json:"victimPlayerId,omitempty"`
	PlayerID       string    `json:"playerId,omitempty"`
	Attempts       int       `json:"attempts"`
	LastError      string    `json:"lastError,omitempty"`
	CreatedAt      time.Time `json:"createdAt"`
	NextAttemptAt  time.Time `json:"nextAttemptAt"`
}

type eventJournal struct {
	mu     sync.Mutex
	path   string
	events map[string]serverEvent
	client *lnbitsClient
	wake   chan struct{}
}

func newEventJournal(path string, client *lnbitsClient) (*eventJournal, error) {
	journal := &eventJournal{
		path:   path,
		events: make(map[string]serverEvent),
		client: client,
		wake:   make(chan struct{}, 1),
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return journal, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read event journal: %w", err)
	}
	var events []serverEvent
	if err := json.Unmarshal(data, &events); err != nil {
		return nil, fmt.Errorf("decode event journal: %w", err)
	}
	for _, event := range events {
		journal.events[event.ID] = event
	}
	return journal, nil
}

func (j *eventJournal) add(event serverEvent) error {
	j.mu.Lock()
	defer j.mu.Unlock()
	if _, exists := j.events[event.ID]; exists {
		return nil
	}
	event.CreatedAt = time.Now().UTC()
	event.NextAttemptAt = event.CreatedAt
	j.events[event.ID] = event
	if err := j.saveLocked(); err != nil {
		select {
		case j.wake <- struct{}{}:
		default:
		}
		return err
	}
	select {
	case j.wake <- struct{}{}:
	default:
	}
	return nil
}

func (j *eventJournal) run(ctx context.Context) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-j.wake:
		}
		j.flush(ctx)
	}
}

func (j *eventJournal) flush(ctx context.Context) {
	now := time.Now()
	j.mu.Lock()
	pending := make([]serverEvent, 0, len(j.events))
	for _, event := range j.events {
		if !event.NextAttemptAt.After(now) {
			pending = append(pending, event)
		}
	}
	j.mu.Unlock()

	for _, event := range pending {
		callCtx, cancel := context.WithTimeout(ctx, 25*time.Second)
		err := j.client.report(callCtx, event)
		cancel()

		j.mu.Lock()
		current, exists := j.events[event.ID]
		if !exists {
			j.mu.Unlock()
			continue
		}
		if err == nil {
			delete(j.events, event.ID)
			if saveErr := j.saveLocked(); saveErr != nil {
				log.Printf("persist completed event %s: %v", event.ID, saveErr)
			}
			j.mu.Unlock()
			log.Printf("settled authoritative %s event %s", event.Kind, event.ID)
			continue
		}
		current.Attempts++
		current.LastError = err.Error()
		delay := time.Duration(1<<min(current.Attempts, 5)) * time.Second
		current.NextAttemptAt = time.Now().Add(delay)
		j.events[event.ID] = current
		if saveErr := j.saveLocked(); saveErr != nil {
			log.Printf("persist failed event %s: %v", event.ID, saveErr)
		}
		j.mu.Unlock()
		log.Printf(
			"authoritative %s event %s attempt %d failed: %v",
			event.Kind,
			event.ID,
			current.Attempts,
			err,
		)
	}
}

func (j *eventJournal) saveLocked() error {
	events := make([]serverEvent, 0, len(j.events))
	for _, event := range j.events {
		events = append(events, event)
	}
	data, err := json.MarshalIndent(events, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(j.path), 0o700); err != nil {
		return err
	}
	temp := j.path + ".tmp"
	if err := os.WriteFile(temp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(temp, j.path)
}

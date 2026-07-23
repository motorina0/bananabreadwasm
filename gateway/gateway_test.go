package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	sourconfig "github.com/cfoust/sour/pkg/config"
	"github.com/cfoust/sour/pkg/game/protocol"
	"github.com/fxamacker/cbor/v2"
)

func TestRewriteClientAdmissionMessages(t *testing.T) {
	t.Run("forces the paid room", func(t *testing.T) {
		input, err := cbor.Marshal(connectMessage{
			Op:     connectOp,
			Target: "insta",
		})
		if err != nil {
			t.Fatal(err)
		}
		output, forward, err := rewriteClientMessage(input, "alice")
		if err != nil {
			t.Fatal(err)
		}
		if !forward {
			t.Fatal("connect message was blocked")
		}
		var message connectMessage
		if err := cbor.Unmarshal(output, &message); err != nil {
			t.Fatal(err)
		}
		if message.Target != arenaTarget {
			t.Fatalf("target = %q, want %q", message.Target, arenaTarget)
		}
	})

	t.Run("blocks cluster commands", func(t *testing.T) {
		input, err := cbor.Marshal(map[string]any{
			"Op":      commandOp,
			"Command": "join insta",
			"Id":      1,
		})
		if err != nil {
			t.Fatal(err)
		}
		_, forward, err := rewriteClientMessage(input, "alice")
		if err != nil {
			t.Fatal(err)
		}
		if forward {
			t.Fatal("cluster command was forwarded")
		}
	})

	t.Run("forces identity and removes bot packets", func(t *testing.T) {
		gamePacket, err := protocol.Encode(
			protocol.Connect{Name: "mallory"},
			protocol.AddBot{NumBots: 4},
			protocol.SwitchName{Name: "eve"},
		)
		if err != nil {
			t.Fatal(err)
		}
		input, err := cbor.Marshal(packetMessage{
			Op:      packetOp,
			Channel: 1,
			Data:    gamePacket,
			Length:  len(gamePacket),
		})
		if err != nil {
			t.Fatal(err)
		}
		output, forward, err := rewriteClientMessage(
			input,
			"Ali ce!_with-too-many-characters",
		)
		if err != nil {
			t.Fatal(err)
		}
		if !forward {
			t.Fatal("game packet was blocked")
		}
		var outer packetMessage
		if err := cbor.Unmarshal(output, &outer); err != nil {
			t.Fatal(err)
		}
		messages, err := protocol.Decode(outer.Data, true)
		if err != nil {
			t.Fatal(err)
		}
		if len(messages) != 2 {
			t.Fatalf("message count = %d, want 2", len(messages))
		}
		expectedName := safePlayerName("Ali ce!_with-too-many-characters")
		connect, ok := messages[0].(protocol.Connect)
		if !ok || connect.Name != expectedName {
			t.Fatalf("connect = %#v, want forced name %q", messages[0], expectedName)
		}
		renamed, ok := messages[1].(protocol.SwitchName)
		if !ok || renamed.Name != expectedName {
			t.Fatalf("rename = %#v, want forced name %q", messages[1], expectedName)
		}
	})
}

func TestAuthoritativeDeathIsJournaledOnce(t *testing.T) {
	journalPath := filepath.Join(t.TempDir(), "events.json")
	journal, err := newEventJournal(journalPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	manager := &roomManager{journal: journal}
	killer := &playerSession{
		gameID:     "arena-1",
		playerID:   "killer-payment",
		playerName: "KILLER",
		state:      "playing",
	}
	victim := &playerSession{
		gameID:     "arena-1",
		playerID:   "victim-payment",
		playerName: "VICTIM",
		state:      "playing",
	}
	room := &room{
		gameID: "arena-1",
		players: map[int32]*playerSession{
			2: killer,
			5: victim,
		},
	}

	death := protocol.Died{Client: 5, Killer: 2}
	manager.authoritativeKill(room, death)
	manager.authoritativeKill(room, death)

	victim.mu.Lock()
	state := victim.state
	victim.mu.Unlock()
	if state != "killed" {
		t.Fatalf("victim state = %q, want killed", state)
	}
	if len(journal.events) != 1 {
		t.Fatalf("journal event count = %d, want 1", len(journal.events))
	}
	for _, event := range journal.events {
		if event.Kind != eventKill ||
			event.GameID != "arena-1" ||
			event.KillerPlayerID != "killer-payment" ||
			event.VictimPlayerID != "victim-payment" {
			t.Fatalf("unexpected event: %#v", event)
		}
	}
	data, err := os.ReadFile(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	var persisted []serverEvent
	if err := json.Unmarshal(data, &persisted); err != nil {
		t.Fatal(err)
	}
	if len(persisted) != 1 {
		t.Fatalf("persisted event count = %d, want 1", len(persisted))
	}
}

func TestAdmissionSessionIDIsStableAndScoped(t *testing.T) {
	first := admissionSessionID("a-very-long-shared-secret-value", "game-a", "ticket")
	second := admissionSessionID("a-very-long-shared-secret-value", "game-a", "ticket")
	otherGame := admissionSessionID("a-very-long-shared-secret-value", "game-b", "ticket")
	if first != second {
		t.Fatal("same admission did not produce the same session id")
	}
	if first == otherGame {
		t.Fatal("session id was not scoped to the arena")
	}
	if len(first) != 64 {
		t.Fatalf("session id length = %d, want 64", len(first))
	}
}

func TestGeneratedSourRoomConfig(t *testing.T) {
	data, err := sourRoomConfig(18999, filepath.Join(t.TempDir(), "cache"))
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "sour.json")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	parsed, err := sourconfig.Process([]string{path})
	if err != nil {
		t.Fatalf("Sour rejected generated config: %v", err)
	}
	if parsed.Server.Ingress.Web.Port != 18999 {
		t.Fatalf("web port = %d, want 18999", parsed.Server.Ingress.Web.Port)
	}
	if len(parsed.Server.Spaces) != 1 ||
		parsed.Server.Spaces[0].Config.Alias != arenaTarget {
		t.Fatalf("unexpected paid room spaces: %#v", parsed.Server.Spaces)
	}
	if len(parsed.Server.Presets) != 1 ||
		parsed.Server.Presets[0].Config.MaxClients != 5 {
		t.Fatalf("unexpected paid preset: %#v", parsed.Server.Presets)
	}
}

package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/cfoust/sour/pkg/game/protocol"
	"github.com/fxamacker/cbor/v2"
	"nhooyr.io/websocket"
)

const (
	connectOp    = 7
	commandOp    = 9
	packetOp     = 11
	arenaTarget  = "arena"
	maxWSMessage = 1 << 20
)

type relay struct {
	once    sync.Once
	cancel  context.CancelFunc
	front   *websocket.Conn
	backend *websocket.Conn
}

type wsMessage struct {
	messageType websocket.MessageType
	data        []byte
	err         error
}

type genericMessage struct {
	Op int
}

type connectMessage struct {
	Op     int
	Target string
}

type packetMessage struct {
	Op      int
	Channel int
	Data    []byte
	Length  int
}

func (relay *relay) close() {
	relay.once.Do(func() {
		relay.cancel()
		_ = relay.front.Close(websocket.StatusNormalClosure, "session replaced")
		_ = relay.backend.Close(websocket.StatusNormalClosure, "session ended")
	})
}

func (m *roomManager) serveWebsocket(
	writer http.ResponseWriter,
	request *http.Request,
	session *playerSession,
	room *room,
) {
	front, err := websocket.Accept(writer, request, &websocket.AcceptOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	front.SetReadLimit(maxWSMessage)

	ctx, cancel := context.WithCancel(m.ctx)
	backendURL := fmt.Sprintf("ws://127.0.0.1:%d/ws/", room.port)
	backend, _, err := websocket.Dial(ctx, backendURL, &websocket.DialOptions{
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		cancel()
		_ = front.Close(websocket.StatusTryAgainLater, "Sour room unavailable")
		return
	}
	backend.SetReadLimit(maxWSMessage)
	connection := &relay{
		cancel:  cancel,
		front:   front,
		backend: backend,
	}
	generation, previous := m.attachRelay(session, room, connection)
	if previous != nil {
		previous.close()
	}
	defer connection.close()

	frontMessages := readWebsocket(ctx, front)
	backendMessages := readWebsocket(ctx, backend)
	frontConnected := true
	for {
		select {
		case <-ctx.Done():
			return
		case message, open := <-frontMessages:
			if !open {
				frontMessages = nil
				continue
			}
			if message.err != nil {
				if frontConnected {
					frontConnected = false
					m.beginDisconnectGrace(session, room, connection, generation)
				}
				continue
			}
			if message.messageType != websocket.MessageBinary {
				continue
			}
			rewritten, forward, rewriteErr := rewriteClientMessage(
				message.data,
				session.playerName,
			)
			if rewriteErr != nil {
				_ = front.Close(
					websocket.StatusPolicyViolation,
					"invalid Sour protocol packet",
				)
				return
			}
			if !forward {
				continue
			}
			if err := writeWebsocket(ctx, backend, rewritten); err != nil {
				if frontConnected {
					frontConnected = false
					m.beginDisconnectGrace(
						session,
						room,
						connection,
						generation,
					)
				}
			}
		case message := <-backendMessages:
			if message.err != nil {
				if frontConnected {
					_ = front.Close(
						websocket.StatusTryAgainLater,
						"Sour room connection ended",
					)
					frontConnected = false
				}
				m.beginDisconnectGrace(session, room, connection, generation)
				return
			}
			if message.messageType != websocket.MessageBinary {
				continue
			}
			m.inspectServerMessage(room, session, message.data)
			if frontConnected {
				if err := writeWebsocket(ctx, front, message.data); err != nil {
					frontConnected = false
					m.beginDisconnectGrace(
						session,
						room,
						connection,
						generation,
					)
				}
			}
		}
	}
}

func readWebsocket(
	ctx context.Context,
	connection *websocket.Conn,
) <-chan wsMessage {
	messages := make(chan wsMessage, 1)
	go func() {
		defer close(messages)
		for {
			messageType, data, err := connection.Read(ctx)
			messages <- wsMessage{
				messageType: messageType,
				data:        data,
				err:         err,
			}
			if err != nil {
				return
			}
		}
	}()
	return messages
}

func writeWebsocket(
	parent context.Context,
	connection *websocket.Conn,
	data []byte,
) error {
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	return connection.Write(ctx, websocket.MessageBinary, data)
}

func rewriteClientMessage(data []byte, playerName string) ([]byte, bool, error) {
	var generic genericMessage
	if err := cbor.Unmarshal(data, &generic); err != nil {
		return nil, false, err
	}
	switch generic.Op {
	case commandOp:
		return nil, false, nil
	case connectOp:
		encoded, err := cbor.Marshal(connectMessage{
			Op:     connectOp,
			Target: arenaTarget,
		})
		return encoded, true, err
	case packetOp:
		var packet packetMessage
		if err := cbor.Unmarshal(data, &packet); err != nil {
			return nil, false, err
		}
		messages, err := protocol.Decode(packet.Data, true)
		if err != nil {
			return nil, false, err
		}
		filtered := make([]protocol.Message, 0, len(messages))
		for _, message := range messages {
			switch message.Type() {
			case protocol.N_ADDBOT, protocol.N_BOTLIMIT, protocol.N_DELBOT:
				continue
			}
			switch typed := message.(type) {
			case protocol.Connect:
				typed.Name = safePlayerName(playerName)
				message = typed
			case protocol.SwitchName:
				typed.Name = safePlayerName(playerName)
				message = typed
			}
			filtered = append(filtered, message)
		}
		if len(filtered) == 0 {
			return nil, false, nil
		}
		packet.Data, err = protocol.Encode(filtered...)
		if err != nil {
			return nil, false, err
		}
		packet.Length = len(packet.Data)
		encoded, err := cbor.Marshal(packet)
		return encoded, true, err
	default:
		return data, true, nil
	}
}

func (m *roomManager) inspectServerMessage(
	room *room,
	session *playerSession,
	data []byte,
) {
	var generic genericMessage
	if err := cbor.Unmarshal(data, &generic); err != nil || generic.Op != packetOp {
		return
	}
	var packet packetMessage
	if err := cbor.Unmarshal(data, &packet); err != nil {
		return
	}
	messages, err := protocol.Decode(packet.Data, false)
	if err != nil {
		log.Printf("decode Sour server packet for room %s: %v", room.gameID, err)
		return
	}
	for _, message := range messages {
		switch typed := message.(type) {
		case protocol.ServerInfo:
			m.assignClientNumber(room, session, typed.Client)
		case protocol.Died:
			m.authoritativeKill(room, typed)
		}
	}
}

func (m *roomManager) attachRelay(
	session *playerSession,
	room *room,
	connection *relay,
) (uint64, *relay) {
	session.mu.Lock()
	previous := session.active
	oldNumber := session.clientNumber
	hadOldNumber := session.hasClientNumber
	session.hasClientNumber = false
	if session.disconnectTimer != nil {
		session.disconnectTimer.Stop()
		session.disconnectTimer = nil
	}
	session.generation++
	generation := session.generation
	session.active = connection
	session.state = "connected"
	session.statusMessage = "Connected to the authoritative Sour room."
	session.mu.Unlock()
	if previous != nil {
		previous.close()
	}
	if hadOldNumber {
		room.mu.Lock()
		if room.players[oldNumber] == session {
			delete(room.players, oldNumber)
		}
		room.mu.Unlock()
	}
	return generation, nil
}

func (m *roomManager) assignClientNumber(
	room *room,
	session *playerSession,
	clientNumber int32,
) {
	session.mu.Lock()
	if session.state == "killed" || session.state == "expired" {
		session.mu.Unlock()
		return
	}
	oldNumber := session.clientNumber
	hadOldNumber := session.hasClientNumber
	session.clientNumber = clientNumber
	session.hasClientNumber = true
	session.state = "playing"
	session.statusMessage = "Playing in the paid Sour room."
	session.mu.Unlock()

	room.mu.Lock()
	if hadOldNumber {
		delete(room.players, oldNumber)
	}
	room.players[clientNumber] = session
	room.mu.Unlock()
}

func (m *roomManager) removeClientNumber(
	room *room,
	session *playerSession,
) {
	session.mu.Lock()
	clientNumber := session.clientNumber
	hadClientNumber := session.hasClientNumber
	session.hasClientNumber = false
	session.mu.Unlock()
	if hadClientNumber {
		room.mu.Lock()
		if room.players[clientNumber] == session {
			delete(room.players, clientNumber)
		}
		room.mu.Unlock()
	}
}

func (m *roomManager) authoritativeKill(room *room, death protocol.Died) {
	if death.Client == death.Killer {
		return
	}
	room.mu.Lock()
	victim := room.players[death.Client]
	killer := room.players[death.Killer]
	if victim == nil || killer == nil || victim == killer {
		room.mu.Unlock()
		return
	}
	delete(room.players, death.Client)
	room.mu.Unlock()

	victim.mu.Lock()
	if victim.state == "killed" || victim.state == "expired" {
		victim.mu.Unlock()
		return
	}
	victim.state = "killed"
	victim.statusMessage = "The Sour server confirmed your elimination."
	victim.hasClientNumber = false
	if victim.disconnectTimer != nil {
		victim.disconnectTimer.Stop()
		victim.disconnectTimer = nil
	}
	active := victim.active
	victim.mu.Unlock()

	event := serverEvent{
		ID:             newEventID("kill"),
		Kind:           eventKill,
		GameID:         room.gameID,
		KillerPlayerID: killer.playerID,
		VictimPlayerID: victim.playerID,
	}
	if err := m.journal.add(event); err != nil {
		log.Printf("persist kill event %s: %v", event.ID, err)
	}
	if active != nil {
		active.close()
	}
}

func (m *roomManager) beginDisconnectGrace(
	session *playerSession,
	room *room,
	connection *relay,
	generation uint64,
) {
	session.mu.Lock()
	if session.generation != generation ||
		session.active != connection ||
		session.state == "killed" ||
		session.state == "expired" {
		session.mu.Unlock()
		return
	}
	if session.disconnectTimer != nil {
		session.mu.Unlock()
		return
	}
	session.state = "grace"
	session.statusMessage = "Disconnected; the paid body remains live for 60 seconds."
	session.disconnectTimer = time.AfterFunc(m.cfg.GracePeriod, func() {
		m.expireDisconnected(session, room, connection, generation)
	})
	session.mu.Unlock()
}

func (m *roomManager) expireDisconnected(
	session *playerSession,
	room *room,
	connection *relay,
	generation uint64,
) {
	session.mu.Lock()
	if session.generation != generation ||
		session.active != connection ||
		session.state != "grace" {
		session.mu.Unlock()
		return
	}
	session.state = "expired"
	session.statusMessage = "Disconnect grace expired; a full refund was requested."
	session.disconnectTimer = nil
	session.hasClientNumber = false
	clientNumber := session.clientNumber
	session.mu.Unlock()

	room.mu.Lock()
	if room.players[clientNumber] == session {
		delete(room.players, clientNumber)
	}
	room.mu.Unlock()

	event := serverEvent{
		ID:       newEventID("disconnect"),
		Kind:     eventDisconnect,
		GameID:   session.gameID,
		PlayerID: session.playerID,
	}
	if err := m.journal.add(event); err != nil {
		log.Printf("persist disconnect event %s: %v", event.ID, err)
	}
	connection.close()
}

func safePlayerName(value string) string {
	runes := make([]rune, 0, 15)
	for _, char := range value {
		if (char >= 'a' && char <= 'z') ||
			(char >= 'A' && char <= 'Z') ||
			(char >= '0' && char <= '9') ||
			char == '_' ||
			char == '-' {
			runes = append(runes, char)
		}
		if len(runes) == 15 {
			break
		}
	}
	if len(runes) == 0 {
		return "PLAYER"
	}
	return string(runes)
}

func isNormalWebsocketClose(err error) bool {
	status := websocket.CloseStatus(err)
	return errors.Is(err, context.Canceled) ||
		status == websocket.StatusNormalClosure ||
		status == websocket.StatusGoingAway
}

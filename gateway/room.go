package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

type roomManager struct {
	mu       sync.Mutex
	cfg      config
	ctx      context.Context
	rooms    map[string]*room
	sessions map[string]*playerSession
	journal  *eventJournal
}

type room struct {
	mu      sync.Mutex
	gameID  string
	port    int
	process *exec.Cmd
	proxy   *httputil.ReverseProxy
	players map[int32]*playerSession
	stopped bool
}

type playerSession struct {
	mu              sync.Mutex
	id              string
	gameID          string
	playerID        string
	playerName      string
	returnURL       string
	state           string
	statusMessage   string
	clientNumber    int32
	hasClientNumber bool
	generation      uint64
	active          *relay
	disconnectTimer *time.Timer
}

func newRoomManager(
	ctx context.Context,
	cfg config,
	journal *eventJournal,
) *roomManager {
	return &roomManager{
		cfg:      cfg,
		ctx:      ctx,
		rooms:    make(map[string]*room),
		sessions: make(map[string]*playerSession),
		journal:  journal,
	}
}

func (m *roomManager) ensureRoom(gameID string) (*room, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	existing := m.rooms[gameID]
	if existing != nil && !existing.isStopped() {
		return existing, nil
	}
	if existing == nil && len(m.rooms) >= m.cfg.MaxRooms {
		return nil, fmt.Errorf("the gateway room limit has been reached")
	}
	created, err := m.startRoom(gameID)
	if err != nil {
		return nil, err
	}
	m.rooms[gameID] = created
	return created, nil
}

func (room *room) isStopped() bool {
	room.mu.Lock()
	defer room.mu.Unlock()
	return room.stopped
}

func (m *roomManager) room(gameID string) *room {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.rooms[gameID]
}

func (m *roomManager) session(id string) *playerSession {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[id]
}

func (m *roomManager) putSession(session *playerSession) {
	m.mu.Lock()
	m.sessions[session.id] = session
	m.mu.Unlock()
}

func (m *roomManager) startRoom(gameID string) (*room, error) {
	port, err := freeLoopbackPort()
	if err != nil {
		return nil, err
	}
	roomDir := filepath.Join(m.cfg.DataDir, "rooms", stablePathID(gameID))
	if err := os.MkdirAll(roomDir, 0o700); err != nil {
		return nil, fmt.Errorf("create room directory: %w", err)
	}
	configPath := filepath.Join(roomDir, "sour.json")
	configData, err := sourRoomConfig(
		port,
		filepath.Join(m.cfg.DataDir, "asset-cache"),
	)
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(configPath, configData, 0o600); err != nil {
		return nil, fmt.Errorf("write Sour room config: %w", err)
	}
	logFile, err := os.OpenFile(
		filepath.Join(roomDir, "sour.log"),
		os.O_CREATE|os.O_APPEND|os.O_WRONLY,
		0o600,
	)
	if err != nil {
		return nil, fmt.Errorf("open Sour room log: %w", err)
	}
	command := exec.CommandContext(
		m.ctx,
		m.cfg.SourBinary,
		"serve",
		configPath,
	)
	command.Dir = m.cfg.SourRoot
	command.Stdout = logFile
	command.Stderr = logFile
	if err := command.Start(); err != nil {
		logFile.Close()
		return nil, fmt.Errorf("start Sour room: %w", err)
	}
	backend, _ := url.Parse("http://127.0.0.1:" + strconv.Itoa(port))
	created := &room{
		gameID:  gameID,
		port:    port,
		process: command,
		proxy:   httputil.NewSingleHostReverseProxy(backend),
		players: make(map[int32]*playerSession),
	}
	created.proxy.ErrorHandler = func(
		writer http.ResponseWriter,
		_ *http.Request,
		proxyErr error,
	) {
		log.Printf("Sour room %s proxy error: %v", gameID, proxyErr)
		http.Error(writer, "Sour room is unavailable", http.StatusBadGateway)
	}
	go func() {
		err := command.Wait()
		logFile.Close()
		created.mu.Lock()
		created.stopped = true
		created.mu.Unlock()
		if m.ctx.Err() == nil {
			log.Printf("Sour room %s stopped: %v", gameID, err)
		}
	}()
	if err := waitForSour(m.ctx, backend); err != nil {
		if command.Process != nil {
			_ = command.Process.Kill()
		}
		return nil, fmt.Errorf("Sour room did not become ready: %w", err)
	}
	log.Printf("started Sour room %s on loopback port %d", gameID, port)
	return created, nil
}

func sourRoomConfig(port int, cacheDirectory string) ([]byte, error) {
	value := map[string]any{
		"server": map[string]any{
			"cacheDirectory": cacheDirectory,
			"assets":         []string{},
			"presets": []any{
				map[string]any{
					"name":    "paid-ffa",
					"default": true,
					"config": map[string]any{
						"maxClients":  5,
						"matchLength": 3600,
						"defaultMode": "ffa",
						"defaultMap":  "complex",
						"maps":        []string{"complex", "turbine", "dust2"},
					},
				},
			},
			"spaces": []any{
				map[string]any{
					"preset":        "paid-ffa",
					"votingCreates": false,
					"config": map[string]any{
						"alias":       "arena",
						"description": "LNbits paid BananaBread arena",
						"links":       []any{},
					},
				},
			},
			"matchmaking": map[string]any{"duel": []any{}},
			"ingress": map[string]any{
				"desktop": []any{},
				"web": map[string]any{
					"address": "127.0.0.1",
					"port":    port,
				},
			},
			"banners":        []string{},
			"bannerInterval": 3600,
		},
		"client": map[string]any{
			"servers":     []string{"#host/ws/"},
			"assets":      []string{},
			"proxy":       "#host/service/proxy/",
			"menuOptions": "",
		},
	}
	return json.MarshalIndent(value, "", "  ")
}

func freeLoopbackPort() (int, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port, nil
}

func waitForSour(ctx context.Context, backend *url.URL) error {
	client := &http.Client{Timeout: 2 * time.Second}
	deadline := time.NewTimer(90 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(300 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("timed out")
		case <-ticker.C:
			request, _ := http.NewRequestWithContext(
				ctx,
				http.MethodGet,
				backend.String()+"/",
				nil,
			)
			response, err := client.Do(request)
			if err == nil {
				response.Body.Close()
				if response.StatusCode >= 200 && response.StatusCode < 500 {
					return nil
				}
			}
		}
	}
}

func stablePathID(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:16])
}

package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"html/template"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const sessionCookieName = "bananabread_session"

type gateway struct {
	cfg     config
	lnbits  *lnbitsClient
	rooms   *roomManager
	journal *eventJournal
}

type sessionResponse struct {
	State         string `json:"state"`
	StatusMessage string `json:"statusMessage"`
	PlayerName    string `json:"playerName"`
	ReturnURL     string `json:"returnUrl"`
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	if err := validateSourInstall(cfg); err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		log.Fatalf("create data directory: %v", err)
	}
	ctx, stop := signal.NotifyContext(
		context.Background(),
		os.Interrupt,
		syscall.SIGTERM,
	)
	defer stop()
	lnbits := newLNbitsClient(cfg)
	journal, err := newEventJournal(
		filepath.Join(cfg.DataDir, "server-events.json"),
		lnbits,
	)
	if err != nil {
		log.Fatal(err)
	}
	gateway := &gateway{
		cfg:     cfg,
		lnbits:  lnbits,
		journal: journal,
	}
	gateway.rooms = newRoomManager(ctx, cfg, journal)
	go journal.run(ctx)

	server := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           gateway,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       75 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(
			context.Background(),
			15*time.Second,
		)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()
	log.Printf("BananaBread gateway listening on %s", cfg.ListenAddr)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func (g *gateway) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	switch request.URL.Path {
	case "/healthz":
		writer.Header().Set("Content-Type", "application/json")
		_, _ = writer.Write([]byte(`{"ok":true}`))
		return
	case "/lnbits/enter":
		g.handleEnter(writer, request)
		return
	case "/lnbits/play":
		g.handlePlay(writer, request)
		return
	case "/lnbits/session":
		g.handleSession(writer, request)
		return
	case "/ws/":
		session, room, ok := g.requireLiveSession(writer, request)
		if ok {
			g.rooms.serveWebsocket(writer, request, session, room)
		}
		return
	}
	session, room, ok := g.requireLiveSession(writer, request)
	if !ok {
		return
	}
	if strings.HasPrefix(request.URL.Path, "/api/") {
		http.Error(writer, "Direct Sour API access is disabled", http.StatusForbidden)
		return
	}
	_ = session
	room.proxy.ServeHTTP(writer, request)
}

func (g *gateway) handleEnter(
	writer http.ResponseWriter,
	request *http.Request,
) {
	if request.Method != http.MethodGet {
		http.Error(writer, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	gameID := strings.TrimSpace(request.URL.Query().Get("game"))
	ticket := strings.TrimSpace(request.URL.Query().Get("ticket"))
	if gameID == "" || ticket == "" || len(gameID) > 128 || len(ticket) > 128 {
		http.Error(writer, "A valid arena and admission ticket are required", http.StatusBadRequest)
		return
	}
	admission, err := g.lnbits.admit(request.Context(), gameID, ticket)
	if err != nil {
		log.Printf("admission rejected for room %s: %v", gameID, err)
		http.Error(writer, "Paid admission could not be verified", http.StatusForbidden)
		return
	}
	if !admission.Admitted ||
		admission.GameID != gameID ||
		admission.PlayerID == "" ||
		admission.MaxPlayers != 5 {
		http.Error(writer, "LNbits returned an invalid admission", http.StatusForbidden)
		return
	}
	if _, err := g.rooms.ensureRoom(gameID); err != nil {
		log.Printf("start room %s: %v", gameID, err)
		http.Error(writer, "The Sour room could not be started", http.StatusServiceUnavailable)
		return
	}
	sessionID := admissionSessionID(g.cfg.ServerSecret, gameID, ticket)
	session := g.rooms.session(sessionID)
	if session == nil {
		returnURL, err := g.returnURL(admission.ReturnPath)
		if err != nil {
			http.Error(writer, "LNbits returned an invalid lobby URL", http.StatusBadGateway)
			return
		}
		session = &playerSession{
			id:            sessionID,
			gameID:        gameID,
			playerID:      admission.PlayerID,
			playerName:    safePlayerName(admission.PlayerName),
			returnURL:     returnURL,
			state:         "admitted",
			statusMessage: "Paid admission verified. Connecting to Sour.",
		}
		g.rooms.putSession(session)
	}
	http.SetCookie(writer, &http.Cookie{
		Name:     sessionCookieName,
		Value:    sessionID,
		Path:     "/",
		MaxAge:   24 * 60 * 60,
		HttpOnly: true,
		Secure:   g.cfg.PublicURL.Scheme == "https",
		SameSite: http.SameSiteLaxMode,
	})
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Referrer-Policy", "no-referrer")
	http.Redirect(writer, request, "/lnbits/play", http.StatusSeeOther)
}

func (g *gateway) handlePlay(
	writer http.ResponseWriter,
	request *http.Request,
) {
	session, _, ok := g.requireSession(writer, request)
	if !ok {
		return
	}
	session.mu.Lock()
	playerName := session.playerName
	session.mu.Unlock()
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set(
		"Content-Security-Policy",
		"default-src 'self'; frame-src 'self'; script-src 'unsafe-inline'; "+
			"style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:",
	)
	writer.Header().Set("Referrer-Policy", "no-referrer")
	writer.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := playTemplate.Execute(writer, map[string]string{
		"PlayerName": playerName,
	}); err != nil {
		log.Printf("render play wrapper: %v", err)
	}
}

func (g *gateway) handleSession(
	writer http.ResponseWriter,
	request *http.Request,
) {
	session, _, ok := g.requireSession(writer, request)
	if !ok {
		return
	}
	session.mu.Lock()
	response := sessionResponse{
		State:         session.state,
		StatusMessage: session.statusMessage,
		PlayerName:    session.playerName,
		ReturnURL:     session.returnURL,
	}
	session.mu.Unlock()
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(writer).Encode(response)
}

func (g *gateway) requireLiveSession(
	writer http.ResponseWriter,
	request *http.Request,
) (*playerSession, *room, bool) {
	session, room, ok := g.requireSession(writer, request)
	if !ok {
		return nil, nil, false
	}
	session.mu.Lock()
	state := session.state
	session.mu.Unlock()
	if state == "killed" || state == "expired" {
		http.Error(writer, "Admission is no longer live", http.StatusGone)
		return nil, nil, false
	}
	return session, room, true
}

func (g *gateway) requireSession(
	writer http.ResponseWriter,
	request *http.Request,
) (*playerSession, *room, bool) {
	cookie, err := request.Cookie(sessionCookieName)
	if err != nil || len(cookie.Value) != 64 {
		http.Error(writer, "Paid admission is required", http.StatusUnauthorized)
		return nil, nil, false
	}
	session := g.rooms.session(cookie.Value)
	if session == nil {
		http.Error(writer, "Admission session expired", http.StatusUnauthorized)
		return nil, nil, false
	}
	room := g.rooms.room(session.gameID)
	if room == nil || room.isStopped() {
		http.Error(writer, "Sour room is unavailable", http.StatusServiceUnavailable)
		return nil, nil, false
	}
	return session, room, true
}

func (g *gateway) returnURL(returnPath string) (string, error) {
	if !strings.HasPrefix(
		returnPath,
		"/ext/bananabreadwasm/games/",
	) {
		return "", fmt.Errorf("invalid return path")
	}
	result := *g.cfg.LNbitsURL
	result.Path = returnPath
	result.RawQuery = ""
	result.Fragment = ""
	if parsed, err := url.Parse(returnPath); err == nil {
		result.Path = parsed.Path
		result.RawQuery = parsed.RawQuery
	}
	return result.String(), nil
}

func admissionSessionID(secret, gameID, ticket string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(gameID))
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(ticket))
	return hex.EncodeToString(mac.Sum(nil))
}

func newEventID(prefix string) string {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		panic(err)
	}
	return prefix + "-" + hex.EncodeToString(random)
}

func validateSourInstall(cfg config) error {
	if _, err := exec.LookPath(cfg.SourBinary); err != nil {
		return fmt.Errorf("find Sour binary: %w", err)
	}
	index := filepath.Join(cfg.SourRoot, "assets", ".index.source")
	if _, err := os.Stat(index); err != nil {
		return fmt.Errorf(
			"BANANABREAD_SOUR_ROOT must contain assets/.index.source: %w",
			err,
		)
	}
	return nil
}

var playTemplate = template.Must(template.New("play").Parse(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>BananaBread Arena</title>
  <style>
    html,body{width:100%;height:100%;margin:0;overflow:hidden;background:#05070a;color:#fff;font-family:system-ui,sans-serif}
    iframe{width:100%;height:100%;border:0}
    #status{position:fixed;z-index:10;left:16px;top:16px;max-width:min(440px,calc(100% - 64px));padding:10px 14px;border:1px solid #475165;border-radius:8px;background:rgba(10,14,20,.88);font-size:13px;pointer-events:none}
    #overlay{position:fixed;z-index:20;inset:0;display:none;place-items:center;text-align:center;background:rgba(5,7,10,.9)}
    #overlay.show{display:grid}
    a{display:inline-block;margin-top:14px;padding:12px 18px;border-radius:8px;color:#090b0f;background:#ffc247;font-weight:800;text-decoration:none}
  </style>
</head>
<body>
  <div id="status">Paid admission: {{.PlayerName}}</div>
  <div id="overlay"><div><h1 id="title">Round over</h1><p id="message"></p><a id="return" href="#">RETURN TO LOBBY</a></div></div>
  <iframe title="Sour authoritative arena" src="/#/server/arena" allow="fullscreen; gamepad" referrerpolicy="no-referrer"></iframe>
  <script>
    const status = document.querySelector('#status')
    const overlay = document.querySelector('#overlay')
    const title = document.querySelector('#title')
    const message = document.querySelector('#message')
    const returnLink = document.querySelector('#return')
    async function poll() {
      try {
        const response = await fetch('/lnbits/session', {cache: 'no-store'})
        if (!response.ok) throw new Error('session unavailable')
        const session = await response.json()
        status.textContent = session.statusMessage
        if (session.state === 'killed' || session.state === 'expired') {
          title.textContent = session.state === 'killed' ? 'You were eliminated' : 'Disconnect grace expired'
          message.textContent = session.statusMessage
          returnLink.href = session.returnUrl
          overlay.classList.add('show')
        }
      } catch (_) {
        status.textContent = 'Reconnecting to the arena gateway…'
      }
    }
    poll()
    setInterval(poll, 1200)
  </script>
</body>
</html>`))

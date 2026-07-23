package main

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type config struct {
	ListenAddr   string
	PublicURL    *url.URL
	LNbitsURL    *url.URL
	ServerSecret string
	SourBinary   string
	SourRoot     string
	DataDir      string
	MaxRooms     int
	GracePeriod  time.Duration
}

func loadConfig() (config, error) {
	publicURL, err := requiredURL("BANANABREAD_PUBLIC_URL")
	if err != nil {
		return config{}, err
	}
	if publicURL.Scheme != "https" && !isLoopbackHost(publicURL.Hostname()) {
		return config{}, fmt.Errorf("BANANABREAD_PUBLIC_URL must use HTTPS")
	}
	lnbitsURL, err := requiredURL("BANANABREAD_LNBITS_URL")
	if err != nil {
		return config{}, err
	}
	if lnbitsURL.Scheme != "https" && !isLoopbackHost(lnbitsURL.Hostname()) {
		return config{}, fmt.Errorf("BANANABREAD_LNBITS_URL must use HTTPS")
	}
	secret := strings.TrimSpace(os.Getenv("BANANABREAD_SERVER_SECRET"))
	if len(secret) < 32 {
		return config{}, fmt.Errorf("BANANABREAD_SERVER_SECRET must contain at least 32 characters")
	}
	sourBinary := envOr("BANANABREAD_SOUR_BINARY", "sour")
	sourRoot := envOr("BANANABREAD_SOUR_ROOT", ".")
	dataDir := envOr("BANANABREAD_DATA_DIR", "./bananabread-data")
	if sourRoot, err = filepath.Abs(sourRoot); err != nil {
		return config{}, fmt.Errorf("resolve Sour root: %w", err)
	}
	if dataDir, err = filepath.Abs(dataDir); err != nil {
		return config{}, fmt.Errorf("resolve data directory: %w", err)
	}
	maxRooms, err := envInt("BANANABREAD_MAX_ROOMS", 16, 1, 100)
	if err != nil {
		return config{}, err
	}
	graceSeconds, err := envInt(
		"BANANABREAD_DISCONNECT_GRACE_SECONDS",
		60,
		60,
		60,
	)
	if err != nil {
		return config{}, err
	}
	return config{
		ListenAddr:   envOr("BANANABREAD_LISTEN_ADDR", "127.0.0.1:1340"),
		PublicURL:    publicURL,
		LNbitsURL:    lnbitsURL,
		ServerSecret: secret,
		SourBinary:   sourBinary,
		SourRoot:     sourRoot,
		DataDir:      dataDir,
		MaxRooms:     maxRooms,
		GracePeriod:  time.Duration(graceSeconds) * time.Second,
	}, nil
}

func requiredURL(name string) (*url.URL, error) {
	value := strings.TrimRight(strings.TrimSpace(os.Getenv(name)), "/")
	if value == "" {
		return nil, fmt.Errorf("%s is required", name)
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("%s must be an absolute URL", name)
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("%s cannot contain credentials, a query, or a fragment", name)
	}
	return parsed, nil
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func envInt(name string, fallback, minimum, maximum int) (int, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	number, err := strconv.Atoi(value)
	if err != nil || number < minimum || number > maximum {
		return 0, fmt.Errorf("%s must be between %d and %d", name, minimum, maximum)
	}
	return number, nil
}

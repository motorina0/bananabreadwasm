FROM golang:1.23-bookworm AS gateway-build

WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/bananabread-gateway .

FROM debian:bookworm-slim AS sour-release

ARG SOUR_VERSION=0.2.5
ARG SOUR_SHA256=18efcf8cf73e66ade20eacdb8e6649c29de6722a6141fba094fffae46b3bc836
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --output /tmp/sour.tar.gz \
      "https://github.com/cfoust/sour/releases/download/v${SOUR_VERSION}/sour_${SOUR_VERSION}_linux_amd64.tar.gz" \
    && echo "${SOUR_SHA256}  /tmp/sour.tar.gz" | sha256sum --check --strict \
    && mkdir -p /opt/sour \
    && tar -xzf /tmp/sour.tar.gz -C /opt/sour \
    && rm /tmp/sour.tar.gz

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=sour-release /opt/sour /opt/sour
COPY --from=gateway-build /out/bananabread-gateway /usr/local/bin/

ENV BANANABREAD_SOUR_BINARY=/opt/sour/sour \
    BANANABREAD_SOUR_ROOT=/opt/sour \
    BANANABREAD_DATA_DIR=/var/lib/bananabread \
    BANANABREAD_LISTEN_ADDR=0.0.0.0:1340 \
    BANANABREAD_DISCONNECT_GRACE_SECONDS=60

VOLUME ["/var/lib/bananabread"]
EXPOSE 1340
ENTRYPOINT ["/usr/local/bin/bananabread-gateway"]

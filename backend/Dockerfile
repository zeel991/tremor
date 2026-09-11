# Tremor read-only API — multi-stage build.
#
# The binary holds no keys and refuses to start if given one (src/config.rs). Nothing secret belongs in
# this image or in its environment.
#
# Build context is the REPOSITORY ROOT, not backend/, because the image must also carry
# contracts/deployments/84532.json — the schema-3 manifest the API validates at startup:
#
#     docker build -f backend/Dockerfile -t tremor-api .
#
# fly.toml already sets this via `dockerfile = "backend/Dockerfile"` with the root as context.

FROM rust:1.98-slim-bookworm AS builder

RUN apt-get update \
 && apt-get install -y --no-install-recommends pkg-config libssl-dev ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# build.rs generates the Lens bindings from backend/abi/TremorLens.json, so the ABI directory must be
# present before `cargo build` — it is not an optional asset.
COPY backend/Cargo.toml backend/Cargo.lock ./
COPY backend/build.rs ./build.rs
COPY backend/abi ./abi
COPY backend/src ./src

RUN cargo build --release --bin tremor-api \
 && strip target/release/tremor-api


FROM debian:bookworm-slim AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libssl3 curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --create-home --uid 10001 tremor

WORKDIR /app

COPY --from=builder /build/target/release/tremor-api /usr/local/bin/tremor-api
# The schema-3 manifest. The API refuses to start against a schema it does not understand, so this file
# and DEPLOYMENT_JSON must move together with any redeploy.
COPY contracts/deployments/84532.json /app/deployments/84532.json

# /data is the Fly volume mount. DATABASE_URL must point inside it, or the SQLite index lands on
# ephemeral container disk and is rebuilt from block 46685189 on every restart.
RUN mkdir -p /data && chown -R tremor:tremor /data /app

USER tremor

ENV RPC_URL=https://sepolia.base.org \
    DEPLOYMENT_JSON=/app/deployments/84532.json \
    DATABASE_URL=sqlite:///data/tremor_84532.db \
    PORT=8080 \
    BIND_ADDRESS=0.0.0.0 \
    POLL_MS=3000
# CORS_ORIGIN is deliberately NOT defaulted here: the code's fallback is http://localhost:3000, and a
# wrong value silently blocks every browser call. Set it explicitly to the real frontend origin.

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/health" || exit 1

ENTRYPOINT ["/usr/local/bin/tremor-api"]

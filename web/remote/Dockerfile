FROM docker.io/cloudflare/sandbox:0.12.3

ARG KASMVNC_VERSION=1.4.0
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
  && apt-get install -y --no-install-recommends bubblewrap ca-certificates curl dbus-x11 openbox xterm \
  && curl -fsSL -o /tmp/kasmvnc.deb "https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/kasmvncserver_jammy_${KASMVNC_VERSION}_amd64.deb" \
  && apt-get install -y --no-install-recommends /tmp/kasmvnc.deb \
  && npm install -g @xai-official/grok@0.2.101 @agentclientprotocol/sdk@1.2.1 @playwright/mcp@0.0.78 playwright@1.61.1 typescript@7.0.2 typescript-language-server@5.3.0 pyright@1.1.411 \
  && npx playwright install --with-deps chromium \
  && rm -f /tmp/kasmvnc.deb \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --uid 10001 --shell /usr/sbin/nologin grok-agent \
  && mkdir -p /home/grok /home/sandbox/.vnc /workspace/playwright-evidence /root/.grok /root/.ssh /var/run/secrets \
  && chmod 711 /home/grok \
  && chown -R grok-agent:grok-agent /workspace

COPY scripts/start-desktop.sh /usr/local/bin/start-grok-desktop
COPY scripts/acp-bridge.mjs /usr/local/lib/grok-build/acp-bridge.mjs
RUN chmod 755 /usr/local/bin/start-grok-desktop /usr/local/lib/grok-build/acp-bridge.mjs

EXPOSE 3000 2419 6901 8931 9222

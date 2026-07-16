FROM docker.io/cloudflare/sandbox:0.12.3

ARG KASMVNC_VERSION=1.4.0
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl dbus-x11 openbox xterm \
  && curl -fsSL -o /tmp/kasmvnc.deb "https://github.com/kasmtech/KasmVNC/releases/download/v${KASMVNC_VERSION}/kasmvncserver_jammy_${KASMVNC_VERSION}_amd64.deb" \
  && apt-get install -y --no-install-recommends /tmp/kasmvnc.deb \
  && npm install -g @xai-official/grok@0.2.101 @playwright/mcp@0.0.78 playwright@1.61.1 \
  && npx playwright install --with-deps chromium \
  && rm -f /tmp/kasmvnc.deb \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /home/grok /home/sandbox/.vnc /workspace/playwright-evidence \
  && chmod 700 /home/grok

COPY scripts/start-desktop.sh /usr/local/bin/start-grok-desktop
RUN chmod 755 /usr/local/bin/start-grok-desktop

EXPOSE 3000 6901 8931 9222

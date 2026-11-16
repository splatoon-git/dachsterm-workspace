# Everything the app reaches directly from the host: HTTP CONNECT and SOCKS5 proxies (both with
# user authentication), a Telnet server, an external X server, and a serial-console stand-in on TCP
# that the host turns into a virtual serial port with socat.
FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends tinyproxy microsocks inetutils-telnetd openbsd-inetd xvfb xauth socat procps \
  && rm -rf /var/lib/apt/lists/* \
  && useradd -m -s /bin/bash probe
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["sh", "/entrypoint.sh"]

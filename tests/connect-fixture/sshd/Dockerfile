# SSH servers for the CG work items: the target (reachable only through a proxy or the jump host),
# the jump host, and the one-shot init that writes every throwaway secret into the shared volume.
FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssh-server openssl xauth x11-apps x11-utils lrzsz python3 python3-pip procps \
  && pip3 install --break-system-packages --no-cache-dir trzsz==1.1.7 \
  && rm -rf /var/lib/apt/lists/* \
  && useradd -m -s /bin/bash probe \
  && mkdir /run/sshd
COPY sshd_config /etc/ssh/sshd_config
COPY init.sh /init.sh
COPY entrypoint.sh /entrypoint.sh
ENTRYPOINT ["sh", "/entrypoint.sh"]

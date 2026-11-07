FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server openssl python3 vim-tiny less procps htop socat tmux zsh && rm -rf /var/lib/apt/lists/* && useradd -m -s /bin/bash probe && mkdir /run/sshd
COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /entrypoint.sh
COPY echo.py /echo.py
ENTRYPOINT ["sh", "/entrypoint.sh"]

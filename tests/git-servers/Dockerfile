# OpenSSH servers with older and newer git and tmux for the HTTPS credential checks (DX.12).
# One file for every base image measured in DX.12.0 except Debian 12, which tests/openssh covers:
#   centos:7 (git 1.8.3.1, tmux 1.8), ubuntu:18.04 (2.17.1, 2.6), ubuntu:20.04 (2.25.1, 3.0a),
#   alpine:edge (latest).
# The password for `probe` is made at start: docker exec <name> cat /run/probe/password
ARG BASE=alpine:edge
FROM ${BASE}
COPY install.sh entrypoint.sh /probe/
RUN sh /probe/install.sh
ENTRYPOINT ["sh", "/probe/entrypoint.sh"]

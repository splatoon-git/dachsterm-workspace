# HTTPS Git server (Basic auth, Git LFS) for the HTTPS credential checks (DX.12).
# Run it on the probe network with the alias git.test; it listens on https://git.test:3000/.
# The password is made at start and is readable only inside the container:
#   docker exec <name> cat /var/lib/gitea/probe/password
FROM gitea/gitea:1.24.6-rootless
ENV GITEA__security__INSTALL_LOCK=true \
    GITEA__database__DB_TYPE=sqlite3 \
    GITEA__server__PROTOCOL=https \
    GITEA__server__DOMAIN=git.test \
    GITEA__server__ROOT_URL=https://git.test:3000/ \
    GITEA__server__CERT_FILE=/var/lib/gitea/probe/cert.pem \
    GITEA__server__KEY_FILE=/var/lib/gitea/probe/key.pem \
    GITEA__server__LFS_START_SERVER=true \
    GITEA__server__DISABLE_SSH=true \
    GITEA__service__DISABLE_REGISTRATION=true \
    GITEA__repository__ENABLE_PUSH_CREATE_USER=true \
    GITEA__repository__DEFAULT_PUSH_CREATE_PRIVATE=true \
    GITEA__log__LEVEL=Warn
COPY --chmod=0755 entrypoint.sh /probe-entrypoint.sh
ENTRYPOINT ["/probe-entrypoint.sh"]

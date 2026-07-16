# Multi-user host

The default Ódinn Forge gateway is a single-user loopback service and must not be bound to a public interface. Remote deployments use the separate multi-user host, which terminates TLS and proxies each authenticated user to an independent loopback gateway.

## Provision a user

Passwords are read from the environment and stored only as scrypt hashes in an owner-only user database:

```bash
ODINN_HOST_STATE=/srv/odinn-host \
ODINN_USER_PASSWORD='use-a-password-manager-generated-secret' \
node apps/gateway/src/host.mjs user-add \
  --id alice \
  --workspace /srv/odinn-workspaces/alice
```

There is no public signup endpoint. Provisioning is an operator action.

## Start the host

```bash
ODINN_HOST_STATE=/srv/odinn-host \
ODINN_HOST=0.0.0.0 \
ODINN_PORT=18791 \
ODINN_PUBLIC_ORIGIN=https://odinn.example.com \
ODINN_TLS_CERT=/etc/letsencrypt/live/odinn.example.com/fullchain.pem \
ODINN_TLS_KEY=/etc/letsencrypt/live/odinn.example.com/privkey.pem \
pnpm host:start
```

A non-loopback bind refuses to start without a certificate, private key, and exact public origin. Mutating requests require that exact origin. Authentication is throttled per client address and user, sessions are signed HttpOnly/SameSite cookies, and logout revokes the active session. Sessions are intentionally held in memory, so a host restart signs every user out.

## Isolation boundary

Every user receives a separate:

- state directory and SQLite ledger;
- workspace root;
- loopback gateway and bearer token;
- OAuth and audit stores;
- browser profile and recovery journal.

This is application-level tenant separation. It is not a sandbox for mutually hostile users running arbitrary local code. Deploy mutually untrusted tenants under separate operating-system users, containers, or machines. Do not share workspace roots between tenants.

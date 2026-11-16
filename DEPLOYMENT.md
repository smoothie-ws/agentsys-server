# Deployment

## Docker

```sh
docker build -t agentsys-server:0.4.0 .
docker run --rm -p 8080:8080 -v agentsys-data:/data -e AGENTSYS_TOKEN agentsys-server:0.4.0 start --host 0.0.0.0 --port 8080 --data /data --allowed-origin https://client.example
```

The image contains no GUI. /data must persist across upgrades. Supply the token
through the container environment or deployment secret facility. Terminate TLS
at a reverse proxy or mount certificate files and pass CLI TLS flags.

## systemd

Install the npm package for a dedicated unprivileged service user. Create a mode
0600 /etc/agentsys-server.env containing AGENTSYS_TOKEN. A unit may use:

```ini
[Unit]
Description=AgentSys Server
After=network.target
[Service]
User=agentsys
WorkingDirectory=/var/lib/agentsys
EnvironmentFile=/etc/agentsys-server.env
ExecStart=/usr/local/bin/agentsys-server start --host 0.0.0.0 --port 8080 --data /var/lib/agentsys/data --allowed-origin https://client.example
Restart=on-failure
NoNewPrivileges=true
PrivateTmp=true
[Install]
WantedBy=multi-user.target
```

Adjust executable paths for your installation. Health: GET /api/meta; operational
diagnostics: authenticated GET /api/diagnostics. Stop gracefully before restoring
data. Test backups before upgrading; versioned release artifacts include the API
contract. Server and client upgrades are independent within API major 2.

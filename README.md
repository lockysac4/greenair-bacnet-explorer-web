# Greenair BACnet Explorer Web v0.7.5

Program Load now uses the direct read-only Temco/T3000 BACnet/IP private-transfer protocol discovered from T3000 source. It reads command 7 metadata, then command 16 program code, and assembles the five 400-byte packages. Program writes remain locked.

# Greenair BACnet Explorer Web v0.7.4

This build fixes the web page appearing stuck while controller communications are slow or unavailable. The browser UI and Render health check no longer depend on external Modbus/BACnet endpoints.

## Deploy

Use the existing Render service `greenair-bacnet-explorer-web`.

- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/healthz`

After deploy, the home page should immediately show `APPLICATION READY`. Press **Connect Controllers** to test Planks and T-Beams.

Program writes remain locked by default.
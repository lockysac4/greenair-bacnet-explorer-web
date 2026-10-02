# Changelog

## v0.7.5
- Removed the external bridge requirement from Controller Load.
- Added direct read-only Temco BACnet/IP ConfirmedPrivateTransfer reads.
- Matches T3000 Vendor 148 / private service 1 / 7-byte private header.
- Reads program metadata with command 7, then program code with command 16.
- Reassembles five 400-byte program packages into the 2000-byte image.
- Program Send remains locked behind the verified write bridge and write flags.
- Added /api/program/direct-probe for read-only deployment diagnostics.

# Greenair BACnet Explorer Web v0.7.4

## Instant Load / Render Health Fix

- Render service name corrected to `greenair-bacnet-explorer-web`.
- Added `/healthz` fast health endpoint with no controller/network dependency.
- Render health check now uses `/healthz`.
- Overview page no longer auto-runs Modbus connection tests during page startup.
- UI renders immediately and displays `APPLICATION READY`; controller tests run only when `Connect Controllers` is pressed.
- Preserves v0.7.3 T-Beams signed 32-bit ambient mapping and PrivateTransfer Capture Analyzer.
- Program writes remain locked unless the existing explicit safety variables are enabled.
# Greenair BACnet Explorer Web v0.7.4

## Instant Load / Render Health Fix

- Render service name corrected to `greenair-bacnet-explorer-web`.
- Added `/healthz` fast health endpoint with no controller/network dependency.
- Render health check now uses `/healthz`.
- Overview page no longer auto-runs Modbus connection tests during page startup.
- UI renders immediately and displays `APPLICATION READY`; controller tests run only when `Connect Controllers` is pressed.
- Preserves v0.7.3 T-Beams signed 32-bit ambient mapping and PrivateTransfer Capture Analyzer.
- Program writes remain locked unless the existing explicit safety variables are enabled.
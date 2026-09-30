# Changelog

## v0.4.0
- New Render-native architecture.
- Removed dependency on local Windows BACnet/Modbus access.
- Uses raw Node TCP Modbus FC03, matching the proven Bianco TrendLog transport pattern.
- Added Planks and T-Beams connection tests.
- Added live 3-second point refresh.
- Added raw holding-register reader.
- Read-only safety lock retained.
- Existing TrendLog is not modified.

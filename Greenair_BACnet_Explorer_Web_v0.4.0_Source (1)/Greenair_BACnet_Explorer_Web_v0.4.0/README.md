# Greenair BACnet Explorer Web v0.4.0

This is a completely separate project from the existing Greenair TrendLog.

## What changed

v0.4.0 is designed to run on Render. It uses the proven Bianco raw Modbus TCP transport copied conceptually from the working TrendLog source:

- Planks: `bms.biancoprecast.com.au:502`, Unit ID `69`
- T-Beams: `bms.biancoprecast.com.au:505`, Unit ID `68`
- FC03 holding-register reads

The application is read-only in this release.

## Render deployment

Create a new Render Web Service from this project/repository, or use `render.yaml` as a Blueprint.

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Health check: `/api/status`

Do **not** replace or modify the existing `greenair-trendlog` Render service.

## First test

After deployment, open the new Render URL and click **Connect Bianco Controllers**.

The app should report both Planks and T-Beams independently. If one fails, the error text is returned from the Render-side TCP connection.

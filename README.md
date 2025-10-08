# Standalone Video API

This folder contains a self-contained API server you can run independently. It exposes simple endpoints to fetch video sources and subtitles by TMDB id.

## Endpoints

- GET /api/movie/:tmdbId
  - Returns the first working provider stream (fastest path) for a movie.
- GET /api/tv/:tmdbId/season/:season/episode/:episode
  - Returns the first working provider stream for a TV episode.

Response format follows the output of `@p-stream/providers` single-result path: `{ sourceId, stream, embedId? }`.

### Provider exclusions

- The provider `fsharetv` (fshare.co) is excluded by default for stability.
- No query parameter is required; the server always skips it.

## Environment

Create a `.env` file next to `server.js` with:

- TMDB_API_KEY=your_tmdb_api_key
- PORT=3002 (optional)
- PROXY_URLS=http://your-proxy-1.com,http://your-proxy-2.com (optional)
- M3U8_PROXY_URLS=http://your-m3u8-proxy.com (optional)

## Run

1. Open a terminal in this folder.
2. Install dependencies:

```powershell
pnpm install
```

3. Start the server:

```powershell
pnpm start
```

Server prints the listen URL. Example call:

```powershell
curl "http://localhost:3002/api/movie/603" | Out-Host
```

or TV:

```powershell
curl "http://localhost:3002/api/tv/1399/season/1/episode/1" | Out-Host
```

## Deploy

You can deploy this app to any Node.js host that can run an Express server (e.g., Render, Railway, Fly.io, a VPS, or Docker). Ensure the required environment variable `TMDB_API_KEY` is set, and optionally `PROXY_URLS`.

### Render (Blueprint deploy)

This project includes `render.yaml`.

1. Push the project to a GitHub repo.
2. In Render, click New → Blueprint and select your repo.
3. Set environment variables on the service:

- `TMDB_API_KEY` (required)
- `PROXY_URLS` (optional)

4. Click Deploy. Health check path is `/healthz`.

Render uses `pnpm` via `corepack` in `render.yaml`, and runs `pnpm start`.

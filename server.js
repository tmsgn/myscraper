import "dotenv/config";
import express from "express";
import cors from "cors";
import {
  makeProviders,
  makeStandardFetcher,
  targets,
  NotFoundError,
} from "@p-stream/providers";

// Ensure a fetch implementation is available (Node 18+ has global fetch)
async function getFetch() {
  if (typeof globalThis.fetch === "function") return globalThis.fetch;
  const mod = await import("node-fetch");
  return mod.default ?? mod;
}

// Optional: support proxy-based fetcher and m3u8 proxying similar to root code
function getListFromEnv(name) {
  const raw = process.env[name] ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function getProxyUrls() {
  return getListFromEnv("PROXY_URLS")
    .map((u) => {
      if (u.startsWith("|")) {
        const m = /^\|([^|]+)\|(.*)$/.exec(u);
        return m?.[2] || "";
      }
      return u;
    })
    .filter(Boolean);
}

function makeFetch() {
  const proxies = getProxyUrls();
  if (proxies.length === 0)
    return makeStandardFetcher(async (...args) => (await getFetch())(...args));
  // Simple round-robin proxy fetcher
  let i = Math.floor(Math.random() * proxies.length);
  return async (input, init) => {
    const base = proxies[i % proxies.length];
    i++;
    const url = typeof input === "string" ? input : input.url;
    const target = `${base}${url}`;
    const f = await getFetch();
    return f(target, init);
  };
}

// Always exclude these source IDs for safety/performance
const ALWAYS_EXCLUDED_SOURCE_IDS = new Set(["fsharetv"]);

const providers = makeProviders({
  fetcher: makeFetch(),
  target: targets.NATIVE,
  consistentIpForRequests: true,
});

const app = express();
app.use(cors());
app.use(express.json());
// basic health endpoints for Render or uptime checks
app.get("/", (req, res) => {
  res.json({ ok: true, service: "standalone-api", uptime: process.uptime() });
});
app.get("/healthz", (req, res) => res.status(200).send("ok"));

// --- TMDB helpers ---
async function tmdbGet(path) {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) throw new Error("Missing TMDB_API_KEY");
  const sep = path.includes("?") ? "&" : "?";
  const url = `https://api.themoviedb.org/3${path}${sep}api_key=${apiKey}`;
  const f = await getFetch();
  const r = await f(url);
  if (!r.ok) throw new Error(`TMDB error ${r.status}`);
  return r.json();
}

async function mediaFromMovie(id) {
  const data = await tmdbGet(`/movie/${id}`);
  const title = data.title || data.original_title || "";
  const releaseYear = parseInt(
    (data.release_date || "").slice(0, 4) || "0",
    10
  );
  if (!title || !releaseYear) throw new Error("TMDB movie metadata incomplete");
  return {
    type: "movie",
    title,
    releaseYear,
    tmdbId: String(id),
    imdbId: data.imdb_id || undefined,
  };
}

async function mediaFromTv(id, season, episode) {
  const tv = await tmdbGet(`/tv/${id}`);
  const title = tv.name || tv.original_name || "";
  const releaseYear = parseInt(
    (tv.first_air_date || "").slice(0, 4) || "0",
    10
  );
  if (!title || !releaseYear) throw new Error("TMDB show metadata incomplete");

  const seasonNumber = Number(season);
  const episodeNumber = Number(episode);
  if (!Number.isFinite(seasonNumber) || seasonNumber <= 0)
    throw new Error("Invalid season");
  if (!Number.isFinite(episodeNumber) || episodeNumber <= 0)
    throw new Error("Invalid episode");

  const s = await tmdbGet(`/tv/${id}/season/${seasonNumber}`);
  const e = s.episodes?.find((x) => x.episode_number === episodeNumber);
  if (!e) throw new Error(`Episode ${episode} not found in season ${season}`);

  // Fetch TMDB external IDs to get reliable IMDb IDs for the show/episode
  let showExternalIds = null;
  let episodeExternalIds = null;
  try {
    showExternalIds = await tmdbGet(`/tv/${id}/external_ids`);
  } catch (err) {
    console.warn("Failed to fetch show external_ids", err?.message || err);
  }
  try {
    episodeExternalIds = await tmdbGet(
      `/tv/${id}/season/${seasonNumber}/episode/${episodeNumber}/external_ids`
    );
  } catch (err) {
    console.warn("Failed to fetch episode external_ids", err?.message || err);
  }

  const imdbId =
    (episodeExternalIds && episodeExternalIds.imdb_id) ||
    (showExternalIds && showExternalIds.imdb_id) ||
    e.imdb_id ||
    tv.imdb_id ||
    undefined;

  return {
    type: "show",
    title,
    releaseYear,
    tmdbId: String(id),
    imdbId, // prefer episode IMDb ID, then show IMDb ID
    season: { number: seasonNumber, tmdbId: String(s.id), title: s.name || "" },
    episode: {
      number: episodeNumber,
      tmdbId: String(e.id),
      title: e.name || "",
    },
  };
}

// --- OpenSubtitles proxy / normalization ---
/**
 * Query the public OpenSubtitles REST endpoint and map results to p-stream format.
 * Returns an array of objects: { id, language, url, type, needsProxy, opensubtitles, source }
 */
async function fetchOpenSubtitlesCaptions(imdbId, season, episode) {
  if (!imdbId) return [];
  // rest.opensubtitles expects the imdb id without the "tt" prefix
  const imdbNumeric = imdbId.startsWith("tt") ? imdbId.slice(2) : imdbId;
  const path =
    season && episode
      ? `episode-${episode}/imdbid-${imdbNumeric}/season-${season}`
      : `imdbid-${imdbNumeric}`;

  const url = `https://rest.opensubtitles.org/search/${path}`;

  try {
    const f = await getFetch();
    const res = await f(url, {
      headers: {
        // The public REST API historically expects an X-User-Agent header
        "X-User-Agent": "VLSub 0.10.2",
        Accept: "application/json",
      },
      // optionally, add signal/AbortController for timeouts
    });

    if (!res.ok) {
      console.warn(`OpenSubtitles returned ${res.status} for ${url}`);
      return [];
    }

    const data = await res.json();
    if (!Array.isArray(data)) return [];

    const out = data
      .map((item) => {
        // item.SubDownloadLink usually contains a gz URL; translate to un-gz, prefer utf-8 encoding path
        const downloadUrlRaw =
          item.SubDownloadLink || item.SubDownload_Link || "";
        const downloadUrl = downloadUrlRaw
          ? downloadUrlRaw
              .replace(".gz", "")
              .replace("download/", "download/subencoding-utf8/")
          : null;

        // Prefer ISO code if present, otherwise use language name
        const language =
          (item.ISO639 && String(item.ISO639).toLowerCase()) ||
          (item.LanguageName && String(item.LanguageName).toLowerCase()) ||
          "";

        return {
          id:
            downloadUrl ||
            item.ID ||
            item.SubFileId ||
            `${imdbId}-${
              item.SubFileId || Math.random().toString(36).slice(2)
            }`,
          language,
          url: downloadUrl || "",
          type: item.SubFormat || "srt",
          needsProxy: false,
          opensubtitles: true,
          source: "opensubs",
        };
      })
      .filter((s) => s.url); // only return entries with a usable URL

    return out;
  } catch (err) {
    console.error(
      "OpenSubtitles proxy error:",
      err && err.stack ? err.stack : err
    );
    return [];
  }
}

// --- Helpers to inject captions into provider results ----
function findFirstPlaylist(obj) {
  // DFS search for the first string value stored in a 'playlist' property
  if (!obj || typeof obj !== "object") return null;
  if (typeof obj.playlist === "string" && obj.playlist.length > 0)
    return obj.playlist;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        const res = findFirstPlaylist(item);
        if (res) return res;
      }
    } else if (typeof val === "object" && val !== null) {
      const res = findFirstPlaylist(val);
      if (res) return res;
    }
  }
  return null;
}

function playlistHost(playlistUrl) {
  try {
    return new URL(playlistUrl).host;
  } catch (e) {
    return null;
  }
}

function injectCaptionsForHost(obj, host, captions) {
  if (!obj || typeof obj !== "object") return;
  if (typeof obj.playlist === "string") {
    const hostOfItem = playlistHost(obj.playlist);
    if (hostOfItem && hostOfItem === host) {
      // ensure captions array exists and merge unique by id
      const existing = Array.isArray(obj.captions) ? obj.captions : [];
      const existingIds = new Set(existing.map((c) => c.id));
      const newOnes = captions.filter((c) => !existingIds.has(c.id));
      obj.captions = [...existing, ...newOnes];
      // done for this object, but continue to find more matches deeper
    }
  }
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        injectCaptionsForHost(item, host, captions);
      }
    } else if (typeof val === "object" && val !== null) {
      injectCaptionsForHost(val, host, captions);
    }
  }
}

// Inject captions directly into a single stream object if it has an HLS playlist
function injectCaptionsIntoStream(stream, captions) {
  if (!stream || typeof stream !== "object") return;
  const playlist = findFirstPlaylist(stream);
  if (!playlist) return;
  const host = playlistHost(playlist);
  if (!host) return;
  const existing = Array.isArray(stream.captions) ? stream.captions : [];
  const existingIds = new Set(existing.map((c) => c.id));
  const newOnes = (captions || []).filter((c) => !existingIds.has(c.id));
  stream.captions = [...existing, ...newOnes];
}

// Cache provider metadata to avoid re-listing on each request
let SOURCE_METAS_CACHE = null;
let EMBED_METAS_CACHE = null;
async function getProviderMetas() {
  if (!SOURCE_METAS_CACHE || !EMBED_METAS_CACHE) {
    SOURCE_METAS_CACHE = await providers.listSources();
    EMBED_METAS_CACHE = await providers.listEmbeds();
  }
  return { sourceMetas: SOURCE_METAS_CACHE, embedMetas: EMBED_METAS_CACHE };
}

// Find the first successful stream from non-excluded sources/embeds
async function findFirstProvider(media, excluded = ALWAYS_EXCLUDED_SOURCE_IDS) {
  const { sourceMetas, embedMetas } = await getProviderMetas();
  const compatibleSources = sourceMetas
    .filter((s) =>
      (Array.isArray(s.mediaTypes) ? s.mediaTypes : []).includes(media.type)
    )
    .filter((s) => !excluded.has(String(s.id).toLowerCase()));

  for (const src of compatibleSources) {
    try {
      const out = await providers.runSourceScraper({ id: src.id, media });
      if (out.stream && out.stream.length > 0) {
        return { sourceId: src.id, stream: out.stream[0] };
      }
      if (out.embeds && out.embeds.length > 0) {
        const orderedEmbeds = out.embeds
          .map((e, i) => ({ ...e, _i: i }))
          .sort((a, b) => {
            const ai = embedMetas.findIndex((m) => m.id === a.embedId);
            const bi = embedMetas.findIndex((m) => m.id === b.embedId);
            if (ai >= 0 && bi >= 0) return ai - bi;
            if (ai >= 0) return -1;
            if (bi >= 0) return 1;
            return a._i - b._i;
          });
        for (const emb of orderedEmbeds) {
          try {
            const eout = await providers.runEmbedScraper({
              id: emb.embedId,
              url: emb.url,
            });
            if (eout.stream && eout.stream.length > 0) {
              return {
                sourceId: src.id,
                embedId: emb.embedId,
                stream: eout.stream[0],
              };
            }
          } catch (_) {
            // continue to next embed
          }
        }
      }
    } catch (_) {
      // continue to next source
    }
  }
  return null;
}

// --- Routes ---
// provider-backed scraping endpoints for movies/tv
app.get("/api/movie/:tmdbId", async (req, res) => {
  try {
    const media = await mediaFromMovie(req.params.tmdbId);
    // Return first working provider (excluding always-excluded IDs)
    const result = await findFirstProvider(media);
    if (!result) return res.status(404).json({ error: "no_output" });

    // Inject captions for the single stream result
    if (media.imdbId) {
      try {
        const captions = await fetchOpenSubtitlesCaptions(media.imdbId);
        if (captions && captions.length > 0) {
          injectCaptionsIntoStream(result.stream, captions);
        }
      } catch (_) {}
    }

    res.json(result);
  } catch (err) {
    console.error("movie error", err);
    const status = err instanceof NotFoundError ? 404 : 500;
    res.status(status).json({ error: err?.message || "internal" });
  }
});

// Alias without /api prefix for convenience
app.get("/movie/:tmdbId", async (req, res) => {
  try {
    const media = await mediaFromMovie(req.params.tmdbId);
    const result = await findFirstProvider(media);
    if (!result) return res.status(404).json({ error: "no_output" });

    if (media.imdbId) {
      try {
        const captions = await fetchOpenSubtitlesCaptions(media.imdbId);
        if (captions && captions.length > 0) {
          injectCaptionsIntoStream(result.stream, captions);
        }
      } catch (_) {}
    }

    res.json(result);
  } catch (err) {
    console.error("movie error", err);
    const status = err instanceof NotFoundError ? 404 : 500;
    res.status(status).json({ error: err?.message || "internal" });
  }
});

app.get("/api/tv/:tmdbId/season/:season/episode/:episode", async (req, res) => {
  try {
    const { tmdbId, season, episode } = req.params;
    const media = await mediaFromTv(tmdbId, season, episode);
    const result = await findFirstProvider(media);
    if (!result) return res.status(404).json({ error: "no_output" });

    if (media.imdbId) {
      try {
        const captions = await fetchOpenSubtitlesCaptions(
          media.imdbId,
          media.season?.number,
          media.episode?.number
        );
        if (captions && captions.length > 0) {
          injectCaptionsIntoStream(result.stream, captions);
        }
      } catch (_) {}
    }

    res.json(result);
  } catch (err) {
    console.error("tv error", err);
    const status = err instanceof NotFoundError ? 404 : 500;
    res.status(status).json({ error: err?.message || "internal" });
  }
});

// Alias without /api prefix for convenience
app.get("/tv/:tmdbId/season/:season/episode/:episode", async (req, res) => {
  try {
    const { tmdbId, season, episode } = req.params;
    const media = await mediaFromTv(tmdbId, season, episode);
    const result = await findFirstProvider(media);
    if (!result) return res.status(404).json({ error: "no_output" });

    if (media.imdbId) {
      try {
        const captions = await fetchOpenSubtitlesCaptions(
          media.imdbId,
          media.season?.number,
          media.episode?.number
        );
        if (captions && captions.length > 0) {
          injectCaptionsIntoStream(result.stream, captions);
        }
      } catch (_) {}
    }

    res.json(result);
  } catch (err) {
    console.error("tv error", err);
    const status = err instanceof NotFoundError ? 404 : 500;
    res.status(status).json({ error: err?.message || "internal" });
  }
});

// Also keep the direct OpenSubtitles-only search route if you want to call it directly
app.get("/subtitles/opensubtitles", async (req, res) => {
  try {
    const imdbId = req.query.imdbId;
    const season = req.query.season ? Number(req.query.season) : undefined;
    const episode = req.query.episode ? Number(req.query.episode) : undefined;

    if (!imdbId || typeof imdbId !== "string") {
      return res
        .status(400)
        .json({ error: "imdbId query param is required (e.g. tt0133093)" });
    }

    const captions = await fetchOpenSubtitlesCaptions(imdbId, season, episode);
    return res.json(captions);
  } catch (err) {
    console.error("Route error /subtitles/opensubtitles", err);
    return res.status(500).json({ error: "internal error" });
  }
});

const port = Number(process.env.PORT ?? 3002);
app.listen(port, () => {
  console.log(`[standalone-api] listening on http://localhost:${port}`);
});

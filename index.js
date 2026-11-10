import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import {
  MovieboxSession as PrimarySession,
  createNoopLogger as createPrimaryLogger,
  getMovieStreamUrl as getMovieStreamPrimary,
  getEpisodeStreamUrl as getEpisodeStreamPrimary,
  getMovieDetails as getMovieDetailsPrimary,
  getSeriesDetails as getSeriesDetailsPrimary,
} from 'moviebox-js-sdk';

import {
  MovieboxSession as FallbackSession,
  createNoopLogger as createFallbackLogger,
  getMovieStreamUrl as getMovieStreamFallback,
  getEpisodeStreamUrl as getEpisodeStreamFallback,
} from '@weroperking/invenio-scraper';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());

const MIRROR_HOSTS = [
  'h5.aoneroom.com',
  'v.moviebox.ph',
  'moviebox.pk',
  'netnaija.video',
  'moviebox.ph',
];

const REQUIRED_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Referer': 'https://h5.aoneroom.com/',
  'Accept': '*/*',
};

function sanitizeFileName(name) {
  return (name || 'video')
    .replace(/[<>:"/\\|?*]+/g, '')
    .trim()
    .replace(/\s+/g, '_');
}

/**
 * Searches MovieBox across multiple BFF endpoints by title/query to find a detailPath.
 */
async function searchDetailPath(query, mediaType) {
  if (!query || typeof query !== 'string' || !query.trim()) return null;
  const cleanQuery = query.trim();
  const subjectType = mediaType === 'episode' ? 2 : 1;

  const searchEndpoints = [
    'https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/search',
    'https://movieboxapp.in/wefeed-h5-bff/web/subject/search',
    'https://h5.aoneroom.com/wefeed-h5-bff/web/subject/search',
  ];

  for (const endpoint of searchEndpoints) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': REQUIRED_HEADERS['User-Agent'],
          'Referer': 'https://h5.aoneroom.com/',
        },
        body: JSON.stringify({
          keyword: cleanQuery,
          page: 1,
          perPage: 10,
          subjectType,
        }),
      });

      if (!response.ok) continue;
      const data = await response.json();
      const items = data?.data?.items || data?.items || [];
      if (Array.isArray(items) && items.length > 0) {
        const matched = items.find((it) => it.detailPath) || items[0];
        if (matched?.detailPath) {
          return {
            detailPath: matched.detailPath,
            title: matched.title || cleanQuery,
            subjectId: matched.subjectId,
          };
        }
      }
    } catch (err) {
      console.warn(`[Search] Endpoint ${endpoint} failed:`, err.message);
    }
  }

  // Fallback: search with subjectType 0 (all categories)
  try {
    const response = await fetch('https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': REQUIRED_HEADERS['User-Agent'],
        'Referer': 'https://h5.aoneroom.com/',
      },
      body: JSON.stringify({
        keyword: cleanQuery,
        page: 1,
        perPage: 10,
        subjectType: 0,
      }),
    });
    if (response.ok) {
      const data = await response.json();
      const items = data?.data?.items || data?.items || [];
      if (Array.isArray(items) && items.length > 0) {
        const matched = items.find((it) => it.detailPath) || items[0];
        if (matched?.detailPath) {
          return {
            detailPath: matched.detailPath,
            title: matched.title || cleanQuery,
            subjectId: matched.subjectId,
          };
        }
      }
    }
  } catch (_) {}

  return null;
}

/**
 * Health check
 */
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

/**
 * Proxy streaming endpoint for clients that face CDN geoblocking or direct HTTP 429
 */
app.get('/api/moviebox/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || typeof targetUrl !== 'string') {
    return res.status(400).send('Missing url parameter');
  }

  try {
    const forwardHeaders = {
      ...REQUIRED_HEADERS,
    };
    if (req.headers.range) {
      forwardHeaders['Range'] = req.headers.range;
    }

    const upstream = await fetch(targetUrl, {
      headers: forwardHeaders,
    });

    res.status(upstream.status);
    for (const [key, val] of upstream.headers.entries()) {
      if (['content-type', 'content-length', 'content-range', 'accept-ranges'].includes(key.toLowerCase())) {
        res.setHeader(key, val);
      }
    }

    const reader = upstream.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          break;
        }
        res.write(value);
      }
    };
    await pump();
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).send(err.message);
    }
  }
});

/**
 * Resolve direct MP4 download link from MovieBox across available mirrors
 */
app.post('/api/moviebox/resolve', async (req, res) => {
  const { detailPath, title, query, type, season, episode, quality } = req.body || {};

  const rawType = (type || 'movie').toLowerCase();
  const mediaType = rawType === 'episode' || rawType === 'tv' ? 'episode' : 'movie';
  const targetQuality = quality ? quality.toString().toLowerCase().replace('p', '') : 'best';

  let cleanDetailPath = (detailPath || '').toString().trim();
  let resolvedTitle = (title || query || cleanDetailPath || 'video').toString().trim();

  // If detailPath is empty, search by title or query
  if (!cleanDetailPath) {
    const searchQuery = title || query;
    if (!searchQuery) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: detailPath or title/query must be provided.',
      });
    }

    const found = await searchDetailPath(searchQuery, mediaType);
    if (found && found.detailPath) {
      cleanDetailPath = found.detailPath;
      if (found.title) resolvedTitle = found.title;
    } else {
      return res.status(404).json({
        success: false,
        error: `Could not find MovieBox media matching query: "${searchQuery}"`,
      });
    }
  }

  // Extract client IP if forwarded by proxy/CDN
  const clientIp =
    req.headers['x-forwarded-for']?.toString().split(',')[0].trim() ||
    req.headers['x-real-ip']?.toString() ||
    '105.101.44.12';

  const defaultHeaders = {
    'X-Forwarded-For': clientIp,
    'X-Real-IP': clientIp,
    'X-Client-Info': '{"timezone":"Africa/Cairo"}',
  };

  let streamResult = null;
  let lastError = null;

  // Try each mirror host until successful
  for (const host of MIRROR_HOSTS) {
    try {
      const session = new PrimarySession({
        logger: createPrimaryLogger(),
        host,
        defaultHeaders,
      });

      if (mediaType === 'episode') {
        const sNum = parseInt(season, 10) || 1;
        const eNum = parseInt(episode, 10) || 1;
        try {
          const seriesInfo = await getSeriesDetailsPrimary(session, { detailPath: cleanDetailPath });
          if (seriesInfo?.title) resolvedTitle = seriesInfo.title;
        } catch (_) {}

        streamResult = await getEpisodeStreamPrimary(session, {
          detailPath: cleanDetailPath,
          season: sNum,
          episode: eNum,
          quality: targetQuality,
        });
      } else {
        try {
          const movieInfo = await getMovieDetailsPrimary(session, { detailPath: cleanDetailPath });
          if (movieInfo?.title) resolvedTitle = movieInfo.title;
        } catch (_) {}

        streamResult = await getMovieStreamPrimary(session, {
          detailPath: cleanDetailPath,
          quality: targetQuality,
        });
      }

      if (streamResult?.stream?.url || (Array.isArray(streamResult?.options) && streamResult.options.length > 0)) {
        break;
      }
    } catch (err) {
      lastError = err;
      console.warn(`[Resolver] Mirror ${host} failed:`, err.message);

      // Fallback scraper attempt on same host
      try {
        const fbSession = new FallbackSession({
          logger: createFallbackLogger(),
          host,
          defaultHeaders,
        });

        if (mediaType === 'episode') {
          const sNum = parseInt(season, 10) || 1;
          const eNum = parseInt(episode, 10) || 1;
          streamResult = await getEpisodeStreamFallback(fbSession, {
            detailPath: cleanDetailPath,
            season: sNum,
            episode: eNum,
            quality: targetQuality,
          });
        } else {
          streamResult = await getMovieStreamFallback(fbSession, {
            detailPath: cleanDetailPath,
            quality: targetQuality,
          });
        }

        if (streamResult?.stream?.url || (Array.isArray(streamResult?.options) && streamResult.options.length > 0)) {
          break;
        }
      } catch (fbErr) {
        lastError = fbErr;
      }
    }
  }

  // Extract stream & select quality (exact match or highest available)
  const options = Array.isArray(streamResult?.options) ? streamResult.options : [];
  let selectedStream = streamResult?.stream;

  if (targetQuality !== 'best' && options.length > 0) {
    const matched = options.find((opt) => {
      const qStr = (opt.quality || '').toString().toLowerCase().replace('p', '');
      const resStr = (opt.resolution || '').toString();
      return qStr === targetQuality || resStr === targetQuality;
    });

    if (matched && matched.url) {
      selectedStream = matched;
    }
  }

  // Fallback to highest resolution option if stream is not directly selected
  if ((!selectedStream || !selectedStream.url) && options.length > 0) {
    options.sort((a, b) => (parseInt(b.resolution, 10) || 0) - (parseInt(a.resolution, 10) || 0));
    selectedStream = options[0];
  }

  if (!selectedStream || !selectedStream.url) {
    return res.status(502).json({
      success: false,
      error: `Failed to resolve stream from MovieBox across all mirrors: ${lastError?.message || 'No stream found'}`,
    });
  }

  // Build output filename
  let fileName = sanitizeFileName(resolvedTitle);
  if (mediaType === 'episode') {
    const sNum = (parseInt(season, 10) || 1).toString().padStart(2, '0');
    const eNum = (parseInt(episode, 10) || 1).toString().padStart(2, '0');
    fileName = `${fileName}_S${sNum}E${eNum}.mp4`;
  } else {
    fileName = `${fileName}.mp4`;
  }

  const hostHeader = req.get('host') || 'pulsar-moviebox-api.onrender.com';
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const proxyUrl = `${protocol}://${hostHeader}/api/moviebox/proxy?url=${encodeURIComponent(selectedStream.url)}`;

  return res.status(200).json({
    success: true,
    url: selectedStream.url,
    proxyUrl,
    headers: REQUIRED_HEADERS,
    fileName,
    quality: selectedStream.quality || targetQuality,
    sizeBytes: selectedStream.sizeBytes || 0,
    detailPath: cleanDetailPath,
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MovieBox Resolve Server running on port ${PORT}`);
});

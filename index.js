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
 * Health check
 */
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

/**
 * Resolve direct MP4 download link from MovieBox across available mirrors
 */
app.post('/api/moviebox/resolve', async (req, res) => {
  const { detailPath, type, season, episode, quality } = req.body || {};

  if (!detailPath || typeof detailPath !== 'string' || !detailPath.trim()) {
    return res.status(400).json({
      error: 'Missing required field: detailPath must be a non-empty string.',
    });
  }

  const mediaType = (type || 'movie').toLowerCase();
  if (mediaType !== 'movie' && mediaType !== 'episode') {
    return res.status(400).json({
      error: 'Invalid field: type must be either "movie" or "episode".',
    });
  }

  const cleanDetailPath = detailPath.trim();
  const targetQuality = quality ? quality.toString().toLowerCase().replace('p', '') : 'best';

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
  let resolvedTitle = cleanDetailPath;
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

  return res.status(200).json({
    url: selectedStream.url,
    headers: REQUIRED_HEADERS,
    fileName,
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MovieBox Resolve Server running on port ${PORT}`);
});

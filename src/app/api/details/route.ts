import { NextRequest, NextResponse } from 'next/server';
import { malFetch, transformDetail, MAL_DETAIL_FIELDS, parseSlug, getCached, setCache } from '@/lib/mal';
import { getStreamingLinks, getDetailFallback } from '@/lib/jikan';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Max-Age': '86400' } });
}

// Resolve ID from various input formats:
//   ?id=16498 (numeric)          → MAL ID
//   ?malId=16498                 → MAL ID
//   ?anilistId=16498             → legacy: treated as MAL ID with a different cache key
//   ?id=attack-on-titan-16498    → parse MAL ID from slug
function resolveId(searchParams: URLSearchParams): { malId: number; cacheKey: string } | null {
  const raw = searchParams.get('id') || searchParams.get('malId') || searchParams.get('anilistId') || '';
  if (!raw) return null;

  if (searchParams.has('anilistId')) {
    // Legacy param — treated as MAL ID with a separate cache key
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n > 0) return { malId: n, cacheKey: `detail:al:${n}` };
    return null;
  }

  if (searchParams.has('malId')) {
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n > 0) return { malId: n, cacheKey: `detail:mal:${n}` };
    return null;
  }

  // id param — could be slug or number
  const parsed = parseSlug(raw);
  if (parsed) return { malId: parsed.malId, cacheKey: `detail:slug:${raw}` };

  const n = parseInt(raw, 10);
  if (!isNaN(n) && n > 0) return { malId: n, cacheKey: `detail:num:${n}` };

  return null;
}

// GET /api/details?id=attack-on-titan-16498
// GET /api/details?malId=16498
// GET /api/details?id=16498
//
// PRIMARY: Jikan GET /anime/{id}/full (no API key, includes trailer,
// streaming links and relations). FALLBACK: official MAL API v2
// GET /anime/{id}?fields={detail_fields}.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const resolved = resolveId(searchParams);

  if (!resolved) {
    return NextResponse.json({ success: false, error: 'Missing or invalid id parameter' }, { status: 400, headers: corsHeaders });
  }

  const cached = await getCached(resolved.cacheKey);
  if (cached) return NextResponse.json(cached);

  // --- Try Jikan first (primary source) ---
  let anime: any = null;
  let usedFallback = false;

  try {
    anime = await getDetailFallback(resolved.malId);

    // /full already includes a `streaming` array; top it up with the
    // dedicated /streaming endpoint only when it came back empty.
    // A failure here never fails the whole response.
    if (!anime.streamingLinks?.length) {
      const streamingLinks = await getStreamingLinks(resolved.malId).catch(() => []);
      anime = { ...anime, streamingLinks };
    }
  } catch (jikanErr) {
    console.warn(
      '[details] Jikan failed, falling back to official MAL API:',
      jikanErr instanceof Error ? jikanErr.message : jikanErr
    );

    // --- Jikan failed — fall back to the official MAL API v2 ---
    try {
      const media = await malFetch<any>(`/anime/${resolved.malId}`, {
        fields: MAL_DETAIL_FIELDS,
      });

      if (!media || !media.id) {
        return NextResponse.json({ success: false, error: 'Anime not found' }, { status: 404, headers: corsHeaders });
      }

      anime = transformDetail(media);

      // Streaming links are always Jikan-sourced regardless of which path served
      // the main data — a failure here never fails the whole response.
      const streamingLinks = await getStreamingLinks(resolved.malId).catch((err) => {
        console.warn('[details] streaming links unavailable:', err instanceof Error ? err.message : err);
        return [];
      });
      anime = { ...anime, streamingLinks };
      usedFallback = true;
    } catch (malErr) {
      console.error(
        '[details] official MAL fallback also failed:',
        malErr instanceof Error ? malErr.message : malErr
      );
      // Both sources failed — this is a real 502, nothing left to fall back to.
      return NextResponse.json(
        {
          success: false,
          error: 'Both Jikan and the official MAL API failed to return details',
          debug: {
            jikanError: jikanErr instanceof Error ? jikanErr.message : String(jikanErr),
            malError: malErr instanceof Error ? malErr.message : String(malErr),
          },
        },
        { status: 502, headers: { 'Cache-Control': 'no-store', ...corsHeaders } }
      );
    }
  }

  const body = { success: true, anime };

  // Shorter cache TTL for fallback data (12h vs 48h) — once Jikan recovers we
  // want to pick that back up sooner rather than serving stale MAL fallback
  // data for two full days.
  await setCache(resolved.cacheKey, [], body, usedFallback ? 43200 : 172800);

  return NextResponse.json(body, {
    headers: {
      'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1200',
      'X-Data-Source': usedFallback ? 'mal-fallback' : 'jikan',
      ...corsHeaders,
    },
  });
}

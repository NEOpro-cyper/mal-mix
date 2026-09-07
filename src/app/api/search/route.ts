import { NextRequest, NextResponse } from 'next/server';
import { ITEMS_PER_PAGE } from '@/lib/config';
import { malFetch, transformMedia, MAL_LIST_FIELDS, getCached, setCache } from '@/lib/mal';
import { searchAnime } from '@/lib/jikan';

// Empty response helper (reused for no-results & errors)
const emptyResponse = (page: number) => ({
  success: true as const,
  results: {
    data: [],
    pagination: { total: 0, currentPage: page, lastPage: 1, hasNextPage: false, perPage: ITEMS_PER_PAGE },
  },
});

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...corsHeaders, 'Access-Control-Max-Age': '86400' } });
}

// GET /api/search?keyword=naruto&page=1
//
// PRIMARY: Jikan GET /anime?q={keyword} (no API key, real pagination info).
// FALLBACK: official MAL API v2 GET /anime?q={keyword}&limit=20&offset=...
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const keyword = (searchParams.get('keyword') || '').trim();
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);

  if (!keyword) {
    return NextResponse.json(emptyResponse(page), {
      headers: { 'Cache-Control': 'public, s-maxage=300', ...corsHeaders },
    });
  }

  // Check cache
  const cached = await getCached('search', keyword, String(page));
  if (cached) return NextResponse.json(cached);

  try {
    // --- Jikan first (primary source) ---
    let body: any;
    try {
      const r = await searchAnime({ q: keyword, page, limit: ITEMS_PER_PAGE });

      if (!r.data.length) {
        body = emptyResponse(page);
      } else {
        body = {
          success: true,
          results: {
            data: r.data,
            pagination: {
              total: r.total ?? (r.hasNextPage ? (page + 1) * ITEMS_PER_PAGE : page * ITEMS_PER_PAGE),
              currentPage: page,
              lastPage: r.hasNextPage ? page + 1 : page,
              hasNextPage: r.hasNextPage,
              perPage: ITEMS_PER_PAGE,
            },
          },
        };
      }
    } catch (jikanErr) {
      console.warn(
        '[search] Jikan failed, falling back to official MAL API:',
        jikanErr instanceof Error ? jikanErr.message : jikanErr
      );

      // --- Official MAL API fallback ---
      const offset = (page - 1) * ITEMS_PER_PAGE;
      const res = await malFetch<{
        data: Array<{ node: any }>;
        paging?: { next?: string };
      }>('/anime', {
        q: keyword,
        limit: ITEMS_PER_PAGE,
        offset,
        fields: MAL_LIST_FIELDS,
        nsfw: 'false',
      });

      const items = res.data || [];
      if (!items.length) {
        body = emptyResponse(page);
      } else {
        // MAL doesn't return total — derive hasNextPage from the paging.next URL.
        const hasNextPage = !!res.paging?.next;
        body = {
          success: true,
          results: {
            data: items.map((item) => transformMedia(item.node)),
            pagination: {
              total: hasNextPage ? (page + 1) * ITEMS_PER_PAGE : page * ITEMS_PER_PAGE, // estimate
              currentPage: page,
              lastPage: hasNextPage ? page + 1 : page, // estimate
              hasNextPage,
              perPage: ITEMS_PER_PAGE,
            },
          },
        };
      }
    }

    await setCache('search', [keyword, String(page)], body, 86400); // 24 hours

    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600', ...corsHeaders },
    });
  } catch (err) {
    console.error('Search error:', err);
    return NextResponse.json(
      { ...emptyResponse(page), success: false, error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 502, headers: { 'Cache-Control': 'no-store', ...corsHeaders } }
    );
  }
}

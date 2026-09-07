'use client'

import { useCallback, useEffect, useState } from 'react'

type Endpoint = {
  name: string
  method: 'GET' | 'OPTIONS'
  path: string
  description: string
  sampleQuery?: string
  /** Primary backend this endpoint hits (all MAL-official endpoints are Jikan-first with MAL fallback) */
  backend: 'jikan' | 'mal-official' | 'miruro'
  /** Whether this endpoint falls back to the official MAL API (needs MAL_CLIENT_ID) */
  hasMalFallback?: boolean
}

const ENDPOINTS: Endpoint[] = [
  {
    name: 'Search',
    method: 'GET',
    path: '/api/search',
    description: 'Search anime by keyword. Jikan /anime?q= first, official MAL /anime?q= as fallback.',
    sampleQuery: '?keyword=naruto&page=1',
    backend: 'jikan',
    hasMalFallback: true,
  },
  {
    name: 'Category',
    method: 'GET',
    path: '/api/category/popular',
    description: 'Browse by category (popular / trending / airing / upcoming / movie / tv / ova / ona / music / spring-2025 / action / ...). Jikan /top/anime, /seasons, /anime?genres= first; MAL ranking/season as fallback.',
    sampleQuery: '?page=1',
    backend: 'jikan',
    hasMalFallback: true,
  },
  {
    name: 'Details',
    method: 'GET',
    path: '/api/details',
    description: 'Full anime details. Jikan /anime/{id}/full first (includes trailer, streaming, relations), official MAL /anime/{id} as fallback.',
    sampleQuery: '?malId=16498',
    backend: 'jikan',
    hasMalFallback: true,
  },
  {
    name: 'Characters',
    method: 'GET',
    path: '/api/characters',
    description: 'Paginated character list with Japanese VAs. Jikan /anime/{id}/characters — the official MAL API removed its characters endpoint in 2019.',
    sampleQuery: '?malId=16498&page=1',
    backend: 'jikan',
  },
  {
    name: 'Episodes',
    method: 'GET',
    path: '/api/episodes',
    description: 'Episode list with real titles + filler flags. Jikan /anime/{id}/episodes first; official MAL count-based generated list as fallback.',
    sampleQuery: '?malId=16498',
    backend: 'jikan',
    hasMalFallback: true,
  },
  {
    name: 'Schedule',
    method: 'GET',
    path: '/api/schedule',
    description: 'Next episode air time (computed from broadcast day/time in JST). Jikan /anime/{id} first, official MAL as fallback.',
    sampleQuery: '?malId=52991',
    backend: 'jikan',
    hasMalFallback: true,
  },
  {
    name: 'Servers (query)',
    method: 'GET',
    path: '/api/servers',
    description: 'Streaming servers from Miruro. MAL ID is resolved to AniList ID via Jikan /anime/{id}/external (Miruro requires AniList IDs).',
    sampleQuery: '?malId=16498',
    backend: 'miruro',
  },
  {
    name: 'Servers (path)',
    method: 'GET',
    path: '/api/servers/16498',
    description: 'Path-based servers route. Same flow as the query version.',
    sampleQuery: '?ep=1',
    backend: 'miruro',
  },
]

const BACKEND_LABEL: Record<Endpoint['backend'], { label: string; color: string }> = {
  'jikan': { label: 'Jikan (primary)', color: '#38bdf8' },
  'mal-official': { label: 'MAL API v2', color: '#fbbf24' },
  'miruro': { label: 'Miruro', color: '#34d399' },
}

export default function Home() {
  const [active, setActive] = useState<Endpoint | null>(null)
  const [customQuery, setCustomQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [response, setResponse] = useState<unknown>(null)
  const [error, setError] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState<number | null>(null)
  const [clientIdMissing, setClientIdMissing] = useState<boolean | null>(null)

  // Check whether MAL_CLIENT_ID is set by probing a MAL-fallback path
  useEffect(() => {
    fetch('/api/details?malId=16498')
      .then((r) => r.json())
      .then((data) => {
        if (!data.success && typeof data.error === 'string' && data.error.includes('MAL_CLIENT_ID')) {
          setClientIdMissing(true)
        } else {
          setClientIdMissing(false)
        }
      })
      .catch(() => setClientIdMissing(null))
  }, [])

  const runRequest = useCallback(async (ep: Endpoint, query: string) => {
    setLoading(true)
    setError(null)
    setResponse(null)
    setElapsedMs(null)
    const q = query.trim() || ep.sampleQuery || ''
    const url = q.startsWith('?') ? `${ep.path}${q}` : ep.path
    const start = Date.now()
    try {
      const res = await fetch(url)
      const data = await res.json().catch(() => ({ error: 'non-json response' }))
      setElapsedMs(Date.now() - start)
      if (!res.ok) {
        setError(`HTTP ${res.status} — ${data?.error || res.statusText}`)
      }
      setResponse(data)
    } catch (err) {
      setElapsedMs(Date.now() - start)
      setError(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (active) {
      setCustomQuery(active.sampleQuery || '')
    }
  }, [active])

  return (
    <main style={{ minHeight: '100vh', background: '#0b0d12', color: '#e6e8ec', fontFamily: 'ui-sans-serif, system-ui, sans-serif' }}>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '32px 20px 80px' }}>
        <header style={{ marginBottom: 28 }}>
          <h1 style={{ fontSize: 28, fontWeight: 700, margin: 0 }}>Anime API — Jikan (primary) + Official MAL v2 (fallback)</h1>
          <p style={{ color: '#9aa3b2', marginTop: 6, fontSize: 14 }}>
            MyAnimeList-backed API with <b>Jikan v4</b> as the primary source (no API key) for search / details / category / episodes /
            schedule / characters, and the <b>official MAL API v2</b> as the fallback for everything except characters
            (which MAL doesn&apos;t expose). No AniList anywhere — the MAL→AniList ID used by Miruro is resolved via Jikan&apos;s
            external-links data.
          </p>

          <div style={{ marginTop: 10, padding: '10px 12px', background: '#15171c', borderRadius: 8, fontSize: 12, color: '#9aa3b2', lineHeight: 1.6 }}>
            <b style={{ color: '#e6e8ec' }}>Endpoints:</b> {ENDPOINTS.length} &nbsp;·&nbsp;
            <b style={{ color: '#38bdf8' }}>Jikan (primary):</b> {ENDPOINTS.filter(e => e.backend === 'jikan').length} &nbsp;·&nbsp;
            <b style={{ color: '#34d399' }}>Miruro:</b> {ENDPOINTS.filter(e => e.backend === 'miruro').length} &nbsp;·&nbsp;
            <b style={{ color: '#fbbf24' }}>with MAL fallback:</b> {ENDPOINTS.filter(e => e.hasMalFallback).length}
            <br />
            <b style={{ color: '#e6e8ec' }}>Base URL:</b> http://localhost:3000 &nbsp;·&nbsp;
            <b style={{ color: '#e6e8ec' }}>Rate limits:</b> Jikan 3 req/s + 60 req/min (no key), MAL ~3 req/s (client ID), Miruro per-host
          </div>

          {clientIdMissing && (
            <div style={{ marginTop: 10, padding: '12px 14px', background: '#3b0d0d', border: '1px solid #7f1d1d', borderRadius: 8, fontSize: 13, color: '#fca5a5', lineHeight: 1.6 }}>
              <b>⚠️ MAL_CLIENT_ID is not set.</b> The app works fully on Jikan, but the official MAL fallback for those endpoints will fail until you set it.
              <ol style={{ margin: '8px 0 0 18px', padding: 0 }}>
                <li>Go to <a href="https://myanimelist.net/apiconfig" target="_blank" rel="noopener noreferrer" style={{ color: '#fca5a5', textDecoration: 'underline' }}>https://myanimelist.net/apiconfig</a> (log in with a free MAL account)</li>
                <li>Click &quot;Create ID&quot; → fill any App Name / Description / Redirect URI (use <code>http://localhost:3000</code>)</li>
                <li>Copy the &quot;Client ID&quot; (NOT the secret)</li>
                <li>Edit <code>.env</code> and paste it after <code>MAL_CLIENT_ID=</code></li>
                <li>Restart the dev server</li>
              </ol>
            </div>
          )}

          {clientIdMissing === false && (
            <div style={{ marginTop: 10, padding: '10px 12px', background: '#0a2a0a', border: '1px solid #15803d', borderRadius: 8, fontSize: 13, color: '#86efac', lineHeight: 1.6 }}>
              ✓ Jikan is the primary source (no key needed). MAL_CLIENT_ID is set — the official MAL fallback is armed.
            </div>
          )}
        </header>

        <section style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 24 }}>
          {ENDPOINTS.map((ep) => {
            const activeNow = active?.name === ep.name && active?.path === ep.path
            const bl = BACKEND_LABEL[ep.backend]
            return (
              <button
                key={ep.name + ep.path}
                onClick={() => setActive(ep)}
                style={{
                  textAlign: 'left',
                  padding: '14px 16px',
                  background: activeNow ? '#1a3a5f' : '#15171c',
                  border: activeNow ? '1px solid #3b82f6' : '1px solid #24272e',
                  borderRadius: 8,
                  cursor: 'pointer',
                  color: '#e6e8ec',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                  <span style={{ background: '#1f6feb', color: 'white', padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 600 }}>{ep.method}</span>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{ep.name}</span>
                  <span style={{ background: bl.color + '22', color: bl.color, padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 600, border: `1px solid ${bl.color}55` }}>{bl.label}</span>
                  {ep.hasMalFallback && clientIdMissing && (
                    <span style={{ color: '#f87171', fontSize: 11 }}>● MAL fallback needs client ID</span>
                  )}
                </div>
                <code style={{ color: '#7dd3fc', fontSize: 12 }}>{ep.path}</code>
                <div style={{ color: '#9aa3b2', fontSize: 12, marginTop: 4 }}>{ep.description}</div>
              </button>
            )
          })}
        </section>

        {active && (
          <section style={{ background: '#15171c', border: '1px solid #24272e', borderRadius: 10, padding: 18 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
              <code style={{ color: '#7dd3fc', fontSize: 13 }}>{active.path}</code>
              <input
                value={customQuery}
                onChange={(e) => setCustomQuery(e.target.value)}
                placeholder="?malId=16498"
                style={{ flex: 1, minWidth: 200, padding: '8px 10px', background: '#0b0d12', border: '1px solid #24272e', borderRadius: 6, color: '#e6e8ec', fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
              />
              <button
                onClick={() => void runRequest(active, customQuery)}
                disabled={loading}
                style={{ padding: '8px 18px', background: loading ? '#24272e' : '#1f6feb', border: 'none', borderRadius: 6, color: 'white', cursor: loading ? 'default' : 'pointer', fontWeight: 600, fontSize: 13 }}
              >
                {loading ? 'Running…' : 'Run'}
              </button>
              {elapsedMs !== null && (
                <span style={{ color: '#9aa3b2', fontSize: 12 }}>{elapsedMs} ms</span>
              )}
            </div>

            {error && (
              <div style={{ padding: '10px 12px', background: '#3b0d0d', border: '1px solid #7f1d1d', borderRadius: 6, color: '#fca5a5', marginBottom: 12, fontSize: 13, fontFamily: 'ui-monospace, monospace' }}>
                {error}
              </div>
            )}

            <div style={{ background: '#0b0d12', border: '1px solid #24272e', borderRadius: 8, padding: 14, maxHeight: 500, overflow: 'auto' }}>
              <pre style={{ margin: 0, color: '#cdd3de', fontSize: 12, lineHeight: 1.5, fontFamily: 'ui-monospace, monospace' }}>
{response === null ? 'Click Run to send the request.' : JSON.stringify(response, null, 2)}
              </pre>
            </div>
          </section>
        )}

        <footer style={{ marginTop: 32, padding: 12, background: '#15171c', border: '1px solid #24272e', borderRadius: 8, fontSize: 12, color: '#9aa3b2' }}>
          <b>Slug format:</b> <code>{'{anime-name}-{malId}'}</code> &nbsp;·&nbsp; e.g. <code>attack-on-titan-16498</code>
          <br />
          <b>Accepted params:</b> <code>?malId=16498</code> · <code>?id=16498</code> · <code>?id=attack-on-titan-16498</code> · <code>?anilistId=147105</code> (legacy)
          <br />
          <b>Servers:</b> Miruro requires AniList IDs. The <code>/api/servers</code> endpoint auto-resolves MAL→AniList via Jikan <code>/anime/{'{id}'}/external</code> (cached 30 days).
          <br />
          <b>Characters:</b> MAL API v2 removed its characters endpoint in 2019. We use Jikan <code>/anime/{'{id}'}/characters</code> — same data, no auth needed.
        </footer>
      </div>
    </main>
  )
}

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GoogleGenAI } from '@google/genai'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(__dirname)
const isDev = process.argv.includes('--dev')

loadEnvFile('.env')
loadEnvFile('.env.local')

const port = Number(process.env.PORT || 5174)
const host = process.env.HOST || (isDev ? '127.0.0.1' : '0.0.0.0')
const publicHost = host === '0.0.0.0' ? '127.0.0.1' : host
const allowedOrigins = parseAllowedOrigins(process.env.CORS_ORIGIN)
const LIVE_MODEL = process.env.NEXA_LIVE_MODEL || 'gemini-3.1-flash-live-preview'
const SYSTEM_INSTRUCTION =
  process.env.NEXA_SYSTEM_INSTRUCTION ||
  'Tu es Nexa, un assistant visuel et vocal en direct. Reponds en francais, avec des phrases courtes et naturelles. Quand la camera apporte du contexte, decris ce que tu vois.'

const liveConfig = {
  responseModalities: ['AUDIO'],
  mediaResolution: 'MEDIA_RESOLUTION_LOW',
  outputAudioTranscription: {},
  systemInstruction: SYSTEM_INSTRUCTION,
}

let vite
if (isDev) {
  const { createServer: createViteServer } = await import('vite')
  vite = await createViteServer({
    root,
    server: { middlewareMode: true },
    appType: 'spa',
  })
}

const requestHandler = async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`)
    applyCors(req, res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, model: LIVE_MODEL })
      return
    }

    if (url.pathname === '/api/live-token') {
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'Method not allowed' })
        return
      }
      await handleLiveToken(res)
      return
    }

    if (vite) {
      vite.middlewares(req, res)
      return
    }

    await serveStatic(url.pathname, res)
  } catch (error) {
    console.error(error)
    sendJson(res, 500, { error: 'Erreur serveur Nexa.' })
  }
}

listen(port)

async function handleLiveToken(res) {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
  if (!apiKey) {
    sendJson(res, 500, {
      error:
        'GEMINI_API_KEY manque cote backend. Ajoute une cle API Gemini dans .env.local puis relance le serveur.',
    })
    return
  }

  if (!apiKey.startsWith('AIza')) {
    sendJson(res, 500, {
      error:
        'GEMINI_API_KEY ne ressemble pas a une cle API Gemini. Utilise une cle API Google AI Studio qui commence generalement par "AIza", pas un token ephemere.',
    })
    return
  }

  const client = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: 'v1alpha' } })
  const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString()
  const newSessionExpireTime = new Date(Date.now() + 60 * 1000).toISOString()

  let token
  try {
    token = await client.authTokens.create({
      config: {
        uses: 1,
        expireTime,
        newSessionExpireTime,
        liveConnectConstraints: {
          model: LIVE_MODEL,
          config: liveConfig,
        },
        httpOptions: { apiVersion: 'v1alpha' },
      },
    })
  } catch (error) {
    console.error('Gemini token error:', error.message)
    sendJson(res, 502, {
      error:
        `Gemini refuse le token Live pour le modele "${LIVE_MODEL}". ` +
        'Verifie NEXA_LIVE_MODEL et utilise une vraie cle API Gemini cote backend.',
    })
    return
  }

  sendJson(res, 200, {
    token: token.name,
    model: LIVE_MODEL,
    config: liveConfig,
  })
}

async function serveStatic(pathname, res) {
  const dist = join(root, 'dist')
  const normalizedPath = pathname === '/' ? '/index.html' : pathname
  const filePath = resolve(join(dist, normalizedPath))

  if (!filePath.startsWith(dist) || !existsSync(filePath)) {
    const fallback = join(dist, 'index.html')
    if (!existsSync(fallback)) {
      sendText(res, 404, 'Build manquant. Lance npm run build.')
      return
    }
    sendText(res, 200, await readFile(fallback, 'utf8'), 'text/html')
    return
  }

  const body = await readFile(filePath)
  sendBuffer(res, 200, body, mimeType(filePath))
}

function loadEnvFile(name) {
  const filePath = join(root, name)
  if (!existsSync(filePath)) return

  const content = readFileSync(filePath, 'utf8')
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const [key, ...valueParts] = line.split('=')
    if (!process.env[key]) {
      process.env[key] = valueParts.join('=').trim().replace(/^["']|["']$/g, '')
    }
  }
}

function sendJson(res, status, body) {
  sendText(res, status, JSON.stringify(body), 'application/json')
}

function sendText(res, status, body, type = 'text/plain') {
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendBuffer(res, status, body, type) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'public, max-age=3600',
  })
  res.end(body)
}

function mimeType(filePath) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  }
  return types[extname(filePath)] || 'application/octet-stream'
}

function listen(candidatePort, attempt = 0) {
  const server = createServer(requestHandler)

  server.once('error', (error) => {
    if (error.code === 'EADDRINUSE' && attempt < 20) {
      const nextPort = candidatePort + 1
      console.warn(`Port ${candidatePort} occupe, essai sur ${nextPort}...`)
      listen(nextPort, attempt + 1)
      return
    }

    throw error
  })

  server.listen(candidatePort, host, () => {
    console.log(`Nexa ready: http://${publicHost}:${candidatePort}/`)
  })
}

function parseAllowedOrigins(value) {
  if (!value) return []
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
}

function applyCors(req, res) {
  const origin = req.headers.origin
  if (!origin) return

  const isAllowed =
    allowedOrigins.includes('*') ||
    allowedOrigins.includes(origin) ||
    (isDev && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin))

  if (!isAllowed) return

  res.setHeader('access-control-allow-origin', origin)
  res.setHeader('vary', 'Origin')
  res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
  res.setHeader('access-control-allow-headers', 'content-type')
}

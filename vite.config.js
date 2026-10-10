import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// Dev-only: serve the edge function at /api/data from the Vite dev server.
// Without KV_REST_API_URL/KV_REST_API_TOKEN it uses an in-memory KV (see dev/kv-memory.js).
function localApi() {
  return {
    name: 'homefin-local-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/data', async (req, res) => {
        try {
          const { default: handler } = await server.ssrLoadModule('/api/data.js')
          const chunks = []
          for await (const chunk of req) chunks.push(chunk)
          const body = chunks.length ? Buffer.concat(chunks) : undefined
          const request = new Request(`http://${req.headers.host}/api/data${req.url === '/' ? '' : req.url}`, {
            method: req.method,
            headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
          })
          const response = await handler(request)
          res.statusCode = response.status
          response.headers.forEach((value, key) => res.setHeader(key, value))
          res.end(Buffer.from(await response.arrayBuffer()))
        } catch (e) {
          console.error(e)
          res.statusCode = 500
          res.end(JSON.stringify({ error: String(e?.message || e) }))
        }
      })
    },
  }
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  Object.assign(process.env, env)
  const useMemoryKv = command === 'serve' && !(env.KV_REST_API_URL && env.KV_REST_API_TOKEN)
  return {
    plugins: [react(), localApi()],
    resolve: useMemoryKv
      ? { alias: { '@vercel/kv': fileURLToPath(new URL('./dev/kv-memory.js', import.meta.url)) } }
      : {},
  }
})

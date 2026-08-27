import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'

/** Captured request from the ModelHub stand-in. */
interface CapturedRequest {
  /** Request URL including query parameters. */
  url: string
  /** Request headers. */
  headers: IncomingHttpHeaders
  /** Parsed JSON body. */
  body: unknown
}

/** Running ModelHub stand-in. */
export interface ModelHubServer {
  /** Loopback origin. */
  origin: string
  /** Requests in arrival order. */
  requests: CapturedRequest[]
  /** Close the listener. */
  close(): Promise<void>
}

/** Minimal successful Chat Completions SSE body. */
const SUCCESS_EVENTS = [
  '{"choices":[{"delta":{"role":"assistant","content":""},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{"content":"hello"},"index":0,"finish_reason":null}]}',
  '{"choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}',
  '[DONE]',
]

/** Start one exact-path HTTP server with a fixed response. */
export async function startModelHubServer(response: { status?: number; body?: string } = {}): Promise<ModelHubServer> {
  const requests: CapturedRequest[] = []
  const server: Server = createServer((request, reply) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      requests.push({
        url: request.url ?? '',
        headers: { ...request.headers },
        body: body.length === 0 ? undefined : JSON.parse(body),
      })
      const status = response.status ?? 200
      if (status !== 200) {
        reply.writeHead(status, { 'content-type': 'application/json' })
        reply.end(response.body ?? '{}')
        return
      }
      reply.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of SUCCESS_EVENTS) reply.write(`data: ${event}\n\n`)
      reply.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('ModelHub test server has no TCP port')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }),
  }
}

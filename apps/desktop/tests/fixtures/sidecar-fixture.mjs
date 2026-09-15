const token = process.env.DSH_DESKTOP_TOKEN
let keepAlive = true

switch (token) {
  case 'fragmented':
    process.stdout.write('fixture booting\nunrelated line\n')
    process.stdout.write('dsh web: http://127.')
    setTimeout(() => {
      process.stdout.write('0.0.1:37615\n')
    }, 5)
    break
  case 'graceful':
    process.stdout.write('dsh web: http://127.0.0.1:37615\n')
    break
  case 'term':
    process.stdout.write('dsh web: http://127.0.0.1:37615\n')
    process.stdin.once('end', () => {
      setInterval(() => {}, 60_000)
    })
    break
  case 'kill':
    process.stdout.write('dsh web: http://127.0.0.1:37615\n')
    process.on('SIGTERM', () => {})
    process.stdin.once('end', () => {
      setInterval(() => {}, 60_000)
    })
    break
  case 'natural-exit':
    process.stdout.write('dsh web: http://127.0.0.1:37615\n')
    setTimeout(() => {
      process.exit()
    }, 25)
    break
  case 'duplicate':
    process.stdout.write('dsh web: http://127.0.0.1:37615\n')
    process.stdout.write('dsh web: http://127.0.0.1:37615\n')
    break
  case 'malformed-origin':
    process.stdout.write('dsh web: http://localhost:37615\n')
    break
  case 'malformed-readiness':
    process.stdout.write('dsh web: ready\n')
    break
  case 'early-exit':
    process.exitCode = 23
    keepAlive = false
    break
  case 'port-conflict':
    process.stderr.write(`listen EADDRINUSE: address already in use ${token}\n`)
    process.exitCode = 1
    keepAlive = false
    break
  case 'timeout':
    break
  default:
    if (token?.startsWith('stderr-tail:') === true) {
      process.stderr.write(`${'discarded-prefix-'.repeat(12)}${token}:tail-marker\n`)
      process.exitCode = 17
      keepAlive = false
      break
    }
    process.stderr.write('unknown fixture scenario\n')
    process.exitCode = 64
    keepAlive = false
}

if (keepAlive) {
  process.stdin.resume()
  process.stdin.once('end', () => {
    if (token === 'term' || token === 'kill') return
    process.exit()
  })
}

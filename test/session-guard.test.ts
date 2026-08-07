import { describe, it, expect } from 'vitest'
import { SingleSessionGuard } from '../src/session-guard.js'

// BUG: ledger/epoch/meter in index.ts are process-wide module singletons. That is only
// safe because this server's stdio transport is strictly one-client-per-process (verified
// against @modelcontextprotocol/sdk: Protocol.connect() throws "Already connected to a
// transport" on a second connect, and StdioServerTransport never populates
// RequestHandlerExtra.sessionId — that field is only set by HTTP-based transports). This
// guard makes the invariant explicit and fails loudly, with a clear message naming the
// limitation, instead of silently cross-contaminating state if that invariant is ever
// violated by a future refactor.
describe('SingleSessionGuard', () => {
  it('allows exactly one claim', () => {
    const guard = new SingleSessionGuard()
    expect(() => guard.claim()).not.toThrow()
    expect(guard.isClaimed()).toBe(true)
  })

  it('refuses a second concurrent claim with a clear error naming the limitation', () => {
    const guard = new SingleSessionGuard()
    guard.claim()
    expect(() => guard.claim()).toThrow(/one client per process|single|session/i)
  })
})

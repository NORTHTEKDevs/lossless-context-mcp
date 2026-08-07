// Single-session invariant for the stdio MCP transport.
//
// index.ts holds process-wide singleton state (LosslessEngine ledger, epoch, ContextMeter).
// That is only safe because exactly one client is ever connected to this process:
//   - StdioServerTransport binds directly to this process's stdin/stdout — there is no
//     multiplexing of multiple clients over one stdio pipe.
//   - The MCP SDK's Protocol.connect() throws ("Already connected to a transport...") if
//     called a second time on the same Server instance.
//   - RequestHandlerExtra.sessionId is never populated for stdio — only HTTP-based
//     transports (SSE/StreamableHTTP) set it — so there is no SDK-exposed identity to
//     scope state by even if we wanted per-session ledgers.
//
// If this invariant is ever violated (e.g. a future refactor multiplexes clients over one
// process), the shared ledger/epoch/meter would silently cross-contaminate between clients:
// wrong dedup bases, wrong receipts. Fail loud instead — claim the single session up front
// and refuse a second claim with an error that names the limitation, rather than a
// confusing downstream state-corruption bug.
export class SingleSessionGuard {
  private claimed = false

  claim(): void {
    if (this.claimed) {
      throw new Error(
        'lossless-context-mcp: this server process already has an active session. ' +
          'This server holds process-wide ledger/epoch/meter state and supports exactly ' +
          'one client per process (the stdio transport has no session concept, and the ' +
          'MCP SDK refuses a second transport connection on one Server instance). ' +
          'Concurrent clients must each spawn their own server process instead of sharing one.',
      )
    }
    this.claimed = true
  }

  isClaimed(): boolean {
    return this.claimed
  }
}

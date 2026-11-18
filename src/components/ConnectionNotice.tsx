/**
 * Says plainly when the page cannot be trusted to be current: the server is
 * unreachable, or the session has ended. Functional, not designed.
 */

import { Button } from '@/components/ui'
import type { LinkProblem } from '@/lib/game-api'

export function ConnectionNotice({ problem, onRetry }: { problem: LinkProblem; onRetry: () => void }) {
  if (problem === null) return null
  if (problem === 'signed_out') {
    return (
      <div role="alert" className="rounded-md border border-destructive p-3 text-sm" data-testid="session-expired">
        <p>Your session has expired. Nothing you see here is lost — sign in again to continue.</p>
        <div className="mt-2 flex gap-2">
          <Button variant="secondary" onClick={onRetry} data-testid="session-retry">
            Try again
          </Button>
          <Button variant="secondary" onClick={() => window.location.reload()}>
            Reload and sign in
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div role="alert" className="rounded-md border border-destructive p-3 text-sm" data-testid="connection-warning">
      <p>
        Connection lost — reconnecting. What you see may be out of date, and the simulation clock keeps running on the
        server.
      </p>
      <Button variant="secondary" className="mt-2" onClick={onRetry} data-testid="connection-retry">
        Retry now
      </Button>
    </div>
  )
}

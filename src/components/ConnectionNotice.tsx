/**
 * Says plainly when the page cannot be trusted to be current: the server is
 * unreachable, or the session has ended.
 */

import { RefreshCw, UserX, WifiOff } from 'lucide-react'
import { Button } from '@/components/ui'
import type { LinkProblem } from '@/lib/game-api'

export function ConnectionNotice({ problem, onRetry }: { problem: LinkProblem; onRetry: () => void }) {
  if (problem === null) return null
  if (problem === 'signed_out') {
    return (
      <div role="alert" className="flex flex-col gap-3 rounded-xl border border-critical/50 bg-critical-surface p-4 sm:flex-row sm:items-center sm:justify-between" data-testid="session-expired">
        <p className="flex items-start gap-3 text-sm">
          <UserX className="mt-0.5 size-4 shrink-0 text-critical" aria-hidden />
          <span>Your session has expired. Nothing you see here is lost — sign in again to continue.</span>
        </p>
        <div className="flex shrink-0 gap-2">
          <Button size="sm" onClick={onRetry} data-testid="session-retry">
            Try again
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Reload and sign in
          </Button>
        </div>
      </div>
    )
  }
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-xl border border-caution/50 bg-caution-surface p-4 sm:flex-row sm:items-center sm:justify-between" data-testid="connection-warning">
      <p className="flex items-start gap-3 text-sm">
        <WifiOff className="mt-0.5 size-4 shrink-0 text-caution" aria-hidden />
        <span>Connection lost — reconnecting. What you see may be out of date, and the simulation clock keeps running on the server.</span>
      </p>
      <Button size="sm" variant="outline" className="shrink-0" onClick={onRetry} data-testid="connection-retry">
        <RefreshCw aria-hidden /> Retry now
      </Button>
    </div>
  )
}

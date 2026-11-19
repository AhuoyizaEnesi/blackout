/**
 * Home: the two ways to play, and a way in for someone not signed in yet.
 *
 * Not behind the sign-in gate, so a signed-out visitor sees what the app is
 * and one clear way to sign in.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { AuthOverlay, useAuthProfileReady } from 'deepspace'
import { Button } from '@/components/ui'
import { Page, PageHeader } from '@/components/PageHeader'
import { cn } from '@/lib/utils'

const ENTRY = 'group flex min-h-[17rem] flex-col justify-between gap-10 py-8 transition-colors duration-150 hover:bg-secondary/60 md:px-8'

export default function HomePage() {
  const { isLoaded, isSignedIn, user } = useAuthProfileReady({ requireUser: true })
  const [showAuth, setShowAuth] = useState(false)
  const firstName = (user?.name ?? '').trim().split(/\s+/)[0]

  return (
    <Page>
      <PageHeader
        eyebrow="Operation Nightfall"
        title={isSignedIn && firstName ? `Ready when you are, ${firstName}.` : 'Eight minutes to contain a breach.'}
        lead="Customers of Meridian Cloud cannot sign in and the cause is unknown. Investigate, contain the threat and restore the service before the executive bridge call."
      />

      {isLoaded && !isSignedIn && (
        <section className="flex flex-col gap-4 border-b border-border-strong py-6 sm:flex-row sm:items-center sm:justify-between" data-testid="home-signed-out">
          <div>
            <h2 className="kicker">Sign in to play</h2>
            <p className="mt-2 text-sm text-muted-foreground">Your runs, rooms and reports are kept with your account. Nothing else is asked of you.</p>
          </div>
          <Button size="lg" className="h-12 px-8 text-[15px] font-bold" onClick={() => setShowAuth(true)} data-testid="home-sign-in">
            Sign in
          </Button>
        </section>
      )}

      <div className="grid border-b border-border-strong md:grid-cols-2">
        <Link to="/simulation" className={cn(ENTRY, 'border-b border-border md:border-b-0 md:border-r md:pl-0')} data-testid="home-solo">
          <p className="numeral text-[3.25rem] text-subtle" aria-hidden>
            01
          </p>
          <div>
            <h2 className="text-[clamp(1.75rem,1.2rem+1.6vw,2.5rem)] font-extrabold leading-none tracking-[-0.025em]">Solo run</h2>
            <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-muted-foreground">Play all three roles yourself. The clock starts the moment you do.</p>
            <span className="mt-6 inline-flex items-center gap-2 border-b border-foreground pb-1 text-sm font-bold">
              Start a simulation <ArrowRight className="size-4 transition-transform duration-150 group-hover:translate-x-1" aria-hidden />
            </span>
          </div>
        </Link>
        <Link to="/team" className={ENTRY} data-testid="home-team">
          <p className="numeral text-[3.25rem] text-subtle" aria-hidden>
            02
          </p>
          <div>
            <h2 className="text-[clamp(1.75rem,1.2rem+1.6vw,2.5rem)] font-extrabold leading-none tracking-[-0.025em]">Team of three</h2>
            <p className="mt-3 max-w-sm text-[15px] leading-relaxed text-muted-foreground">
              Create a room or join one with a code. One role each; private findings; the commander approves the big calls.
            </p>
            <span className="mt-6 inline-flex items-center gap-2 border-b border-foreground pb-1 text-sm font-bold">
              Create or join a room <ArrowRight className="size-4 transition-transform duration-150 group-hover:translate-x-1" aria-hidden />
            </span>
          </div>
        </Link>
      </div>

      <p className="pt-5 text-sm text-muted-foreground">
        <Link to="/history" className="font-semibold text-foreground underline" data-testid="home-history">
          Your past runs and reports
        </Link>
      </p>

      {showAuth && <AuthOverlay onClose={() => setShowAuth(false)} />}
    </Page>
  )
}

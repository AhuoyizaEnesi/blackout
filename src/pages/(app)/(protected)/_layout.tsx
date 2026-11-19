/**
 * Gated routes. Any file under src/pages/(app)/(protected)/ requires sign-in.
 * The `(protected)` folder is a Generouted route group — parentheses mean
 * it doesn't appear in the URL. For a dynamic page that does NOT require
 * sign-in, put it directly under src/pages/(app)/; for a static page, put it
 * at the top level of src/pages/.
 *
 * Children may call data hooks like `useUser()` safely because the parent
 * (app)/_layout.tsx mounts <RecordProvider> above this layout.
 *
 * The `fallback` keeps signed-out visitors inside the app's own chrome
 * (without it, AuthGate shows the SDK's full-screen, non-dismissible
 * overlay). The sign-in overlay opens on demand and can be dismissed.
 */

import { useState } from 'react'
import { Link, Outlet } from 'react-router-dom'
import { AuthGate, AuthOverlay } from 'deepspace'
import { Button } from '@/components/ui'

export default function ProtectedLayout() {
  return (
    <AuthGate fallback={<SignedOutPanel />}>
      <Outlet />
    </AuthGate>
  )
}

function SignedOutPanel() {
  const [showAuthModal, setShowAuthModal] = useState(false)

  return (
    <div className="flex min-h-[70vh] items-center justify-center px-5 py-16">
      <div className="panel w-full max-w-sm p-7 text-center" data-testid="signed-out-panel">
        <p className="eyebrow">Operation Nightfall</p>
        <h1 className="mt-2 text-xl font-bold text-foreground">Sign in to continue</h1>
        <p className="mt-2 text-sm text-muted-foreground">Simulations, rooms and their postmortems are kept with your account.</p>
        <Button className="mt-6 w-full" size="lg" onClick={() => setShowAuthModal(true)} data-testid="gate-sign-in">
          Sign in
        </Button>
        <Link to="/" className="mt-4 inline-block text-sm text-muted-foreground underline hover:text-foreground">
          What is BLACKOUT?
        </Link>
      </div>

      {showAuthModal && <AuthOverlay onClose={() => setShowAuthModal(false)} />}
    </div>
  )
}

/**
 * Account settings. Reached at /settings — no auth logic lives here because
 * (protected)/_layout.tsx already wraps the subtree in <AuthGate>.
 */

import { LogOut } from 'lucide-react'
import { signOut, useUser } from 'deepspace'
import { Button } from '@/components/ui'
import { Page, PageHeader } from '@/components/PageHeader'

export default function SettingsPage() {
  const { user } = useUser()

  return (
    <Page narrow>
      <PageHeader eyebrow="Account" title="Settings" />
      <section aria-labelledby="account-heading" className="py-8">
        <h2 id="account-heading" className="kicker">
          Your account
        </h2>
        <dl className="mt-4 divide-y divide-border border-y border-border-strong text-sm">
          <div className="flex flex-col gap-0.5 py-3 sm:flex-row sm:justify-between">
            <dt className="text-muted-foreground">Name</dt>
            <dd className="break-words text-foreground">{user?.name ?? '—'}</dd>
          </div>
          <div className="flex flex-col gap-0.5 py-3 sm:flex-row sm:justify-between">
            <dt className="text-muted-foreground">Email</dt>
            <dd className="break-all text-foreground">{user?.email ?? '—'}</dd>
          </div>
        </dl>
        <p className="mt-2 text-xs text-muted-foreground">Teammates in a room see your name. Your email is not shown to them.</p>
        <Button variant="outline" className="mt-5 bg-transparent" onClick={() => signOut()}>
          <LogOut aria-hidden /> Sign out
        </Button>
      </section>
    </Page>
  )
}

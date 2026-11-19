/**
 * The top of every app page: a small label, a strong heading, one sentence.
 */

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function Page({ children, className, narrow = false }: { children: ReactNode; className?: string; narrow?: boolean }) {
  return <div className={cn('w-full px-4 pb-12 sm:px-6 lg:px-10', narrow ? 'max-w-4xl' : 'max-w-[90rem]', className)}>{children}</div>
}

export function PageHeader({ eyebrow, title, lead, aside }: { eyebrow: string; title: string; lead?: ReactNode; aside?: ReactNode }) {
  return (
    <header className="grid gap-x-10 gap-y-5 border-b border-border-strong py-8 lg:grid-cols-12 lg:items-end lg:py-10">
      <div className="min-w-0 lg:col-span-7">
        <p className="eyebrow">{eyebrow}</p>
        <h1 className="mt-4 text-[clamp(2.25rem,1.4rem+3.2vw,4.25rem)] font-extrabold leading-[0.98] tracking-[-0.035em]">{title}</h1>
      </div>
      {(lead || aside) && (
        <div className="min-w-0 lg:col-span-5 lg:pb-1.5">
          {lead && <p className="max-w-xl text-[15px] leading-relaxed text-muted-foreground">{lead}</p>}
          {aside && <div className="mt-4">{aside}</div>}
        </div>
      )}
    </header>
  )
}

/** A quiet message standing in for content: loading, nothing yet, not available. */
export function StateMessage({
  children,
  testId,
  tone = 'neutral',
  attrs,
}: {
  children: ReactNode
  testId?: string
  tone?: 'neutral' | 'critical'
  attrs?: Record<string, string>
}) {
  return (
    <p
      className={cn('border-l-2 px-4 py-3 text-sm', tone === 'critical' ? 'border-critical bg-critical-surface text-foreground' : 'border-border-strong bg-card text-muted-foreground')}
      data-testid={testId}
      {...attrs}
    >
      {children}
    </p>
  )
}

/**
 * The BLACKOUT wordmark: heavy type, the operation's name beneath, and one
 * red stroke. No hooks, so static pages can use it too.
 */

import { cn } from '@/lib/utils'

export function Brand({ className, size = 'md' }: { className?: string; size?: 'md' | 'lg' }) {
  return (
    <span className={cn('inline-flex items-center gap-3', className)}>
      <span className="flex flex-col leading-none">
        <span className={cn('font-display font-extrabold tracking-[0.08em] text-foreground', size === 'lg' ? 'text-2xl' : 'text-lg')}>BLACKOUT</span>
        <span className={cn('mt-1 text-muted-foreground', size === 'lg' ? 'text-sm' : 'text-xs')}>Operation Nightfall</span>
      </span>
      <span className={cn('w-px origin-center rotate-[18deg] bg-critical', size === 'lg' ? 'h-10' : 'h-8')} aria-hidden />
    </span>
  )
}

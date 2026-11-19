/**
 * App navigation: a side rail on wide screens, a top bar with a menu below.
 *
 * One element serves both layouts, so every control exists once. Links come
 * from nav.ts (with role/dev filtering); sign-in opens <AuthOverlay>. Keep
 * the data-testid hooks (`app-navigation`, `nav-sign-in-button`,
 * `nav-user-name`, `nav-user-email`) — the tests rely on them.
 * `nav-user-email` is the one that carries an identity a test can check
 * exactly: a display name is optional, the email is the credential the
 * session was opened with.
 */

import { useState, useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { AuthOverlay, useAuthProfileReady, signOut } from 'deepspace'
import { ChevronDown, History, Home, LogOut, Menu, Settings, Users, X, Zap, type LucideIcon } from 'lucide-react'
import type { Role } from '../constants'
import { nav } from '../nav'
import { cn } from '../lib/utils'
import { Brand } from './Brand'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui'

const ICONS: Record<string, LucideIcon> = {
  '/home': Home,
  '/simulation': Zap,
  '/team': Users,
  '/history': History,
  '/settings': Settings,
}

export default function Navigation() {
  const { isLoaded, isSignedIn, user, userLoading } = useAuthProfileReady({ requireUser: true })
  const location = useLocation()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [showAuthModal, setShowAuthModal] = useState(false)

  const profileReady = !isSignedIn || (!userLoading && !!user)
  const userRole = (user?.role ?? 'anonymous') as Role | 'anonymous'

  // Close the mobile menu when navigating
  useEffect(() => {
    setMobileMenuOpen(false)
  }, [location.pathname, location.search])

  const visibleNav = nav.filter((item) => {
    if (item.devOnly && !import.meta.env.DEV) return false
    if (!item.roles) return true
    if (!profileReady) return false
    if (userRole === 'admin') return true
    return item.roles.includes(userRole as Role)
  })

  const navLink = (item: (typeof nav)[number]) => {
    const active = location.pathname.startsWith(item.path)
    const Icon = ICONS[item.path]
    return (
      <Link
        key={item.path}
        to={item.path}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors duration-150',
          active ? 'bg-secondary text-foreground shadow-[inset_2px_0_0_var(--color-critical)]' : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
        )}
      >
        {Icon && <Icon className="size-4 shrink-0" aria-hidden />}
        {item.label}
      </Link>
    )
  }

  return (
    <>
      <nav
        data-testid="app-navigation"
        aria-label="Main"
        data-print="hide"
        className="relative z-30 flex shrink-0 flex-col border-b border-border bg-card lg:h-full lg:w-60 lg:border-b-0 lg:border-r"
      >
        <div className="flex h-14 items-center gap-3 px-4 lg:h-auto lg:min-h-0 lg:flex-1 lg:flex-col lg:items-stretch lg:gap-0 lg:px-0">
          <Link to="/home" className="rounded-md lg:mx-5 lg:mb-6 lg:mt-6" aria-label="BLACKOUT home">
            <Brand />
          </Link>

          <div className="hidden lg:flex lg:flex-col lg:gap-1 lg:px-3">{visibleNav.map(navLink)}</div>

          <div className="flex-1" />

          <div className="lg:border-t lg:border-border lg:p-3">
            {!isLoaded ? null : isSignedIn && !profileReady ? (
              /* Signed in, profile still loading — skeleton, never the Sign in
                 button (that would offer sign-in to a signed-in user). */
              <div className="flex items-center gap-2.5 py-1 lg:px-2">
                <div className="size-8 animate-pulse rounded-full bg-muted" />
                <div className="hidden h-4 w-24 animate-pulse rounded-md bg-muted sm:block" />
              </div>
            ) : isSignedIn && user ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button
                      aria-label="Account menu"
                      className="group flex w-full items-center gap-2.5 rounded-lg py-1.5 pl-1.5 pr-2 text-left text-sm transition-colors duration-150 hover:bg-secondary lg:px-2"
                    >
                      <Avatar className="size-8 ring-1 ring-inset ring-border">
                        <AvatarImage src={user.imageUrl ?? undefined} referrerPolicy="no-referrer" />
                        <AvatarFallback className="text-xs">{(user.name?.[0] ?? user.email?.[0] ?? '?').toUpperCase()}</AvatarFallback>
                      </Avatar>
                      <span className="hidden min-w-0 flex-1 sm:block">
                        <span data-testid="nav-user-name" className="block max-w-[150px] truncate font-medium text-foreground">
                          {user.name || user.email}
                        </span>
                        <span className="hidden text-xs text-muted-foreground lg:block">Account</span>
                      </span>
                      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[popup-open]:rotate-180" aria-hidden />
                    </button>
                  }
                />
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>
                    <div className="truncate font-medium text-foreground">{user.name || 'Signed in'}</div>
                    <div data-testid="nav-user-email" className="truncate text-xs font-normal text-muted-foreground">
                      {user.email}
                    </div>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => signOut()}>
                    <LogOut aria-hidden />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <button
                data-testid="nav-sign-in-button"
                onClick={() => setShowAuthModal(true)}
                className="h-9 w-full rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity duration-150 hover:opacity-90"
              >
                Sign in
              </button>
            )}
          </div>

          <button
            className="inline-flex size-10 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground lg:hidden"
            onClick={() => setMobileMenuOpen((prev) => !prev)}
            aria-label="Toggle menu"
            aria-expanded={mobileMenuOpen}
            aria-controls="mobile-menu"
          >
            {mobileMenuOpen ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}
          </button>
        </div>

        {mobileMenuOpen && (
          <div id="mobile-menu" className="absolute inset-x-0 top-full flex flex-col gap-1 border-b border-border bg-card p-2 shadow-[0_12px_24px_rgba(0,0,0,0.5)] lg:hidden">
            {visibleNav.map(navLink)}
          </div>
        )}
      </nav>

      {showAuthModal && <AuthOverlay onClose={() => setShowAuthModal(false)} />}
    </>
  )
}

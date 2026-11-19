import { Link } from 'react-router-dom'
import { Brand } from '../components/Brand'
import { BRAND } from '../constants'

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-5 text-center">
      <title>{`Not found · ${BRAND}`}</title>
      <meta name="robots" content="noindex" />
      <Brand />
      <h1 className="mt-10 font-display text-7xl font-extrabold tracking-tight text-foreground tabular">404</h1>
      <p className="mt-3 text-muted-foreground">Nothing is recorded at this address.</p>
      <Link to="/home" className="mt-8 inline-flex h-11 items-center rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground transition-colors duration-150 hover:bg-primary/90">
        Go home
      </Link>
    </div>
  )
}

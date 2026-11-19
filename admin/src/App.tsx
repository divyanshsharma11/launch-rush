import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiError, createApi } from './api'
import { Controls } from './Controls'
import { Deliveries } from './Deliveries'
import { HealthPanel } from './HealthPanel'
import { Login } from './Login'
import { ScoreboardPanel } from './ScoreboardPanel'
import type { FailedDelivery, Health, Scoreboard } from './types'

export type Loaded<T> = { data: T | null; error: string | null }
export type Run = (action: () => Promise<string | void>) => Promise<void>

const none = { data: null, error: null }
const messageOf = (err: unknown) => (err instanceof Error ? err.message : 'Request failed')
const isSignedOut = (err: unknown) => err instanceof ApiError && err.status === 401

function loaded<T>(result: PromiseSettledResult<T>): Loaded<T> {
  return result.status === 'fulfilled'
    ? { data: result.value, error: null }
    : { data: null, error: messageOf(result.reason) }
}

export function App() {
  const api = useMemo(() => createApi(), [])
  const [session, setSession] = useState<'checking' | 'out' | 'in'>('checking')
  const [board, setBoard] = useState<Loaded<Scoreboard | null>>(none)
  const [health, setHealth] = useState<Loaded<Health>>(none)
  const [deliveries, setDeliveries] = useState<Loaded<FailedDelivery[]>>(none)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const latest = useRef(0)
  const working = useRef(false)

  // Returns whether the owner is signed in. Only the newest call applies its result, so a slow older one cannot overwrite it.
  const refresh = useCallback(async () => {
    const call = ++latest.current
    const results = await Promise.allSettled([api.scoreboard(), api.health(), api.failedDeliveries()])
    const signedIn = !results.some((r) => r.status === 'rejected' && isSignedOut(r.reason))
    if (call !== latest.current) return signedIn
    if (signedIn) {
      setBoard(loaded(results[0]))
      setHealth(loaded(results[1]))
      setDeliveries(loaded(results[2]))
    }
    setSession(signedIn ? 'in' : 'out')
    return signedIn
  }, [api])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Every button goes through here: run the call, show its result, then read everything again. One at a time, because
  // two quick clicks on Refill would each record a receipt for the same missing copies.
  const run: Run = async (action) => {
    if (working.current) return
    working.current = true
    setBusy(true)
    try {
      setNotice((await action()) ?? null)
      await refresh()
    } catch (err) {
      if (isSignedOut(err)) setSession('out')
      else setNotice(messageOf(err))
    } finally {
      working.current = false
      setBusy(false)
    }
  }

  const logout = async () => {
    await api.logout().catch(() => undefined)
    setSession('out')
  }

  if (session === 'checking') return <p className="page">Loading…</p>
  if (session === 'out') return <Login api={api} onLoggedIn={refresh} />

  return (
    <main className="page">
      <fieldset className="plain" disabled={busy}>
        <header className="bar">
          <h1>launch-rush admin</h1>
          <div className="actions">
            <button onClick={() => void run(async () => undefined)}>Refresh</button>
            <button onClick={() => void logout()}>Log out</button>
          </div>
        </header>
        <p className="note">Demo store: payments are simulated, nothing is charged.</p>
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        <ScoreboardPanel board={board} />
        <HealthPanel health={health} />
        <Deliveries api={api} deliveries={deliveries} run={run} />
        <Controls api={api} health={health.data} run={run} />
      </fieldset>
    </main>
  )
}

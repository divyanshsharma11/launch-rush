import { useState, type FormEvent } from 'react'
import { ApiError, type Api } from './api'

export function Login({ api, onLoggedIn }: { api: Api; onLoggedIn: () => Promise<boolean> }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await api.login(password)
      setPassword('')
      if (!(await onLoggedIn())) setError('Logged in, but the browser did not keep the session cookie.')
    } catch (err) {
      if (err instanceof ApiError && err.code === 'bad_credentials') setError('Wrong password.')
      else setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="page narrow">
      <h1>launch-rush admin</h1>
      <form onSubmit={(event) => void submit(event)} className="card">
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          Log in
        </button>
      </form>
    </main>
  )
}

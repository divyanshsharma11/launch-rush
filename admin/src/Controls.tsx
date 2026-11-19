import { useEffect, useState } from 'react'
import type { Api } from './api'
import type { Run } from './App'
import { formFromFaults, parseFaultsForm, type FaultsForm } from './logic'
import type { Faults, Health } from './types'

export function Controls({ api, health, run }: { api: Api; health: Health | null; run: Run }) {
  return (
    <section className="card">
      <h2>Controls</h2>
      <StockReset api={api} run={run} />
      <RushSwitch api={api} enabled={health?.rushEnabled ?? null} run={run} />
      <ErpFaults api={api} current={health?.erpFaults ?? null} run={run} />
    </section>
  )
}

function StockReset({ api, run }: { api: Api; run: Run }) {
  const [gameId, setGameId] = useState('')
  const refill = async () => {
    const refilled = await api.resetStock(gameId.trim())
    if (refilled.length === 0) return 'Every game is already at its starting stock.'
    return `Refilled ${refilled.map((r) => `${r.gameId} +${r.qty}`).join(', ')}`
  }
  return (
    <div className="control">
      <h3>Reset demo stock</h3>
      <p className="note">Refills shop stock up to the starting level. Cancels no orders; demo runs are not affected.</p>
      <label htmlFor="game-id">Game id (empty = every game)</label>
      <input id="game-id" value={gameId} onChange={(event) => setGameId(event.target.value)} />
      <button onClick={() => void run(refill)}>Refill</button>
    </div>
  )
}

function RushSwitch({ api, enabled, run }: { api: Api; enabled: boolean | null; run: Run }) {
  const next = enabled === false
  const toggle = async () => {
    await api.setRush(next)
    return next ? 'Rush runs switched on' : 'Rush runs switched off'
  }
  return (
    <div className="control">
      <h3>Rush kill switch</h3>
      <p>
        Rush runs are <strong>{enabled === null ? 'unknown' : enabled ? 'on' : 'off'}</strong>.
      </p>
      <p className="note">Off stops every running demo run and blocks new ones.</p>
      <button disabled={enabled === null} onClick={() => void run(toggle)}>
        {next ? 'Switch rush on' : 'Switch rush off'}
      </button>
    </div>
  )
}

const NO_FAULTS: Faults = { latencyMs: 0, down: false, rateLimitPerSec: 0, failureRate: 0 }

function ErpFaults({ api, current, run }: { api: Api; current: Faults | null; run: Run }) {
  const [form, setForm] = useState<FaultsForm>({ latencyMs: '', rateLimitPerSec: '', failureRate: '', down: false })
  const [error, setError] = useState<string | null>(null)
  // Keyed by value: a refresh that changes nothing must not wipe what is being typed.
  const saved = JSON.stringify(current)
  useEffect(() => {
    if (current) setForm(formFromFaults(current))
  }, [saved])

  const field = (name: 'latencyMs' | 'rateLimitPerSec' | 'failureRate', label: string) => (
    <>
      <label htmlFor={name}>{label}</label>
      <input id={name} value={form[name]} onChange={(event) => setForm({ ...form, [name]: event.target.value })} />
    </>
  )

  const save = (faults: Faults, message: string) => run(async () => (await api.setErpFaults(faults), message))
  const apply = () => {
    const parsed = parseFaultsForm(form)
    setError(parsed.ok ? null : parsed.message)
    if (parsed.ok) void save(parsed.faults, 'ERP faults saved')
  }

  return (
    <div className="control">
      <h3>ERP faults (shop orders)</h3>
      <p className="note">Break the ERP simulator for shop orders. Demo runs have their own faults on the demo page.</p>
      {field('latencyMs', 'Latency (ms, 0 to 10000)')}
      {field('rateLimitPerSec', 'Rate limit (calls per second, 0 = off)')}
      {field('failureRate', 'Failure rate (0 to 1)')}
      <label className="check">
        <input type="checkbox" checked={form.down} onChange={(event) => setForm({ ...form, down: event.target.checked })} />
        Down (every call answers 503)
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="actions">
        <button onClick={apply}>Apply</button>
        <button onClick={() => void save(NO_FAULTS, 'ERP faults cleared')}>Clear all</button>
      </div>
    </div>
  )
}

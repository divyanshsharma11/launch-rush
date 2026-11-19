import type { Loaded } from './App'
import { scoreboardRows } from './logic'
import type { Scoreboard } from './types'

export function ScoreboardPanel({ board }: { board: Loaded<Scoreboard | null> }) {
  return (
    <section className="card">
      <h2>Sales and proof scoreboard</h2>
      <p className="note">Shop orders, all time. Computed from PostgreSQL by the reconciler, not from the animation.</p>
      {board.error && <p className="error">{board.error}</p>}
      {board.data === null && !board.error && <p>No result yet: the worker's reconciler has not run.</p>}
      {board.data && <Rows board={board.data} />}
    </section>
  )
}

function Rows({ board }: { board: Scoreboard }) {
  const { counts, checks } = scoreboardRows(board)
  return (
    <>
      <dl className="stats">
        {counts.map((row) => (
          <div key={row.label}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>
      <h3>Must all be zero</h3>
      <dl className="stats">
        {checks.map((row) => (
          <div key={row.label} className={row.ok ? 'ok' : 'bad'}>
            <dt>{row.label}</dt>
            <dd>
              {row.value} {row.ok ? '✓' : '✗'}
            </dd>
          </div>
        ))}
      </dl>
      <p className="note">Checked {new Date(board.checkedAt).toLocaleString()}</p>
    </>
  )
}

import type { Loaded } from './App'
import type { Health } from './types'

export function HealthPanel({ health }: { health: Loaded<Health> }) {
  const data = health.data
  return (
    <section className="card">
      <h2>Health</h2>
      {health.error && <p className="error">{health.error}</p>}
      {data && (
        <>
          <table>
            <thead>
              <tr>
                <th>Connector</th>
                <th>Health check</th>
                <th>Circuit breaker</th>
              </tr>
            </thead>
            <tbody>
              {data.connectors.map((connector) => (
                <tr key={connector.id}>
                  <td>{connector.id}</td>
                  <td className={connector.healthy ? 'ok' : 'bad'}>{connector.healthy ? 'healthy' : 'not healthy'}</td>
                  <td className={connector.breaker === 'closed' ? 'ok' : 'bad'}>{connector.breaker}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="note">email-gmail is not healthy until Gmail is connected (npm run gmail-connect).</p>
          <table>
            <thead>
              <tr>
                <th>Queue</th>
                <th>Waiting</th>
                <th>Active</th>
                <th>Delayed</th>
                <th>Failed</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.queues).map(([name, counts]) => (
                <tr key={name}>
                  <td>{name}</td>
                  <td>{counts.waiting}</td>
                  <td>{counts.active}</td>
                  <td>{counts.delayed}</td>
                  <td className={counts.failed === 0 ? 'ok' : 'bad'}>{counts.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}

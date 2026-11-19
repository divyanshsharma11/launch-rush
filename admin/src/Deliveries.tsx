import type { Api } from './api'
import type { Loaded, Run } from './App'
import type { FailedDelivery } from './types'

export function Deliveries({ api, deliveries, run }: { api: Api; deliveries: Loaded<FailedDelivery[]>; run: Run }) {
  const list = deliveries.data
  const replay = (id: string) => run(async () => (await api.replay(id), 'Replay queued'))
  return (
    <section className="card">
      <h2>Failed deliveries</h2>
      <p className="note">A step that failed for good after its retries. Replay puts it back on its queue with fresh attempts.</p>
      {deliveries.error && <p className="error">{deliveries.error}</p>}
      {list?.length === 0 && <p>None.</p>}
      {list && list.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Connector</th>
              <th>Action</th>
              <th>Attempts</th>
              <th>Last error</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((delivery) => (
              <tr key={delivery.id}>
                <td title={delivery.orderId}>{delivery.orderId.slice(0, 8)}</td>
                <td>{delivery.connector}</td>
                <td>{delivery.action}</td>
                <td>{delivery.attempts}</td>
                <td>{delivery.lastError}</td>
                <td>
                  <button onClick={() => void replay(delivery.id)}>Replay</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

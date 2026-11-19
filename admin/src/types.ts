// The shapes the /admin API replies with (launch-rush design §5.4).
export type Faults = { latencyMs: number; down: boolean; rateLimitPerSec: number; failureRate: number }

export type Scoreboard = {
  sold: number
  stock: number
  oversold: number
  lost: number
  paidNotInvoicedOrRefunded: number
  completedWithoutInvoice: number
  duplicatesBlocked: number
  stockMismatches: string[]
  leakedHolds?: string[] // missing in a result stored by an older worker
  checkedAt: string
}

export type ConnectorHealth = { id: string; healthy: boolean; breaker: 'closed' | 'open' | 'halfOpen' }
export type QueueCounts = { waiting: number; active: number; delayed: number; failed: number }
export type Health = {
  connectors: ConnectorHealth[]
  queues: Record<string, QueueCounts>
  rushEnabled: boolean
  erpFaults: Faults
}

export type FailedDelivery = {
  id: string
  orderId: string
  connector: string
  action: string
  attempts: number
  lastError: string | null
}

export type Refilled = { gameId: string; qty: number }

import type { Faults, Scoreboard } from './types'

export type FaultsForm = { latencyMs: string; rateLimitPerSec: string; failureRate: string; down: boolean }

const whole = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max

// Same limits as the API (launch-rush src/business/runs.js); an empty field means off (0).
export function parseFaultsForm(form: FaultsForm): { ok: true; faults: Faults } | { ok: false; message: string } {
  const latencyMs = Number(form.latencyMs.trim() || 0)
  const rateLimitPerSec = Number(form.rateLimitPerSec.trim() || 0)
  const failureRate = Number(form.failureRate.trim() || 0)
  if (!whole(latencyMs, 0, 10_000)) return { ok: false, message: 'Latency must be a whole number from 0 to 10000 ms' }
  if (!whole(rateLimitPerSec, 0, 1000)) return { ok: false, message: 'Rate limit must be a whole number from 0 to 1000 per second' }
  if (!(failureRate >= 0 && failureRate <= 1)) return { ok: false, message: 'Failure rate must be from 0 to 1' }
  return { ok: true, faults: { latencyMs, down: form.down, rateLimitPerSec, failureRate } }
}

export const formFromFaults = (faults: Faults): FaultsForm => ({
  latencyMs: String(faults.latencyMs),
  rateLimitPerSec: String(faults.rateLimitPerSec),
  failureRate: String(faults.failureRate),
  down: faults.down,
})

// The proof scoreboard: the first group are counts, the second are checks that must all be zero (design §5.1, §8.3).
export function scoreboardRows(board: Scoreboard) {
  return {
    counts: [
      { label: 'Copies sold', value: board.sold },
      { label: 'Stock (start + restocks)', value: board.stock },
      { label: 'Duplicates blocked', value: board.duplicatesBlocked },
    ],
    checks: [
      { label: 'Oversold', value: board.oversold },
      { label: 'Lost', value: board.lost },
      { label: 'Paid, not invoiced or refunded', value: board.paidNotInvoicedOrRefunded },
      { label: 'Completed without invoice', value: board.completedWithoutInvoice },
      { label: 'Stock mismatches', value: board.stockMismatches.length },
      { label: 'Leaked holds', value: (board.leakedHolds ?? []).length },
    ].map((row) => ({ ...row, ok: row.value === 0 })),
  }
}

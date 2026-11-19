import { describe, expect, it } from 'vitest'
import { formFromFaults, parseFaultsForm, scoreboardRows } from './logic'
import type { Scoreboard } from './types'

const form = { latencyMs: '', rateLimitPerSec: '', failureRate: '', down: false }

describe('parseFaultsForm', () => {
  it('empty fields mean off', () => {
    expect(parseFaultsForm(form)).toEqual({
      ok: true,
      faults: { latencyMs: 0, down: false, rateLimitPerSec: 0, failureRate: 0 },
    })
  })

  it('accepts the limits of each field', () => {
    const result = parseFaultsForm({ latencyMs: '10000', rateLimitPerSec: '1000', failureRate: '1', down: true })
    expect(result).toEqual({
      ok: true,
      faults: { latencyMs: 10_000, down: true, rateLimitPerSec: 1000, failureRate: 1 },
    })
  })

  it('rejects values outside the API limits', () => {
    for (const bad of [
      { latencyMs: '10001' },
      { latencyMs: '-1' },
      { latencyMs: '1.5' },
      { latencyMs: 'abc' },
      { rateLimitPerSec: '1001' },
      { failureRate: '1.1' },
      { failureRate: '-0.1' },
    ]) {
      expect(parseFaultsForm({ ...form, ...bad }).ok).toBe(false)
    }
  })

  it('formFromFaults round-trips through parseFaultsForm', () => {
    const faults = { latencyMs: 250, down: true, rateLimitPerSec: 5, failureRate: 0.25 }
    expect(parseFaultsForm(formFromFaults(faults))).toEqual({ ok: true, faults })
  })
})

describe('scoreboardRows', () => {
  const board: Scoreboard = {
    sold: 10,
    stock: 20,
    oversold: 0,
    lost: 1,
    paidNotInvoicedOrRefunded: 0,
    completedWithoutInvoice: 0,
    duplicatesBlocked: 4,
    stockMismatches: ['g1'],
    leakedHolds: [],
    checkedAt: '2026-11-16T00:00:00.000Z',
  }

  it('a result stored without leakedHolds counts as none', () => {
    const { leakedHolds, ...older } = board
    expect(leakedHolds).toEqual([])
    const holds = scoreboardRows(older).checks.find((c) => c.label === 'Leaked holds')
    expect(holds).toMatchObject({ value: 0, ok: true })
  })

  it('lists counts and marks each check ok only at zero', () => {
    const { counts, checks } = scoreboardRows(board)
    expect(counts.map((c) => c.value)).toEqual([10, 20, 4])
    const byLabel = Object.fromEntries(checks.map((c) => [c.label, c.ok]))
    expect(byLabel['Lost']).toBe(false)
    expect(byLabel['Stock mismatches']).toBe(false)
    expect(byLabel['Oversold']).toBe(true)
    expect(byLabel['Leaked holds']).toBe(true)
  })
})

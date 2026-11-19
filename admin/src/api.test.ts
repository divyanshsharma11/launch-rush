import { describe, expect, it } from 'vitest'
import { ApiError, createApi } from './api'

type Call = { url: string; init: RequestInit }

function fakeFetch(status: number, body: string) {
  const calls: Call[] = []
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(status === 204 ? null : body, { status })
  }) as unknown as typeof fetch
  return { calls, api: createApi(fetchFn) }
}

describe('api', () => {
  it('login posts the password as JSON to /admin/login', async () => {
    const { api, calls } = fakeFetch(204, '')
    await api.login('secret')
    expect(calls[0].url).toBe('/admin/login')
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.body).toBe('{"password":"secret"}')
    expect(calls[0].init.headers).toEqual({ 'Content-Type': 'application/json' })
  })

  it('a GET sends no body and no content type', async () => {
    const { api, calls } = fakeFetch(200, '{"deliveries":[]}')
    expect(await api.failedDeliveries()).toEqual([])
    expect(calls[0].url).toBe('/admin/deliveries?status=failed')
    expect(calls[0].init.method).toBe('GET')
    expect(calls[0].init.body).toBeUndefined()
  })

  it('scoreboard unwraps the field and keeps null', async () => {
    const { api } = fakeFetch(200, '{"scoreboard":null}')
    expect(await api.scoreboard()).toBeNull()
  })

  it('stock reset sends the game id only when one is given', async () => {
    const empty = fakeFetch(202, '{"refilled":[]}')
    await empty.api.resetStock('')
    expect(empty.calls[0].init.body).toBe('{}')
    const one = fakeFetch(202, '{"refilled":[{"gameId":"g1","qty":3}]}')
    expect(await one.api.resetStock('g1')).toEqual([{ gameId: 'g1', qty: 3 }])
    expect(one.calls[0].init.body).toBe('{"gameId":"g1"}')
  })

  it('replay, rush and faults use their routes and methods', async () => {
    const { api, calls } = fakeFetch(204, '')
    await api.replay('7')
    await api.setRush(false)
    await api.setErpFaults({ latencyMs: 1, down: true, rateLimitPerSec: 2, failureRate: 0.5 })
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ['POST', '/admin/deliveries/7/replay'],
      ['PUT', '/admin/rush'],
      ['PUT', '/admin/erp-sim/faults'],
    ])
    expect(calls[1].init.body).toBe('{"enabled":false}')
  })

  it('an error reply becomes an ApiError with the API code and message', async () => {
    const { api } = fakeFetch(401, '{"error":{"code":"bad_credentials","message":"Wrong password"}}')
    const err = await api.login('x').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 401, code: 'bad_credentials', message: 'Wrong password' })
  })

  it('a non-JSON error body keeps only the status', async () => {
    const { api } = fakeFetch(502, '<html>Bad gateway</html>')
    await expect(api.health()).rejects.toMatchObject({ status: 502, code: 'error', message: 'HTTP 502' })
  })
})

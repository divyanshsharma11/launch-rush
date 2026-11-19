import type { FailedDelivery, Faults, Health, Refilled, Scoreboard } from './types'

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

// The API's error body is { error: { code, message } }; anything else (a proxy's HTML page) keeps only the status.
function errorFrom(status: number, text: string): ApiError {
  try {
    const { error } = JSON.parse(text) as { error: { code: string; message: string } }
    return new ApiError(status, error.code, error.message)
  } catch {
    return new ApiError(status, 'error', `HTTP ${status}`)
  }
}

// The browser sends the session cookie and the Origin header by itself on same-origin calls.
export function createApi(fetchFn: typeof fetch = (input, init) => fetch(input, init)) {
  async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const res = await fetchFn(`/admin${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw errorFrom(res.status, text)
    return (text ? JSON.parse(text) : undefined) as T
  }

  return {
    login: (password: string) => call<void>('/login', 'POST', { password }),
    logout: () => call<void>('/logout', 'POST'),
    health: () => call<Health>('/health'),
    scoreboard: async () => (await call<{ scoreboard: Scoreboard | null }>('/scoreboard')).scoreboard,
    failedDeliveries: async () => (await call<{ deliveries: FailedDelivery[] }>('/deliveries?status=failed')).deliveries,
    replay: (deliveryId: string) => call<void>(`/deliveries/${deliveryId}/replay`, 'POST'),
    resetStock: async (gameId: string) =>
      (await call<{ refilled: Refilled[] }>('/stock/reset', 'POST', gameId ? { gameId } : {})).refilled,
    setRush: (enabled: boolean) => call<void>('/rush', 'PUT', { enabled }),
    setErpFaults: (faults: Faults) => call<void>('/erp-sim/faults', 'PUT', faults),
  }
}

export type Api = ReturnType<typeof createApi>

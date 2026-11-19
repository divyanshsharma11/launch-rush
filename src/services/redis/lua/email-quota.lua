-- Real-email cap (design §5.1). Keys: the session's set and the UTC day's set of order ids that were given a real
-- email. Args: order id, cap per session, cap per day, seconds to keep a day set.
-- Returns 'gmail' (this order may use Gmail) or 'mock'. An order counted before is always 'gmail' again.
local order = ARGV[1]
if redis.call('SISMEMBER', KEYS[1], order) == 1 or redis.call('SISMEMBER', KEYS[2], order) == 1 then
  return 'gmail'
end
if redis.call('SCARD', KEYS[1]) < tonumber(ARGV[2]) and redis.call('SCARD', KEYS[2]) < tonumber(ARGV[3]) then
  redis.call('SADD', KEYS[1], order)
  redis.call('SADD', KEYS[2], order)
  redis.call('EXPIRE', KEYS[2], ARGV[4], 'NX')
  return 'gmail'
end
return 'mock'

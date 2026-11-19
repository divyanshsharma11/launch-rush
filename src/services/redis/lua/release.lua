-- KEYS: stock, holds, waitlist, grants, buyers. ARGV: orderId, buyerRef ('' in the shop).
local orderId, buyerRef = ARGV[1], ARGV[2]

if buyerRef ~= '' and redis.call('HGET', KEYS[5], buyerRef) == orderId then
  redis.call('HDEL', KEYS[5], buyerRef)
end

if redis.call('HDEL', KEYS[2], orderId) == 0 then
  redis.call('ZREM', KEYS[3], orderId)
  return {'none'}
end

local waiter = redis.call('ZPOPMIN', KEYS[3])
if #waiter > 0 then
  redis.call('HSET', KEYS[2], waiter[1], redis.call('INCR', KEYS[4]))
  return {'handed', waiter[1]}
end

redis.call('INCR', KEYS[1])
return {'returned'}

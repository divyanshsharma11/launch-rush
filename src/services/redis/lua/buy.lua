-- KEYS: stock, holds, waitlist, tickets, grants, buyers. ARGV: orderId, buyerRef ('' in the shop), joinWaitlist ('1'/'0').
local orderId, buyerRef = ARGV[1], ARGV[2]

if buyerRef ~= '' then
  local owner = redis.call('HGET', KEYS[6], buyerRef)
  if owner and owner ~= orderId then return {'already', owner} end
end

local held = redis.call('HGET', KEYS[2], orderId)
if held then return {'reserved', tonumber(held)} end

local function claimBuyer()
  if buyerRef ~= '' then redis.call('HSET', KEYS[6], buyerRef, orderId) end
end

if tonumber(redis.call('GET', KEYS[1]) or '0') > 0 and redis.call('ZCARD', KEYS[3]) == 0 then
  redis.call('DECR', KEYS[1])
  local buyerNumber = redis.call('INCR', KEYS[5])
  redis.call('HSET', KEYS[2], orderId, buyerNumber)
  claimBuyer()
  return {'reserved', buyerNumber}
end

if ARGV[3] ~= '1' then return {'none'} end

if not redis.call('ZSCORE', KEYS[3], orderId) then
  redis.call('ZADD', KEYS[3], redis.call('INCR', KEYS[4]), orderId)
end
claimBuyer()
return {'waitlisted', redis.call('ZRANK', KEYS[3], orderId) + 1}

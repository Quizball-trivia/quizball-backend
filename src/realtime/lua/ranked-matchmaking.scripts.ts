export const RANKED_MM_PAIR_TWO_RANDOM_SCRIPT = `
local queueKey = KEYS[1]
local timeoutKey = KEYS[2]
local userMapKey = KEYS[3]
local searchPrefix = ARGV[1]
local matchedAt = ARGV[2]

local picks = redis.call('ZRANDMEMBER', queueKey, 2)
if (not picks) or (#picks < 2) then
  return {}
end

local searchIdA = picks[1]
local searchIdB = picks[2]
if searchIdA == searchIdB then
  return {}
end

local searchKeyA = searchPrefix .. searchIdA
local searchKeyB = searchPrefix .. searchIdB

local statusA = redis.call('HGET', searchKeyA, 'status')
local statusB = redis.call('HGET', searchKeyB, 'status')
if statusA ~= 'queued' or statusB ~= 'queued' then
  return {}
end

local userIdA = redis.call('HGET', searchKeyA, 'userId')
local userIdB = redis.call('HGET', searchKeyB, 'userId')
if (not userIdA) or (not userIdB) then
  return {}
end

redis.call('HSET', searchKeyA, 'status', 'matched', 'matchedAt', matchedAt)
redis.call('HSET', searchKeyB, 'status', 'matched', 'matchedAt', matchedAt)
redis.call('ZREM', queueKey, searchIdA, searchIdB)
redis.call('ZREM', timeoutKey, searchIdA, searchIdB)
redis.call('HDEL', userMapKey, userIdA, userIdB)

return { searchIdA, userIdA, searchIdB, userIdB }
`;

export const RANKED_MM_CLAIM_FALLBACK_SCRIPT = `
local queueKey = KEYS[1]
local timeoutKey = KEYS[2]
local userMapKey = KEYS[3]
local searchKey = KEYS[4]
local searchId = ARGV[1]
local nowMs = tonumber(ARGV[2])
local fallbackAt = ARGV[3]

local status = redis.call('HGET', searchKey, 'status')
if status ~= 'queued' then
  return {}
end

local deadlineAt = tonumber(redis.call('HGET', searchKey, 'deadlineAt'))
if (not deadlineAt) or deadlineAt > nowMs then
  return {}
end

local userId = redis.call('HGET', searchKey, 'userId')
if not userId then
  return {}
end

redis.call('HSET', searchKey, 'status', 'fallback', 'fallbackAt', fallbackAt)
redis.call('ZREM', queueKey, searchId)
redis.call('ZREM', timeoutKey, searchId)
redis.call('HDEL', userMapKey, userId)

return { userId }
`;

export const RANKED_MM_CANCEL_SEARCH_SCRIPT = `
local queueKey = KEYS[1]
local timeoutKey = KEYS[2]
local userMapKey = KEYS[3]
local searchPrefix = ARGV[1]
local userId = ARGV[2]
local cancelledAt = ARGV[3]

local searchId = redis.call('HGET', userMapKey, userId)
if not searchId then
  return {}
end

local searchKey = searchPrefix .. searchId
local status = redis.call('HGET', searchKey, 'status')
if status ~= 'queued' then
  return {}
end

redis.call('HSET', searchKey, 'status', 'cancelled', 'cancelledAt', cancelledAt)
redis.call('ZREM', queueKey, searchId)
redis.call('ZREM', timeoutKey, searchId)
redis.call('HDEL', userMapKey, userId)

return { searchId }
`;

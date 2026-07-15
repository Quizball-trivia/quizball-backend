export const RANKED_MM_STALE_RESULT = '__ranked_mm_stale__';

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
if statusA ~= 'queued' then
  redis.call('ZREM', queueKey, searchIdA)
  redis.call('ZREM', timeoutKey, searchIdA)
  return {'${RANKED_MM_STALE_RESULT}'}
end
if statusB ~= 'queued' then
  redis.call('ZREM', queueKey, searchIdB)
  redis.call('ZREM', timeoutKey, searchIdB)
  return {'${RANKED_MM_STALE_RESULT}'}
end

local userIdA = redis.call('HGET', searchKeyA, 'userId')
local userIdB = redis.call('HGET', searchKeyB, 'userId')
if (not userIdA) or (not userIdB) then
  redis.call('ZREM', queueKey, searchIdA, searchIdB)
  redis.call('ZREM', timeoutKey, searchIdA, searchIdB)
  return {'${RANKED_MM_STALE_RESULT}'}
end
local mappedSearchIdA = redis.call('HGET', userMapKey, userIdA)
local mappedSearchIdB = redis.call('HGET', userMapKey, userIdB)
if mappedSearchIdA ~= searchIdA then
  redis.call('HSET', searchKeyA, 'status', 'stale', 'staleAt', matchedAt)
  redis.call('ZREM', queueKey, searchIdA)
  redis.call('ZREM', timeoutKey, searchIdA)
  return {'${RANKED_MM_STALE_RESULT}'}
end
if mappedSearchIdB ~= searchIdB then
  redis.call('HSET', searchKeyB, 'status', 'stale', 'staleAt', matchedAt)
  redis.call('ZREM', queueKey, searchIdB)
  redis.call('ZREM', timeoutKey, searchIdB)
  return {'${RANKED_MM_STALE_RESULT}'}
end
local countryCodeA = redis.call('HGET', searchKeyA, 'countryCode') or ''
local countryCodeB = redis.call('HGET', searchKeyB, 'countryCode') or ''

redis.call('HSET', searchKeyA, 'status', 'matched', 'matchedAt', matchedAt)
redis.call('HSET', searchKeyB, 'status', 'matched', 'matchedAt', matchedAt)
redis.call('ZREM', queueKey, searchIdA, searchIdB)
redis.call('ZREM', timeoutKey, searchIdA, searchIdB)
redis.call('HDEL', userMapKey, userIdA, userIdB)

return { searchIdA, userIdA, countryCodeA, searchIdB, userIdB, countryCodeB }
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
  -- Hashes have a TTL but sorted-set members do not. A replica crash can leave
  -- this orphan behind after the hash expires; remove it here so the first 50
  -- dead timeout entries cannot permanently starve every real fallback.
  redis.call('ZREM', queueKey, searchId)
  redis.call('ZREM', timeoutKey, searchId)
  return {}
end

local deadlineAt = tonumber(redis.call('HGET', searchKey, 'deadlineAt'))
if (not deadlineAt) or deadlineAt > nowMs then
  return {}
end

local userId = redis.call('HGET', searchKey, 'userId')
if not userId then
  redis.call('ZREM', queueKey, searchId)
  redis.call('ZREM', timeoutKey, searchId)
  return {}
end
local mappedSearchId = redis.call('HGET', userMapKey, userId)
if mappedSearchId ~= searchId then
  redis.call('HSET', searchKey, 'status', 'stale', 'staleAt', fallbackAt)
  redis.call('ZREM', queueKey, searchId)
  redis.call('ZREM', timeoutKey, searchId)
  return {}
end
local countryCode = redis.call('HGET', searchKey, 'countryCode') or ''

redis.call('HSET', searchKey, 'status', 'fallback', 'fallbackAt', fallbackAt)
redis.call('ZREM', queueKey, searchId)
redis.call('ZREM', timeoutKey, searchId)
redis.call('HDEL', userMapKey, userId)

return { userId, countryCode }
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

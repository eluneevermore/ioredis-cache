import Redis, { RedisKey, RedisOptions } from 'ioredis'

interface Parser {
  parse: (text: string) => any
  stringify: (value: any) => string
}

interface CacheOptions {
  redis: RedisOptions | Redis
  parser?: Parser
}

type Key = RedisKey

type Map<T> = { [id: string]: T }

type Awaitable<T> = T | Promise<T>

const NOT_FOUND_VALUE = undefined

const isRedis = (obj): boolean => {
  if (obj == null) { return false }
  return ['set', 'get', 'setex', 'mget', 'pipeline', 'del', 'hset', 'get', 'hdel'].every(name => typeof obj[name] === 'function')
}

class Cache {
  redis: Redis;
  protected prefix: string;
  protected parser: Parser = JSON;

  constructor(options: Redis | CacheOptions) {
    let config = (isRedis(options) ? { redis: options } : options) as CacheOptions

    if (isRedis(config.redis)) {
      this.redis = config.redis as Redis
    } else {
      this.redis = new Redis(config.redis as RedisOptions)
    }

    this.prefix = this.redis.options.keyPrefix || ''
    if (config.parser !== undefined) {
      this.parser = config.parser
    }
  }

  static bindAll(target: Cache): Cache {
    for (const name of Object.getOwnPropertyNames(Cache.prototype)) {
      if (name === 'constructor') { continue }
      target[name] = target[name].bind(target)
    }
    return target
  }

  async cache<T>(key: Key, fn: () => Awaitable<T>, ttl?: number): Promise<T> {
    let value = await this.getCache(key)
    if (value !== NOT_FOUND_VALUE) {
      return value
    }
    value = await fn()
    await this.setCache(key, value, ttl)
    return value
  }

  async getCache(key: Key) {
    const data = await this.redis.get(key)
    return data ? this.parser.parse(data) : NOT_FOUND_VALUE
  }

  async setCache(key: Key, value: any, ttl?: number) {
    const data = this.parser.stringify(value)
    return (ttl !== undefined ? this.redis.setex(key, ttl, data) : this.redis.set(key, data))
  }

  async manyCache<K extends Key, T>(keys: K[], fn: (keys: K[]) => Awaitable<Map<T> | T[]>, prefix: Key = '', ttl?: number): Promise<T[]> {
    const fullKeys = keys.map(key => `${prefix}${key}`)
    const cachedValues = await this.getManyCache(fullKeys)
    const uncachedKeys: K[] = []
    for (let i = 0; i < cachedValues.length; ++i) {
      if (cachedValues[i] === NOT_FOUND_VALUE) { uncachedKeys.push(keys[i]) }
    }

    if (uncachedKeys.length) {
      const uncachedValues = await fn(uncachedKeys)
      const uncachedValueMap = Array.isArray(uncachedValues)
        ? uncachedKeys.reduce((c, key, idx) => Object.assign(c, { [key.toString()]: uncachedValues[idx] }), {})
        : uncachedValues
      const fullKeyUncachedValueMap = Object.entries(uncachedValueMap).reduce((c, [key, value]) =>
        Object.assign(c, { [`${prefix}${key}`]: value }), {})
      await this.setManyCache(fullKeyUncachedValueMap, ttl)

      for (let i = 0; i < cachedValues.length; ++i) {
        if (cachedValues[i] === NOT_FOUND_VALUE) {
          cachedValues[i] = uncachedValueMap[keys[i].toString()]
        }
      }
    }
    return cachedValues
  }

  async getManyCache(keys: Key[]): Promise<any[]> {
    if (keys.length <= 0) { return [] }
    let data = await this.redis.mget(keys)
    data = data.map((e: string | null) => !e ? NOT_FOUND_VALUE : this.parser.parse(e))
    return data
  }

  async setManyCache(valueMap: { [id: string]: any }, ttl?: number) {
    const keys = Object.keys(valueMap)
    if (keys.length <= 0) { return [] }
    const params = this._buildSetParams(valueMap)
    if (ttl === undefined) { return this.redis.mset(params) }
    const pipeline = this.redis.pipeline()
    pipeline.mset(params)
    for (const key of keys) { pipeline.expire(key, ttl) }
    return pipeline.exec()
  }

  async deleteCache(...keys: Key[]): Promise<number> {
    return this.redis.del(...keys)
  }

  async deletePattern(pattern: string, batch: number = 100): Promise<void> {
    const jobs: any[] = []
    const length = this.prefix.length
    let pipeline = this.redis.pipeline()
    for await (const keys of this.redis.scanStream({ match: `${this.prefix}${pattern}`, count: batch })) {
      for (const key of keys) {
        pipeline.del(key.substring(length))
      }
      if (pipeline.length >= batch) {
        jobs.push(pipeline.exec())
        pipeline = this.redis.pipeline()
      }
    }
    jobs.push(pipeline.exec())
    await Promise.all(jobs)
  }

  async hashCache<T>(key: Key, id: Key, fn: () => Awaitable<T>): Promise<T> {
    let value = await this.getHashCache(key, id)
    if (value !== NOT_FOUND_VALUE) {
      return value
    }
    value = await fn()
    await this.setHashCache(key, id, value)
    return value
  }

  async getHashCache(key: Key, id: Key) {
    const data = await this.redis.hget(key, id)
    return data ? this.parser.parse(data) : NOT_FOUND_VALUE
  }

  async setHashCache(key: Key, id: Key, value: any): Promise<number> {
    const data = this.parser.stringify(value)
    return this.redis.hset(key, id, data)
  }

  async hashManyCache<K extends Key, T>(key: Key, ids: K[], fn: (ids: K[]) => Awaitable<Map<T> | T[]>): Promise<T[]> {
    const cachedValues = await this.getHashManyCache(key, ids)
    const uncachedIds: K[] = []
    for (let i = 0; i < cachedValues.length; ++i) {
      if (cachedValues[i] === NOT_FOUND_VALUE) { uncachedIds.push(ids[i]) }
    }

    if (uncachedIds.length) {
      const uncachedValues = await fn(uncachedIds)
      const uncachedValueMap = Array.isArray(uncachedValues)
        ? uncachedIds.reduce((c, key, idx) => Object.assign(c, { [key.toString()]: uncachedValues[idx] }), {})
        : uncachedValues
      await this.setHashManyCache(key, uncachedValueMap)
      for (let i = 0; i < cachedValues.length; ++i) {
        if (cachedValues[i] === NOT_FOUND_VALUE) {
          cachedValues[i] = uncachedValueMap[ids[i].toString()]
        }
      }
    }
    return cachedValues
  }

  async getHashManyCache(key: Key, ids: Key[]): Promise<any[]> {
    if (ids.length <= 0) { return [] }
    let data = await this.redis.hmget(key, ...ids)
    data = data.map((e: string | null) => !e ? NOT_FOUND_VALUE : this.parser.parse(e))
    return data
  }

  async setHashManyCache(key: Key, valueMap: { [id: string]: any; }) {
    if (Object.keys(valueMap).length <= 0) { return [] }
    const params = this._buildSetParams(valueMap)
    return this.redis.hmset(key, params)
  }

  async deleteHashCache(key: Key, ...ids: Key[]): Promise<number> {
    return this.redis.hdel(key, ...ids)
  }

  async acquire<T>(key: Key, amount: number, fn: (current: number) => Awaitable<T>, float: boolean = false): Promise<T> {
    const change = (float ? this.redis.incrbyfloat : this.redis.incrby) as (key: Key, amount: number) => Promise<number>
    const parser: (value: any) => number = float ? parseFloat : parseInt
    try {
      const current = await change.call(this.redis, key, amount)
      const result = await fn(parser(current))
      return result
    } catch (error) {
      const n = await change.call(this.redis, key, -amount)
      throw error
    }
  }

  async hashAcquire<T>(key: Key, id: Key, amount: number, fn: (current: number) => Awaitable<T>, float: boolean = false): Promise<T> {
    const change = (float ? this.redis.hincrbyfloat : this.redis.hincrby) as (key: Key, id: Key, amount: string | number) => Promise<string>
    const parser: (value: any) => number = float ? parseFloat : parseInt
    try {
      const current = await change.call(this.redis, key, id, amount)
      const result = await fn(parser(current))
      return result
    } catch (error) {
      await change.call(this.redis, key, id, -amount)
      throw error
    }
  }

  protected _buildSetParams = (valueMap: { [id: string]: any; }) => {
    const params: string[] = []
    for (let [key, value] of Object.entries(valueMap)) {
      params.push(key, this.parser.stringify(value))
    }
    return params
  }
}

export default Cache

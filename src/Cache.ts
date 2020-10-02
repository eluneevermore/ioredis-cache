import Redis from 'ioredis'

interface Parser {
  parse: (text: string) => any
  stringify: (value: any) => string
}

interface CacheOptions {
  redis: object | Redis
  parser: Parser
}

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
    let config = options
    if (isRedis(options)) {
      config = { redis: options }
    }

    if (isRedis(config.redis)) {
      this.redis = config.redis
    } else {
      this.redis = new Redis(config.redis)
    }

    this.prefix = this.redis.options.keyPrefix
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

  async cache<T>(key: string, fn: () => T, ttl?: number): Promise<T> {
    let value = await this.getCache(key)
    if (value !== NOT_FOUND_VALUE) {
      return value
    }
    value = await fn()
    await this.setCache(key, value, ttl)
    return value
  }

  async getCache(key: string) {
    const data = await this.redis.get(key)
    return data ? this.parser.parse(data) : NOT_FOUND_VALUE
  }

  async setCache(key: string, value: any, ttl?: number) {
    const data = this.parser.stringify(value)
    return (ttl !== undefined ? this.redis.setex(key, ttl, data) : this.redis.set(key, data))
  }

  async manyCache(keys: string[], fn: (keys: string[]) => { [id: string]: any }, prefix: string = '', ttl?: number) {
    const fullKeys = keys.map(key => `${prefix}${key}`)
    const cachedValues = await this.getManyCache(fullKeys)
    const uncachedKeys: string[] = []
    for (let i = 0; i < cachedValues.length; ++i) {
      if (cachedValues[i] === NOT_FOUND_VALUE) { uncachedKeys.push(keys[i]) }
    }

    if (uncachedKeys.length) {
      const uncachedValueMap = await fn(uncachedKeys)
      const fullKeyUncachedValueMap = Object.entries(uncachedValueMap).reduce((c, [key, value]) =>
        Object.assign(c, { [`${prefix}${key}`]: value }), {})
      await this.setManyCache(fullKeyUncachedValueMap, ttl)

      for (let i = 0; i < cachedValues.length; ++i) {
        if (cachedValues[i] === undefined) {
          cachedValues[i] = uncachedValueMap[keys[i]]
        }
      }
    }
    return cachedValues
  }

  async getManyCache(keys: string[]) {
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

  async deleteCache(...keys: string[]): Promise<number> {
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

  async hashCache<T>(key: string, id: string, fn: () => T): Promise<T> {
    let value = await this.getHashCache(key, id)
    if (value !== NOT_FOUND_VALUE) {
      return value
    }
    value = await fn()
    await this.setHashCache(key, id, value)
    return value
  }

  async getHashCache(key: string, id: string) {
    const data = await this.redis.hget(key, id)
    return data ? this.parser.parse(data) : NOT_FOUND_VALUE
  }

  async setHashCache(key: string, id: string, value: any) {
    const data = this.parser.stringify(value)
    return this.redis.hset(key, id, data)
  }

  async hashManyCache(key: string, ids: string[], fn: (ids: string[]) => { [id: string]: any }): Promise<any[]> {
    const cachedValues = await this.getHashManyCache(key, ids)
    const uncachedIds: string[] = []
    for (let i = 0; i < cachedValues.length; ++i) {
      if (cachedValues[i] === NOT_FOUND_VALUE) { uncachedIds.push(ids[i]) }
    }

    if (uncachedIds.length) {
      const uncachedValueMap = await fn(uncachedIds)
      await this.setHashManyCache(key, uncachedValueMap)
      for (let i = 0; i < cachedValues.length; ++i) {
        if (cachedValues[i] === undefined) {
          cachedValues[i] = uncachedValueMap[ids[i]]
        }
      }
    }
    return cachedValues
  }

  async getHashManyCache(key: string, ids: string[]): Promise<any[]> {
    if (ids.length <= 0) { return [] }
    let data = await this.redis.hmget(key, ids)
    data = data.map((e: string | null) => !e ? NOT_FOUND_VALUE : this.parser.parse(e))
    return data
  }

  async setHashManyCache(key: string, valueMap: { [id: string]: any; }) {
    if (Object.keys(valueMap).length <= 0) { return [] }
    const params = this._buildSetParams(valueMap)
    return this.redis.hmset(key, params)
  }

  async deleteHashCache(key: string, ...ids: string[]): Promise<number> {
    return this.redis.hdel(key, ...ids)
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

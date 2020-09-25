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

class Cache {
  redis: Redis;
  protected prefix: string;
  protected parser: Parser = JSON;

  constructor(options: Redis | CacheOptions) {
    let config = options
    if (options instanceof Redis) {
      config = { redis: options }
    }

    if (config.redis instanceof Redis) {
      this.redis = config.redis
    } else {
      this.redis = new Redis(config.redis)
    }

    this.prefix = this.redis.options.keyPrefix
    if (config.parser !== undefined) {
      this.parser = config.parser
    }
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
    const params: string[] = []
    for (let [key, value] of Object.entries(valueMap)) {
      params.push(key, this.parser.stringify(value))
    }
    return this.redis.hmset(key, params)
  }

  async deleteHashCache(key: string, ...ids: string[]): Promise<number> {
    return this.redis.hdel(key, ...ids)
  }
}

export default Cache

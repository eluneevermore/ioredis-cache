import Cache from './index'
import Redis from 'ioredis'

describe('Cache', () => {

  const config = {
    host: 'localhost',
    port: 6379,
    db: 1,
    keyPrefix: 'ioredis-cache',
  }
  const redis = new Redis(config)
  const parser = { parse: (str: string) => ({}), stringify: (obj: any) => '' }
  const cache = new Cache(redis)
  const key = 'test'
  const key2 = 'test2'
  const value1 = { a: 1, o: { x: "!" } }
  const strValue1 = JSON.stringify(value1)
  const value2 = { b: 2 }
  const strValue2 = JSON.stringify(value2)
  const queryFn = async () => value2
  const id = 'id'
  const id2 = 'id2'
  const ttl = 1
  const cachedMap = { cached1: 1, cached2: 2 }
  const uncachedMap = { uncached: "abc" }
  const dataMap = { ...cachedMap, ...uncachedMap }
  const allIds = ['cached1', 'uncached', 'cached2', 'empty']
  const queryManyFn = (ids) =>
    ids.reduce((c, id) => {
      if (dataMap[id]) {
        c[id] = dataMap[id]
      }
      return c
    }, {})

  const sleep = (ms) =>
    new Promise(resolve => {
      setTimeout(resolve, ms)
    })

  beforeEach(async () => {
    await redis.flushdb()
  })

  describe('#contructor', () => {
    describe('when pass redis instance', () => {
      let params = redis
      it('create Cache object with correct properties', () => {
        let cache = new Cache(params)
        expect(cache.redis).toBe(redis)
        expect(cache['prefix']).toBe(config.keyPrefix)
        expect(cache['parser']).toBe(JSON)
      })
    })

    describe('when pass redis config', () => {
      let params = { redis: config }

      it('create Cache object with correct properties', async () => {
        let cache = new Cache(params)
        try {
          expect(cache.redis instanceof Redis).toBeTruthy()
          expect(cache['prefix']).toBe(config.keyPrefix)
          expect(cache['parser']).toBe(JSON)
        } finally {
          cache.redis.quit()
        }
      })
    })

    describe('when pass custom JSON parser', () => {
      let params = { redis, parser }
      it('create Cache object with correct properties', async () => {
        let cache = new Cache(params)
        expect(cache.redis).toBe(redis)
        expect(cache['parser']).toBe(parser)
      })
    })
  })

  describe('#cache', () => {
    describe('when key exists', () => {
      beforeEach(async () => {
        await redis.set(key, JSON.stringify(value1))
      })
      it('returns cached value', async () => {
        const result = await cache.cache(key, queryFn)
        expect(result).toEqual(value1)
      })

      describe('when pass ttl', () => {
        it('does not delete the value after ttl', async () => {
          await cache.cache(key, queryFn, ttl)
          await sleep(ttl * 1000 + 100)
          const result = await cache.getCache(key)
          expect(result).toEqual(value1)
        })
      })
    })

    describe('when key does not exist', () => {
      it('returns data from callback functon', async () => {
        const result = await cache.cache(key, queryFn)
        expect(result).toEqual(value2)
      })

      it('stores data from callback function', async () => {
        await cache.cache(key, queryFn)
        let fn2 = jest.fn(() => 1)
        const result = await cache.cache(key, fn2)
        expect(result).toEqual(value2)
        expect(fn2.mock.calls.length).toBe(0)
      })

      describe('when pass ttl', () => {

        it('stores the value within ttl', async () => {
          await cache.cache(key, queryFn, ttl)
          const result = await cache.getCache(key)
          expect(result).toEqual(value2)
        })

        it('deletes the value after ttl', async () => {
          await cache.cache(key, queryFn, ttl)
          await sleep(ttl * 1000 + 100)
          const result = await cache.getCache(key)
          expect(result).toBe(undefined)
        })
      })
    })

    describe('when pass null value', () => {
      it('caches null value', async () => {
        let result: any = await cache.cache(key, () => null)
        expect(result).toBe(null)
        result = await cache.cache(key, () => value2)
        expect(result).toBe(null)
      })
    })

    describe('when pass string value', () => {
      it('caches string value', async () => {
        let result: any = await cache.cache(key, () => "abc")
        expect(result).toBe("abc")
        result = await cache.cache(key, () => "def")
        expect(result).toBe("abc")
      })
    })

    describe('when pass number value', () => {
      it('caches number value', async () => {
        let result: any = await cache.cache(key, () => 1)
        expect(result).toBe(1)
        result = await cache.cache(key, () => 2)
        expect(result).toBe(1)
      })
    })
  })

  describe('#getCache', () => {
    describe('when key exists', () => {
      beforeEach(async () => {
        await redis.set(key, strValue1)
      })
      it('returns cached value', async () => {
        const result = await cache.getCache(key)
        expect(result).toEqual(value1)
      })
    })
    describe('when key does not exist', () => {
      it('returns undefined', async () => {
        const result = await cache.getCache(key)
        expect(result).toBe(undefined)
      })
    })
  })

  describe('#setCache', () => {
    beforeEach(async () => {
      await redis.set(key, strValue1)
    })

    it('stores the value', async () => {
      await cache.setCache(key, value1)
      const result = await cache.getCache(key)
      expect(result).toEqual(value1)
    })

    describe('when pass ttl', () => {
      it('stores the value within ttl', async () => {
        await cache.setCache(key, value1, ttl)
        const result = await cache.getCache(key)
        expect(result).toEqual(value1)
      })

      it('deletes the value after ttl', async () => {
        await cache.setCache(key, value1, ttl)
        await sleep(ttl * 1000 + 100)
        const result = await cache.getCache(key)
        expect(result).toBe(undefined)
      })
    })
  })

  describe('#deleteCache', () => {
    beforeEach(async () => {
      await cache.setCache(key, value1)
      await cache.setHashCache(key2, id, value1)
      await cache.setHashCache(key2, id2, value2)
    })

    it('deletes cache value', async () => {
      await cache.deleteCache(key, key2)
      const result = await cache.getCache(key)
      expect(result).toBe(undefined)
      const result2 = await cache.getHashCache(key2, id)
      expect(result2).toBe(undefined)
      const result3 = await cache.getHashCache(key2, id)
      expect(result3).toBe(undefined)
    })

    it('returns deleted cache', async () => {
      const deleted = await cache.deleteCache(key, key2, 'empty_key')
      expect(deleted).toBe(2)
    })
  })

  describe('#deletePattern', () => {
    let key3 = 'othertest'
    let key4 = 'otherkey'

    beforeEach(async () => {
      await redis.mset(key, strValue1, key2, strValue2, key3, "1", key4, "1")
    })

    it('deletes keys that matched the pattern', async () => {
      await cache.deletePattern('*test*')
      expect(await cache.getCache(key)).toBe(undefined)
      expect(await cache.getCache(key2)).toBe(undefined)
      expect(await cache.getCache(key3)).toBe(undefined)
    })

    it('does not delete keys that unmatched the pattern', async () => {
      await cache.deletePattern('*test*')
      expect(await cache.getCache(key4)).toBe(1)
    })
  })

  describe('hashCache', () => {
    describe('when id exists', () => {

      beforeEach(async () => {
        redis.hmset(key, id, strValue1)
      })

      it('returns the cached value', async () => {
        const result = await cache.hashCache(key, id, queryFn)
        expect(result).toEqual(value1)
      })
    })

    describe('when id does not exists', () => {

      beforeEach(async () => {
        redis.hset(key, id, strValue1)
      })

      it('returns the value from callback', async () => {
        const result = await cache.hashCache(key, id2, queryFn)
        expect(result).toEqual(value2)
      })

      it('stores the value from callback', async () => {
        await cache.hashCache(key, id2, queryFn)
        let fn2 = jest.fn(() => 1)
        const result = await cache.hashCache(key, id2, fn2)
        expect(result).toEqual(value2)
        expect(fn2.mock.calls.length).toBe(0)
      })
    })
  })

  describe('#setHashCache', () => {
    beforeEach(async () => {
      await redis.hset(key, id, strValue1)
    })
    it('stores the value', async () => {
      await cache.setHashCache(key, id, value2)
      const result = await cache.getHashCache(key, id)
      expect(result).toEqual(value2)
    })
  })

  describe('#getHashCache', () => {
    beforeEach(async () => {
      await cache.setHashCache(key, id, value1)
    })

    describe('when id existed', () => {
      it('returns the cached value', async () => {
        const result = await cache.getHashCache(key, id)
        expect(result).toEqual(value1)
      })
    })

    describe('when id does not exist', () => {
      it('returns undefined', async () => {
        const result = await cache.getHashCache(key, id2)
        expect(result).toBe(undefined)
        const result2 = await cache.getHashCache(key2, id)
        expect(result2).toBe(undefined)
      })
    })
  })

  describe('#hashManyCache', () => {
    let fn: jest.MockedFunction<(...keys: any[]) => { [id: string]: any }>

    beforeEach(async () => {
      await cache.setHashManyCache(key, cachedMap)
      fn = jest.fn(queryManyFn)
    })

    it('passes uncached ids to callback', async () => {
      const result = await cache.hashManyCache(key, allIds, fn)
      expect(fn.mock.calls.length).toBe(1)
      expect(fn.mock.calls[0][0]).toContain('uncached')
      expect(fn.mock.calls[0][0]).toContain('empty')
    })

    it('returns combined cached and uncached values', async () => {
      const result = await cache.hashManyCache(key, allIds, fn)
      expect(result).toEqual([1, "abc", 2, undefined])
    })

    it('stores the uncached values', async () => {
      await cache.hashManyCache(key, allIds, fn)
      const result = await cache.hashManyCache(key, allIds, fn)
      expect(result).toEqual([1, "abc", 2, undefined])

      expect(fn.mock.calls[1][0]).toEqual(['empty'])
    })
  })

  describe('#getHashManyCache', () => {
    beforeEach(async () => {
      await cache.setHashManyCache(key, cachedMap)
    })
    it('returns cached values and undefined for uncached values', async () => {
      const result = await cache.getHashManyCache(key, allIds)
      expect(result).toEqual([1, undefined, 2, undefined])
    })
  })

  describe('#setHashManyCache', () => {

    beforeEach(async () => {
      await cache.setHashManyCache(key, cachedMap)
    })
    it('stores the values', async () => {
      await cache.setHashManyCache(key, { uncached: 3 })
      const result = await cache.getHashManyCache(key, allIds)
      expect(result).toEqual([1, 3, 2, undefined])
    })
  })

  describe('#deleteHashCache', () => {
    beforeEach(async () => {
      await cache.setHashManyCache(key, cachedMap)
    })
    it('deletes the cached ids', async () => {
      await cache.deleteHashCache(key, 'cached1', 'uncached')
      const result = await cache.getHashCache(key, 'cached1')
      expect(result).toBe(undefined)
    })
    it('does not delete unlist ids', async () => {
      await cache.deleteHashCache(key, 'cached1', 'uncached')
      const result = await cache.getHashCache(key, 'cached2')
      expect(result).toEqual(cachedMap['cached2'])
    })
    it('returns the number of deleted ids', async () => {
      const result = await cache.deleteHashCache(key, 'cached1', 'uncached')
      expect(result).toBe(1)
    })
  })

  afterAll(async () => {
    await redis.quit()
  })
})

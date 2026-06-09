/// <reference types="jest" />

import Redis from 'ioredis';
import { Acquire } from './Acquire';
import Cache from './index';
import { LuaAcquire } from './LuaAcquire';

type CachedValue = string | number;
type CachedValueMap = Record<string, CachedValue | undefined>;
type ObjectFetcher = (ids: string[]) => Record<string, CachedValue>;
type ArrayFetcher = (ids: string[]) => Array<CachedValue | undefined>;
type MapFetcher = (ids: string[]) => Map<string, CachedValue | undefined>;
type RedisCommand = { name?: unknown };

const LUA_COMMAND_NAMES = ['eval', 'evalsha'];

describe('Cache', () => {
  const config = {
    host: 'localhost',
    port: 6379,
    db: 1,
    keyPrefix: 'ioredis-cache',
  };
  const redis = new Redis(config);
  const parser = {
    parse: (_str: string) => ({}),
    stringify: (_value: unknown) => '',
  };
  const cache = new Cache(redis);
  const textParser = {
    parse: (str: string) => str,
    stringify: (value: unknown) => String(value),
  };
  const textCache = new Cache({ redis, parser: textParser });
  const key = 'test1';
  const key2 = 'test2';
  const value1 = { a: 1, o: { x: '!' } };
  const strValue1 = JSON.stringify(value1);
  const value2 = { b: 2 };
  const strValue2 = JSON.stringify(value2);
  const queryFn = async () => value2;
  const id = 'id';
  const id2 = 'id2';
  const ttl = 1;
  const cachedMap = { cached1: 1, cached2: 2 };
  const uncachedMap = { uncached: 'abc' };
  const dataMap: CachedValueMap = { ...cachedMap, ...uncachedMap };
  const allIds = ['cached1', 'uncached', 'cached2', 'empty'];
  const queryManyFn: ObjectFetcher = (ids) =>
    ids.reduce<Record<string, CachedValue>>((c, id) => {
      const value = dataMap[id];
      if (value !== undefined) {
        c[id] = value;
      }
      return c;
    }, {});
  const queryManyAsArrayFn: ArrayFetcher = (ids) =>
    ids.map((id) => dataMap[id]);
  const queryManyAsMapFn: MapFetcher = (ids) =>
    new Map(ids.map((id) => [id, dataMap[id]]));

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  const hasLuaCommand = (spy: {
    mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> };
  }): boolean => {
    return spy.mock.calls.some(([command]) => {
      const name = String((command as RedisCommand).name);
      return LUA_COMMAND_NAMES.includes(name);
    });
  };

  beforeEach(async () => {
    await redis.flushdb();
  });

  describe('#contructor', () => {
    describe('when pass redis instance', () => {
      const params = redis;
      it('create Cache object with correct properties', () => {
        const cache = new Cache(params);
        expect(cache.redis).toBe(redis);
        expect(cache['prefix']).toBe(config.keyPrefix);
        expect(cache['parser']).toBe(JSON);
      });
    });

    describe('when pass redis config instead of instance', () => {
      const params = { redis: config };

      it('throws an error', () => {
        expect(() => {
          new Cache(
            params as unknown as ConstructorParameters<typeof Cache>[0],
          );
        }).toThrow('Cache requires an ioredis instance');
      });
    });

    describe('when pass custom JSON parser', () => {
      const params = { redis, parser };
      it('create Cache object with correct properties', async () => {
        const cache = new Cache(params);
        expect(cache.redis).toBe(redis);
        expect(cache['parser']).toBe(parser);
      });
    });

    describe('when no acquire type is configured', () => {
      it('uses LuaAcquire by default', () => {
        const cache = new Cache(redis);
        expect(cache['acquireHelper']).toBeInstanceOf(LuaAcquire);
      });
    });

    describe('when pipeline acquire type is configured', () => {
      it('uses Acquire', () => {
        const cache = new Cache({ redis, acquireType: 'pipeline' });
        expect(cache['acquireHelper']).toBeInstanceOf(Acquire);
      });
    });

    describe('when acquire helper is configured', () => {
      it('uses the provided helper', () => {
        const acquire = new Acquire(redis);
        const cache = new Cache({ redis, acquire });
        expect(cache['acquireHelper']).toBe(acquire);
      });
    });
  });

  describe('.bindAll', () => {
    it('binds the functions of a cache with the cache', async () => {
      const { setCache, getCache } = Cache.bindAll(cache);
      await setCache(key, value1);
      expect(getCache(key)).resolves.toEqual(value1);
    });
  });

  describe('#cache', () => {
    describe('when key exists', () => {
      beforeEach(async () => {
        await redis.set(key, JSON.stringify(value1));
      });
      it('returns cached value', async () => {
        const result = await cache.cache(key, queryFn);
        expect(result).toEqual(value1);
      });

      describe('when pass ttl', () => {
        it('does not delete the value after ttl', async () => {
          await cache.cache(key, queryFn, ttl);
          await sleep(ttl * 1000 + 100);
          const result = await cache.getCache(key);
          expect(result).toEqual(value1);
        });
      });
    });

    describe('when key does not exist', () => {
      it('returns data from callback functon', async () => {
        const result = await cache.cache(key, queryFn);
        expect(result).toEqual(value2);
      });

      it('stores data from callback function', async () => {
        await cache.cache(key, queryFn);
        const fn2 = jest.fn(() => 1);
        const result = await cache.cache(key, fn2);
        expect(result).toEqual(value2);
        expect(fn2.mock.calls.length).toBe(0);
      });

      describe('when pass ttl', () => {
        it('stores the value within ttl', async () => {
          await cache.cache(key, queryFn, ttl);
          const result = await cache.getCache(key);
          expect(result).toEqual(value2);
        });

        it('deletes the value after ttl', async () => {
          await cache.cache(key, queryFn, ttl);
          await sleep(ttl * 1000 + 100);
          const result = await cache.getCache(key);
          expect(result).toBe(undefined);
        });
      });
    });

    describe('when pass null value', () => {
      it('caches null value', async () => {
        const firstResult = await cache.cache(key, () => null);
        expect(firstResult).toBe(null);
        const secondResult = await cache.cache(key, () => value2);
        expect(secondResult).toBe(null);
      });
    });

    describe('when pass string value', () => {
      it('caches string value', async () => {
        let result = await cache.cache(key, () => 'abc');
        expect(result).toBe('abc');
        result = await cache.cache(key, () => 'def');
        expect(result).toBe('abc');
      });
    });

    describe('when pass number value', () => {
      it('caches number value', async () => {
        let result = await cache.cache(key, () => 1);
        expect(result).toBe(1);
        result = await cache.cache(key, () => 2);
        expect(result).toBe(1);
      });
    });

    describe('when pass undefined value', () => {
      it('does not cache undefined value', async () => {
        const firstResult = await cache.cache(key, () => undefined);
        expect(firstResult).toBe(undefined);
        const secondResult = await cache.cache(key, () => 1);
        expect(secondResult).toBe(1);
      });
    });

    describe('with a parser that supports empty strings', () => {
      it('treats empty strings as cached values', async () => {
        await textCache.setCache(key, '');
        const fn = jest.fn(() => 'fallback');
        const result = await textCache.cache(key, fn);
        expect(result).toBe('');
        expect(fn.mock.calls.length).toBe(0);
      });
    });
  });

  describe('#getCache', () => {
    describe('when key exists', () => {
      beforeEach(async () => {
        await redis.set(key, strValue1);
      });
      it('returns cached value', async () => {
        const result = await cache.getCache(key);
        expect(result).toEqual(value1);
      });
    });
    describe('when key does not exist', () => {
      it('returns undefined', async () => {
        const result = await cache.getCache(key);
        expect(result).toBe(undefined);
      });
    });
  });

  describe('#setCache', () => {
    beforeEach(async () => {
      await redis.set(key, strValue2);
    });

    it('stores the value', async () => {
      await cache.setCache(key, value1);
      const result = await cache.getCache(key);
      expect(result).toEqual(value1);
    });

    describe('when pass ttl', () => {
      it('stores the value within ttl', async () => {
        await cache.setCache(key, value1, ttl);
        const result = await cache.getCache(key);
        expect(result).toEqual(value1);
      });

      it('deletes the value after ttl', async () => {
        await cache.setCache(key, value1, ttl);
        await sleep(ttl * 1000 + 100);
        const result = await cache.getCache(key);
        expect(result).toBe(undefined);
      });
    });
  });

  describe('#manyCache', () => {
    let fn: jest.MockedFunction<ObjectFetcher>;
    let fnAsArray: jest.MockedFunction<ArrayFetcher>;
    let fnAsMap: jest.MockedFunction<MapFetcher>;
    const prefix = 'test_';
    const cachedMapWithPrefix = Object.entries(cachedMap).reduce<
      Record<string, number>
    >(
      (c, [key, value]) => Object.assign(c, { [`${prefix}${key}`]: value }),
      {},
    );

    beforeEach(async () => {
      await cache.setManyCache(cachedMapWithPrefix);
      fn = jest.fn(queryManyFn);
      fnAsArray = jest.fn(queryManyAsArrayFn);
      fnAsMap = jest.fn(queryManyAsMapFn);
    });

    it('passes uncached ids to callback', async () => {
      const result = await cache.manyCache(allIds, fn, prefix);
      expect(fn.mock.calls.length).toBe(1);
      expect(fn.mock.calls[0][0]).toContain('uncached');
      expect(fn.mock.calls[0][0]).toContain('empty');
    });

    it('returns combined cached and uncached values', async () => {
      const result = await cache.manyCache(allIds, fn, prefix);
      expect(result).toEqual([1, 'abc', 2, undefined]);
    });

    it('stores the uncached values', async () => {
      await cache.manyCache(allIds, fn, prefix);
      const result = await cache.manyCache(allIds, fn, prefix);
      expect(result).toEqual([1, 'abc', 2, undefined]);

      expect(fn.mock.calls[1][0]).toEqual(['empty']);
    });

    it('works with fetcher return array', async () => {
      await cache.manyCache(allIds, fnAsArray, prefix);
      const result = await cache.manyCache(allIds, fnAsArray, prefix);
      expect(result).toEqual([1, 'abc', 2, undefined]);
      expect(fnAsArray.mock.calls[0][0]).toContain('uncached');
      expect(fnAsArray.mock.calls[0][0]).toContain('empty');
      expect(fnAsArray.mock.calls[1][0]).toEqual(['empty']);
    });

    it('works with fetcher return map', async () => {
      await cache.manyCache(allIds, fnAsMap, prefix);
      const result = await cache.manyCache(allIds, fnAsMap, prefix);
      expect(result).toEqual([1, 'abc', 2, undefined]);
      expect(fnAsMap.mock.calls[0][0]).toContain('uncached');
      expect(fnAsMap.mock.calls[0][0]).toContain('empty');
      expect(fnAsMap.mock.calls[1][0]).toEqual(['empty']);
    });

    describe('with ttl', () => {
      it('stores the uncached values within ttl', async () => {
        await cache.manyCache(allIds, fn, prefix, ttl);
        const result = await cache.getCache(`${prefix}uncached`);
        expect(result).toEqual('abc');
      });

      it('deletes the uncached value after ttl', async () => {
        await cache.manyCache(allIds, fn, prefix, ttl);
        await sleep(ttl * 1000 + 100);
        const result = await cache.getCache(`${prefix}uncached`);
        expect(result).toBe(undefined);
      });

      it('does not delete the cached value after ttl', async () => {
        await cache.manyCache(allIds, fn, prefix, ttl);
        await sleep(ttl * 1000 + 100);
        const result = await cache.getCache(`${prefix}cached1`);
        expect(result).toEqual(1);
      });
    });
  });

  describe('#getManyCache', () => {
    beforeEach(async () => {
      await redis.set(key, strValue1);
    });

    it('returns cached values and undefined for uncached values', async () => {
      const result = await cache.getManyCache(['test1', 'test2']);
      expect(result).toEqual([value1, undefined]);
    });
  });

  describe('#setManyCache', () => {
    beforeEach(async () => {
      await redis.set(key, strValue2);
    });

    it('stores the value', async () => {
      await cache.setManyCache({ [key]: value1, [key2]: value2 });
      const result1 = await cache.getCache(key);
      expect(result1).toEqual(value1);
      const result2 = await cache.getCache(key2);
      expect(result2).toEqual(value2);
    });

    describe('when pass ttl', () => {
      it('stores the value within ttl', async () => {
        await cache.setManyCache({ [key]: value1, [key2]: value2 }, ttl);
        const result = await cache.getManyCache([key, key2]);
        expect(result).toEqual([value1, value2]);
      });

      it('deletes the value after ttl', async () => {
        await cache.setManyCache({ [key]: value1, [key2]: value2 }, ttl);
        await sleep(ttl * 1000 + 100);
        const result = await cache.getManyCache([key, key2]);
        expect(result).toEqual([undefined, undefined]);
      });
    });
  });

  describe('#deleteCache', () => {
    beforeEach(async () => {
      await cache.setCache(key, value1);
      await cache.setHashCache(key2, id, value1);
      await cache.setHashCache(key2, id2, value2);
    });

    it('deletes cache value', async () => {
      await cache.deleteCache(key, key2);
      const result = await cache.getCache(key);
      expect(result).toBe(undefined);
      const result2 = await cache.getHashCache(key2, id);
      expect(result2).toBe(undefined);
      const result3 = await cache.getHashCache(key2, id);
      expect(result3).toBe(undefined);
    });

    it('returns deleted cache', async () => {
      const deleted = await cache.deleteCache(key, key2, 'empty_key');
      expect(deleted).toBe(2);
    });
  });

  describe('#deletePattern', () => {
    let key3 = 'othertest';
    let key4 = 'otherkey';

    beforeEach(async () => {
      await redis.mset(key, strValue1, key2, strValue2, key3, '1', key4, '1');
    });

    it('deletes keys that matched the pattern', async () => {
      await cache.deletePattern('*test*');
      expect(await cache.getCache(key)).toBe(undefined);
      expect(await cache.getCache(key2)).toBe(undefined);
      expect(await cache.getCache(key3)).toBe(undefined);
    });

    it('does not delete keys that unmatched the pattern', async () => {
      await cache.deletePattern('*test*');
      expect(await cache.getCache(key4)).toBe(1);
    });
  });

  describe('#hashCache', () => {
    describe('when id exists', () => {
      beforeEach(async () => {
        redis.hmset(key, id, strValue1);
      });

      it('returns the cached value', async () => {
        const result = await cache.hashCache(key, id, queryFn);
        expect(result).toEqual(value1);
      });
    });

    describe('when id does not exists', () => {
      beforeEach(async () => {
        redis.hset(key, id, strValue1);
      });

      it('returns the value from callback', async () => {
        const result = await cache.hashCache(key, id2, queryFn);
        expect(result).toEqual(value2);
      });

      it('stores the value from callback', async () => {
        await cache.hashCache(key, id2, queryFn);
        const fn2 = jest.fn(() => 1);
        const result = await cache.hashCache(key, id2, fn2);
        expect(result).toEqual(value2);
        expect(fn2.mock.calls.length).toBe(0);
      });
    });

    describe('when pass undefined value', () => {
      it('does not cache undefined value', async () => {
        const firstResult = await cache.hashCache(key, id, () => undefined);
        expect(firstResult).toBe(undefined);
        const secondResult = await cache.hashCache(key, id, () => 1);
        expect(secondResult).toBe(1);
      });
    });

    describe('with a parser that supports empty strings', () => {
      it('treats empty strings as cached values', async () => {
        await textCache.setHashCache(key, id, '');
        const fn = jest.fn(() => 'fallback');
        const result = await textCache.hashCache(key, id, fn);
        expect(result).toBe('');
        expect(fn.mock.calls.length).toBe(0);
      });
    });
  });

  describe('#setHashCache', () => {
    beforeEach(async () => {
      await redis.hset(key, id, strValue1);
    });
    it('stores the value', async () => {
      await cache.setHashCache(key, id, value2);
      const result = await cache.getHashCache(key, id);
      expect(result).toEqual(value2);
    });
  });

  describe('#getHashCache', () => {
    beforeEach(async () => {
      await cache.setHashCache(key, id, value1);
    });

    describe('when id existed', () => {
      it('returns the cached value', async () => {
        const result = await cache.getHashCache(key, id);
        expect(result).toEqual(value1);
      });
    });

    describe('when id does not exist', () => {
      it('returns undefined', async () => {
        const result = await cache.getHashCache(key, id2);
        expect(result).toBe(undefined);
        const result2 = await cache.getHashCache(key2, id);
        expect(result2).toBe(undefined);
      });
    });
  });

  describe('#hashManyCache', () => {
    let fn: jest.MockedFunction<ObjectFetcher>;
    let fnAsArray: jest.MockedFunction<ArrayFetcher>;
    let fnAsMap: jest.MockedFunction<MapFetcher>;

    beforeEach(async () => {
      await cache.setHashManyCache(key, cachedMap);
      fn = jest.fn(queryManyFn);
      fnAsArray = jest.fn(queryManyAsArrayFn);
      fnAsMap = jest.fn(queryManyAsMapFn);
    });

    it('passes uncached ids to callback', async () => {
      const result = await cache.hashManyCache(key, allIds, fn);
      expect(fn.mock.calls.length).toBe(1);
      expect(fn.mock.calls[0][0]).toContain('uncached');
      expect(fn.mock.calls[0][0]).toContain('empty');
    });

    it('returns combined cached and uncached values', async () => {
      const result = await cache.hashManyCache(key, allIds, fn);
      expect(result).toEqual([1, 'abc', 2, undefined]);
    });

    it('stores the uncached values', async () => {
      await cache.hashManyCache(key, allIds, fn);
      const result = await cache.hashManyCache(key, allIds, fn);
      expect(result).toEqual([1, 'abc', 2, undefined]);

      expect(fn.mock.calls[1][0]).toEqual(['empty']);
    });

    it('works with fetcher return array', async () => {
      await cache.hashManyCache(key, allIds, fnAsArray);
      const result = await cache.hashManyCache(key, allIds, fnAsArray);
      expect(result).toEqual([1, 'abc', 2, undefined]);
      expect(fnAsArray.mock.calls[0][0]).toContain('uncached');
      expect(fnAsArray.mock.calls[0][0]).toContain('empty');
      expect(fnAsArray.mock.calls[1][0]).toEqual(['empty']);
    });

    it('works with fetcher return map', async () => {
      await cache.hashManyCache(key, allIds, fnAsMap);
      const result = await cache.hashManyCache(key, allIds, fnAsMap);
      expect(result).toEqual([1, 'abc', 2, undefined]);
      expect(fnAsMap.mock.calls[0][0]).toContain('uncached');
      expect(fnAsMap.mock.calls[0][0]).toContain('empty');
      expect(fnAsMap.mock.calls[1][0]).toEqual(['empty']);
    });
  });

  describe('#getHashManyCache', () => {
    beforeEach(async () => {
      await cache.setHashManyCache(key, cachedMap);
    });
    it('returns cached values and undefined for uncached values', async () => {
      const result = await cache.getHashManyCache(key, allIds);
      expect(result).toEqual([1, undefined, 2, undefined]);
    });
  });

  describe('#setHashManyCache', () => {
    beforeEach(async () => {
      await cache.setHashManyCache(key, cachedMap);
    });
    it('stores the values', async () => {
      await cache.setHashManyCache(key, { uncached: 3 });
      const result = await cache.getHashManyCache(key, allIds);
      expect(result).toEqual([1, 3, 2, undefined]);
    });
  });

  describe('#deleteHashCache', () => {
    beforeEach(async () => {
      await cache.setHashManyCache(key, cachedMap);
    });
    it('deletes the cached ids', async () => {
      await cache.deleteHashCache(key, 'cached1', 'uncached');
      const result = await cache.getHashCache(key, 'cached1');
      expect(result).toBe(undefined);
    });
    it('does not delete unlist ids', async () => {
      await cache.deleteHashCache(key, 'cached1', 'uncached');
      const result = await cache.getHashCache(key, 'cached2');
      expect(result).toEqual(cachedMap['cached2']);
    });
    it('returns the number of deleted ids', async () => {
      const result = await cache.deleteHashCache(key, 'cached1', 'uncached');
      expect(result).toBe(1);
    });
  });

  describe('#acquire', () => {
    let fn: (current: number) => number = (current) => current;

    it('increases value and return fn call', async () => {
      const sendCommandSpy = jest.spyOn(redis, 'sendCommand');
      expect(await cache.acquire(key, 2, fn)).toBe(2);
      expect(await cache.getCache(key)).toBe(2);
      expect(await cache.acquire(key, 1, fn)).toBe(3);
      expect(await cache.getCache(key)).toBe(3);
      expect(await cache.acquire(key2, 2.5, fn, true)).toBe(2.5);
      expect(await cache.getCache(key2)).toBe(2.5);
      expect(hasLuaCommand(sendCommandSpy)).toBe(false);
      sendCommandSpy.mockRestore();
    });

    it('passes acquired and lacking amounts with limit options', async () => {
      await cache.setCache(key, 8);
      const sendCommandSpy = jest.spyOn(redis, 'sendCommand');
      const result = await cache.acquire(
        key,
        5,
        (current, acquired, lacking) => ({ current, acquired, lacking }),
        { limit: 10 },
      );
      expect(result).toEqual({ current: 10, acquired: 2, lacking: 3 });
      expect(await cache.getCache(key)).toBe(10);
      expect(hasLuaCommand(sendCommandSpy)).toBe(true);
      sendCommandSpy.mockRestore();
    });

    it('release value if fn raise error', async () => {
      const fn = (current: number): never => {
        throw new Error(String(current));
      };
      await expect(cache.acquire(key, 2, fn)).rejects.toThrow('2');
      expect(await cache.getCache(key)).toBe(0);
    });
  });

  describe('#acquireMany', () => {
    it('acquires available amounts and releases lacking amounts', async () => {
      await cache.setCache(key2, 4);
      const result = await cache.acquireMany(
        [
          { key, desireAmount: 2 },
          { key: key2, desireAmount: 3, limitAmount: 5 },
        ],
        (acquiredResults) => acquiredResults,
      );
      expect(result).toEqual([
        { key, currentAmount: 2, acquiredAmount: 2, lackingAmount: 0 },
        { key: key2, currentAmount: 5, acquiredAmount: 1, lackingAmount: 2 },
      ]);
      expect(await cache.getCache(key)).toBe(2);
      expect(await cache.getCache(key2)).toBe(5);
    });

    it('releases acquired amounts when callback fails', async () => {
      const fn = (): never => {
        throw new Error('failed');
      };
      await expect(
        cache.acquireMany(
          [
            { key, desireAmount: 2 },
            { key: key2, desireAmount: 3 },
          ],
          fn,
        ),
      ).rejects.toThrow('failed');
      expect(await cache.getCache(key)).toBe(0);
      expect(await cache.getCache(key2)).toBe(0);
    });

    it('supports float limits', async () => {
      await cache.setCache(key2, 1.5);
      const result = await cache.acquireMany(
        [{ key: key2, desireAmount: 1.25, limitAmount: 2 }],
        (acquiredResults) => acquiredResults,
        { float: true },
      );
      expect(result).toEqual([
        {
          key: key2,
          currentAmount: 2,
          acquiredAmount: 0.5,
          lackingAmount: 0.75,
        },
      ]);
      expect(await cache.getCache(key2)).toBe(2);
    });

    it('rejects non-finite float amounts before acquiring any keys', async () => {
      await cache.setCache(key, 4);

      await expect(
        cache.acquireMany(
          [
            { key, desireAmount: 2 },
            { key: key2, desireAmount: Number.NaN },
          ],
          (acquiredResults) => acquiredResults,
          { float: true },
        ),
      ).rejects.toThrow('Acquire amounts must be finite numbers');
      expect(await cache.getCache(key)).toBe(4);
      expect(await cache.getCache(key2)).toBeUndefined();
    });

    it('does not partially acquire when one key cannot be incremented', async () => {
      await cache.setCache(key, 4);
      await redis.set(key2, 'not-an-integer');

      await expect(
        cache.acquireMany(
          [
            { key: key2, desireAmount: 1 },
            { key, desireAmount: 2 },
          ],
          (acquiredResults) => acquiredResults,
        ),
      ).rejects.toThrow('Failed to acquire requested amounts');
      expect(await cache.getCache(key)).toBe(4);
      expect(await redis.get(key2)).toBe('not-an-integer');
    });
  });

  describe('#hashAcquire', () => {
    let fn: (current: number) => number = (current) => current;

    it('increases value and return fn call', async () => {
      const sendCommandSpy = jest.spyOn(redis, 'sendCommand');
      expect(await cache.hashAcquire(key, id, 2, fn)).toBe(2);
      expect(await cache.getHashCache(key, id)).toBe(2);
      expect(await cache.hashAcquire(key, id, 1, fn)).toBe(3);
      expect(await cache.getHashCache(key, id)).toBe(3);
      expect(await cache.hashAcquire(key2, id, 2.5, fn, true)).toBe(2.5);
      expect(await cache.getHashCache(key2, id)).toBe(2.5);
      expect(hasLuaCommand(sendCommandSpy)).toBe(false);
      sendCommandSpy.mockRestore();
    });

    it('passes acquired and lacking hash amounts with limit options', async () => {
      await cache.setHashCache(key, id, 8);
      const sendCommandSpy = jest.spyOn(redis, 'sendCommand');
      const result = await cache.hashAcquire(
        key,
        id,
        5,
        (current, acquired, lacking) => ({ current, acquired, lacking }),
        { limit: 10 },
      );
      expect(result).toEqual({ current: 10, acquired: 2, lacking: 3 });
      expect(await cache.getHashCache(key, id)).toBe(10);
      expect(hasLuaCommand(sendCommandSpy)).toBe(true);
      sendCommandSpy.mockRestore();
    });

    it('release value if fn raise error', async () => {
      const fn = (current: number): never => {
        throw new Error(String(current));
      };
      await expect(cache.hashAcquire(key, id, 2, fn)).rejects.toThrow('2');
      expect(await cache.getHashCache(key, id)).toBe(0);
    });
  });

  describe('#hashAcquireMany', () => {
    it(
      'acquires available hash amounts and releases lacking amounts',
      async () => {
        await cache.setHashCache(key, id2, 4);
        const result = await cache.hashAcquireMany(
          key,
          [
            { key: id, desireAmount: 2 },
            { key: id2, desireAmount: 3, limitAmount: 5 },
          ],
          (acquiredResults) => acquiredResults,
        );
        expect(result).toEqual([
          { key: id, currentAmount: 2, acquiredAmount: 2, lackingAmount: 0 },
          { key: id2, currentAmount: 5, acquiredAmount: 1, lackingAmount: 2 },
        ]);
        expect(await cache.getHashCache(key, id)).toBe(2);
        expect(await cache.getHashCache(key, id2)).toBe(5);
      },
    );

    it('releases acquired hash amounts when callback fails', async () => {
      const fn = (): never => {
        throw new Error('failed');
      };
      await expect(
        cache.hashAcquireMany(
          key,
          [
            { key: id, desireAmount: 2 },
            { key: id2, desireAmount: 3 },
          ],
          fn,
        ),
      ).rejects.toThrow('failed');
      expect(await cache.getHashCache(key, id)).toBe(0);
      expect(await cache.getHashCache(key, id2)).toBe(0);
    });

    it('supports float hash limits', async () => {
      await cache.setHashCache(key, id2, 1.5);
      const result = await cache.hashAcquireMany(
        key,
        [{ key: id2, desireAmount: 1.25, limitAmount: 2 }],
        (acquiredResults) => acquiredResults,
        { float: true },
      );
      expect(result).toEqual([
        {
          key: id2,
          currentAmount: 2,
          acquiredAmount: 0.5,
          lackingAmount: 0.75,
        },
      ]);
      expect(await cache.getHashCache(key, id2)).toBe(2);
    });

    it('rejects non-finite float hash amounts before acquiring any fields', async () => {
      await cache.setHashCache(key, id, 4);

      await expect(
        cache.hashAcquireMany(
          key,
          [
            { key: id, desireAmount: 2 },
            { key: id2, desireAmount: Number.POSITIVE_INFINITY },
          ],
          (acquiredResults) => acquiredResults,
          { float: true },
        ),
      ).rejects.toThrow('Acquire amounts must be finite numbers');
      expect(await cache.getHashCache(key, id)).toBe(4);
      expect(await cache.getHashCache(key, id2)).toBeUndefined();
    });

    it(
      'does not partially acquire when one hash field cannot be incremented',
      async () => {
        await cache.setHashCache(key, id, 4);
        await redis.hset(key, id2, 'not-an-integer');

        await expect(
          cache.hashAcquireMany(
            key,
            [
              { key: id2, desireAmount: 1 },
              { key: id, desireAmount: 2 },
            ],
            (acquiredResults) => acquiredResults,
          ),
        ).rejects.toThrow('Failed to acquire requested amounts');
        expect(await cache.getHashCache(key, id)).toBe(4);
        expect(await redis.hget(key, id2)).toBe('not-an-integer');
      },
    );
  });

  afterAll(async () => {
    await redis.quit();
  });
});

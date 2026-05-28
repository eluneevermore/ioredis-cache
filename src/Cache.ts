import type Redis from 'ioredis';
import type { RedisKey } from 'ioredis';

// TODO: type this without narrowing the public parser contract.
interface Parser {
  parse: (text: string) => any;
  stringify: (value: any) => string;
}

interface CacheOptions {
  redis: Redis;
  parser?: Parser;
}

type Key = RedisKey | number;

type Mapping<T> = { [id: string]: T };

type ValueSource<K extends Key, T> = Mapping<T> | T[] | Map<K, T>;

type ValueMap<T> = Mapping<T | undefined>;

type Awaitable<T> = T | Promise<T>;

const NOT_FOUND_VALUE = undefined;

type CacheReturn<T> = T | typeof NOT_FOUND_VALUE;

const SET_PARAM_SIZE = 2;
const INVALID_REDIS_INSTANCE_MESSAGE = 'Cache requires an ioredis instance';

const REQUIRED_REDIS_COMMANDS = [
  'set',
  'get',
  'setex',
  'mget',
  'pipeline',
  'del',
  'hset',
  'get',
  'hdel',
];

const isRedis = (obj: unknown): obj is Redis => {
  if (obj === null || typeof obj !== 'object') {
    return false;
  }
  const redis = obj as Record<string, unknown>;
  return REQUIRED_REDIS_COMMANDS.every(
    (name) => typeof redis[name] === 'function',
  );
};

class Cache {
  redis: Redis;
  protected prefix: string;
  protected parser: Parser = JSON;

  constructor(options: Redis | CacheOptions) {
    const config = (
      isRedis(options) ? { redis: options } : options
    ) as CacheOptions;

    if (!isRedis(config.redis)) {
      throw new TypeError(INVALID_REDIS_INSTANCE_MESSAGE);
    }

    this.redis = config.redis;
    this.prefix = this.redis.options.keyPrefix || '';
    if (config.parser !== undefined) {
      this.parser = config.parser;
    }
  }

  static bindAll(target: Cache): Cache {
    const targetMethods = target as unknown as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(Cache.prototype)) {
      if (name === 'constructor') {
        continue;
      }
      const method = targetMethods[name];
      if (typeof method === 'function') {
        targetMethods[name] = method.bind(target);
      }
    }
    return target;
  }

  async cache<T>(key: Key, fn: () => Awaitable<T>, ttl?: number): Promise<T> {
    let value = await this.getCache<T>(key);
    if (value !== NOT_FOUND_VALUE) {
      return value;
    }
    value = await fn();
    if (value !== NOT_FOUND_VALUE) {
      await this.setCache(key, value, ttl);
    }
    return value;
  }

  async getCache<T>(key: Key): Promise<CacheReturn<T>> {
    const data = await this.redis.get(key as RedisKey);
    return data === null ? NOT_FOUND_VALUE : this.parser.parse(data);
  }

  async setCache(key: Key, value: any, ttl?: number) {
    const data = this.parser.stringify(value);
    return ttl !== undefined
      ? this.redis.setex(key as RedisKey, ttl, data)
      : this.redis.set(key as RedisKey, data);
  }

  async manyCache<K extends Key, T>(
    keys: K[],
    fn: (keys: K[]) => Awaitable<ValueSource<K, T>>,
    prefix: Key = '',
    ttl?: number,
  ): Promise<T[]> {
    const fullKeys = keys.map((key) => `${prefix}${key}`);
    const cachedValues = await this.getManyCache<T>(fullKeys);
    const uncachedKeys = this._getUncachedKeys(keys, cachedValues);

    if (uncachedKeys.length) {
      const uncachedValues = await fn(uncachedKeys);
      const uncachedValueMap = this._buildValueMap(
        uncachedKeys,
        uncachedValues,
      );
      const fullKeyUncachedValueMap = this._prefixValueMap(
        uncachedValueMap,
        prefix,
      );
      await this.setManyCache(fullKeyUncachedValueMap, ttl);

      return this._mergeCacheValues(cachedValues, keys, uncachedValueMap);
    }
    return cachedValues as T[];
  }

  async getManyCache<T = any>(keys: Key[]): Promise<CacheReturn<T>[]> {
    if (keys.length <= 0) {
      return [];
    }
    const data = await this.redis.mget(keys as RedisKey[]);
    return data.map((e: string | null) =>
      e === null ? NOT_FOUND_VALUE : this.parser.parse(e),
    );
  }

  async setManyCache(valueMap: { [id: string]: any }, ttl?: number) {
    const params = this._buildSetParams(valueMap);
    if (params.length <= 0) {
      return [];
    }
    if (ttl === undefined) {
      return this.redis.mset(params);
    }
    const pipeline = this.redis.pipeline();
    pipeline.mset(params);
    for (let i = 0; i < params.length; i += SET_PARAM_SIZE) {
      const key = params[i];
      pipeline.expire(key, ttl);
    }
    return pipeline.exec();
  }

  async deleteCache(...keys: Key[]): Promise<number> {
    return this.redis.del(...(keys as RedisKey[]));
  }

  async deletePattern(pattern: string, batch: number = 100): Promise<void> {
    const jobs: any[] = [];
    const length = this.prefix.length;
    let pipeline = this.redis.pipeline();
    for await (const keys of this.redis.scanStream({
      match: `${this.prefix}${pattern}`,
      count: batch,
    })) {
      for (const key of keys) {
        pipeline.del(key.substring(length));
      }
      if (pipeline.length >= batch) {
        jobs.push(pipeline.exec());
        pipeline = this.redis.pipeline();
      }
    }
    jobs.push(pipeline.exec());
    await Promise.all(jobs);
  }

  async hashCache<T>(key: Key, id: Key, fn: () => Awaitable<T>): Promise<T> {
    let value = await this.getHashCache<T>(key, id);
    if (value !== NOT_FOUND_VALUE) {
      return value;
    }
    value = await fn();
    if (value !== NOT_FOUND_VALUE) {
      await this.setHashCache(key, id, value);
    }
    return value;
  }

  async getHashCache<T>(key: Key, id: Key): Promise<CacheReturn<T>> {
    const data = await this.redis.hget(key as RedisKey, id as RedisKey);
    return data === null ? NOT_FOUND_VALUE : this.parser.parse(data);
  }

  async setHashCache(key: Key, id: Key, value: any) {
    const data = this.parser.stringify(value);
    return this.redis.hset(key as RedisKey, id, data);
  }

  async hashManyCache<K extends Key, T>(
    key: Key,
    ids: K[],
    fn: (ids: K[]) => Awaitable<ValueSource<K, T>>,
  ): Promise<T[]> {
    const cachedValues = await this.getHashManyCache<T>(key, ids);
    const uncachedIds = this._getUncachedKeys(ids, cachedValues);

    if (uncachedIds.length) {
      const uncachedValues = await fn(uncachedIds);
      const uncachedValueMap = this._buildValueMap(uncachedIds, uncachedValues);
      await this.setHashManyCache(key, uncachedValueMap);
      return this._mergeCacheValues(cachedValues, ids, uncachedValueMap);
    }
    return cachedValues as T[];
  }

  async getHashManyCache<T>(key: Key, ids: Key[]): Promise<CacheReturn<T>[]> {
    if (ids.length <= 0) {
      return [];
    }
    const data = await this.redis.hmget(
      key as RedisKey,
      ...(ids as RedisKey[]),
    );
    return data.map((e: string | null) =>
      e === null ? NOT_FOUND_VALUE : this.parser.parse(e),
    );
  }

  async setHashManyCache(key: Key, valueMap: { [id: string]: any }) {
    const params = this._buildSetParams(valueMap);
    if (params.length <= 0) {
      return [];
    }
    return this.redis.hmset(key as RedisKey, params);
  }

  async deleteHashCache(key: Key, ...ids: Key[]): Promise<number> {
    return this.redis.hdel(key as RedisKey, ...(ids as RedisKey[]));
  }

  async acquire<T>(
    key: Key,
    amount: number,
    fn: (current: number) => Awaitable<T>,
    float: boolean = false,
  ): Promise<T> {
    const change = (float ? this.redis.incrbyfloat : this.redis.incrby) as (
      key: Key,
      amount: number,
    ) => Promise<number>;
    const parser: (value: any) => number = float ? parseFloat : parseInt;
    try {
      const current = await change.call(this.redis, key, amount);
      const result = await fn(parser(current));
      return result;
    } catch (error) {
      await change.call(this.redis, key, -amount);
      throw error;
    }
  }

  async hashAcquire<T>(
    key: Key,
    id: Key,
    amount: number,
    fn: (current: number) => Awaitable<T>,
    float: boolean = false,
  ): Promise<T> {
    const change = (float ? this.redis.hincrbyfloat : this.redis.hincrby) as (
      key: Key,
      id: Key,
      amount: string | number,
    ) => Promise<string>;
    const parser: (value: any) => number = float ? parseFloat : parseInt;
    try {
      const current = await change.call(this.redis, key, id, amount);
      const result = await fn(parser(current));
      return result;
    } catch (error) {
      await change.call(this.redis, key, id, -amount);
      throw error;
    }
  }

  protected _getUncachedKeys<K extends Key, T>(
    keys: K[],
    cachedValues: CacheReturn<T>[],
  ): K[] {
    return keys.filter((_, index) => cachedValues[index] === NOT_FOUND_VALUE);
  }

  protected _mergeCacheValues<K extends Key, T>(
    cachedValues: CacheReturn<T>[],
    keys: K[],
    uncachedValueMap: ValueMap<T>,
  ): T[] {
    return cachedValues.map((value, index) => {
      if (value !== NOT_FOUND_VALUE) {
        return value as T;
      }
      return uncachedValueMap[String(keys[index])] as T;
    });
  }

  protected _prefixValueMap<T>(
    valueMap: ValueMap<T>,
    prefix: Key,
  ): ValueMap<T> {
    const prefixedMap: ValueMap<T> = {};
    for (const [key, value] of Object.entries(valueMap)) {
      prefixedMap[`${prefix}${key}`] = value;
    }
    return prefixedMap;
  }

  protected _buildSetParams = (valueMap: { [id: string]: any }): string[] => {
    const params: string[] = [];
    for (const [key, value] of Object.entries(valueMap)) {
      if (value === NOT_FOUND_VALUE) {
        continue;
      }
      params.push(key, this.parser.stringify(value));
    }
    return params;
  };

  protected _buildValueMap<K extends Key, T>(
    ids: K[],
    valueMap: ValueSource<K, T>,
  ): ValueMap<T> {
    if (Array.isArray(valueMap)) {
      return ids.reduce<ValueMap<T>>((cacheMap, id, index) => {
        cacheMap[String(id)] = valueMap[index];
        return cacheMap;
      }, {});
    }

    if (valueMap instanceof Map) {
      return ids.reduce<ValueMap<T>>((cacheMap, id) => {
        cacheMap[String(id)] = valueMap.get(id);
        return cacheMap;
      }, {});
    }

    return valueMap;
  }
}

export default Cache;

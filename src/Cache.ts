import type Redis from 'ioredis';
import type { RedisKey } from 'ioredis';
import { Acquire } from './Acquire';
import type {
  AcquiredResult,
  AcquireDesire,
  AcquireOptions,
} from './Acquire';

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

/**
 * Type guard that checks if an object is an ioredis instance by verifying the
 * presence of required Redis commands (set, get, setex, mget, pipeline, del,
 * hset, hdel) as functions on the object.
 */
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
  private readonly acquireHelper: Acquire;
  protected prefix: string;
  protected parser: Parser = JSON;

  /**
   * @param options - Either an ioredis instance directly or a CacheOptions object
   *   with a `redis` property and optional `parser`. Throws if the redis instance
   *   doesn't satisfy the ioredis interface check.
   */
  constructor(options: Redis | CacheOptions) {
    const config = (
      isRedis(options) ? { redis: options } : options
    ) as CacheOptions;

    if (!isRedis(config.redis)) {
      throw new TypeError(INVALID_REDIS_INSTANCE_MESSAGE);
    }

    this.redis = config.redis;
    this.acquireHelper = new Acquire(this.redis);
    this.prefix = this.redis.options.keyPrefix || '';
    if (config.parser !== undefined) {
      this.parser = config.parser;
    }
  }

  /**
   * Binds all prototype methods of Cache to a target instance so they can be
   * destructured and called without losing the `this` context.
   *
   * @returns The same target instance after binding.
   */
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

  /**
   * Read-through cache for a single key. Checks the cache first; if the value
   * is missing, calls `fn` to produce it, stores the result, and returns it.
   *
   * @param key - Cache key to look up.
   * @param fn - Factory function invoked on cache miss.
   * @param ttl - Optional TTL in seconds. If omitted the value is stored
   *   without expiry.
   */
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

  /**
   * Retrieves a single cached value by key. Returns `undefined` when the key
   * is not found (the `NOT_FOUND_VALUE` sentinel), making it safe to
   * distinguish a cache miss from a stored value.
   */
  async getCache<T>(key: Key): Promise<CacheReturn<T>> {
    const data = await this.redis.get(key as RedisKey);
    return data === null ? NOT_FOUND_VALUE : this.parser.parse(data);
  }

  /**
   * Stores a single value in the cache. The value is serialized through the
   * configured parser (default: JSON).
   *
   * @param ttl - Optional TTL in seconds. Uses `SETEX` when provided, plain
   *   `SET` otherwise.
   */
  async setCache(key: Key, value: any, ttl?: number) {
    const data = this.parser.stringify(value);
    return ttl !== undefined
      ? this.redis.setex(key as RedisKey, ttl, data)
      : this.redis.set(key as RedisKey, data);
  }

  /**
   * Read-through cache for multiple keys in a single batch. Executes a single
   * `MGET` for all keys, then calls `fn` for any missing keys and stores the
   * result via `MSET` (or pipelined `SETEX` when TTL is provided).
   *
   * @param keys - List of logical keys to fetch.
   * @param fn - Factory invoked with the subset of keys that were not cached.
   *   Must return values in the same order as the supplied keys.
   * @param prefix - Optional string (or number) prepended to every key before
   *   interacting with Redis. The prefix is stripped from cached results.
   * @param ttl - Optional TTL in seconds for newly stored values.
   */
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

  /**
   * Retrieves multiple cached values by their keys using `MGET`. Returns an
   * array aligned with the input keys where missing entries are `undefined`
   * (the `NOT_FOUND_VALUE` sentinel).
   */
  async getManyCache<T = any>(keys: Key[]): Promise<CacheReturn<T>[]> {
    if (keys.length <= 0) {
      return [];
    }
    const data = await this.redis.mget(keys as RedisKey[]);
    return data.map((e: string | null) =>
      e === null ? NOT_FOUND_VALUE : this.parser.parse(e),
    );
  }

  /**
   * Stores multiple key-value pairs atomically. Uses `MSET` when no TTL is
   * given; otherwise uses a pipeline of `MSET` + per-key `EXPIRE` commands.
   *
   * @param valueMap - A plain object mapping string keys to serialisable values.
   * @param ttl - Optional TTL in seconds applied to every key in the batch.
   */
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

  /**
   * Deletes one or more keys from the cache.
   *
   * @returns The number of keys that were actually removed.
   */
  async deleteCache(...keys: Key[]): Promise<number> {
    return this.redis.del(...(keys as RedisKey[]));
  }

  /**
   * Deletes all keys matching a glob pattern by iterating with `SCAN` in
   * batches. The `keyPrefix` configured on the ioredis instance is
   * automatically prepended to the pattern so callers don't need to include it.
   *
   * @param pattern - Redis glob pattern (e.g. `user:*`).
   * @param batch - Number of keys to scan and delete per pipeline (default 100).
   */
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

  /**
   * Read-through cache for a single field inside a Redis hash. Checks the hash
   * first; on miss calls `fn`, stores the result, and returns it.
   *
   * @param key - The Redis hash key.
   * @param id - The field name within the hash.
   * @param fn - Factory function invoked on cache miss.
   */
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

  /**
   * Retrieves a single field from a Redis hash. Returns `undefined` (the
   * `NOT_FOUND_VALUE` sentinel) when the field does not exist.
   */
  async getHashCache<T>(key: Key, id: Key): Promise<CacheReturn<T>> {
    const data = await this.redis.hget(key as RedisKey, id as RedisKey);
    return data === null ? NOT_FOUND_VALUE : this.parser.parse(data);
  }

  /**
   * Stores a single field in a Redis hash. The value is serialised through the
   * configured parser.
   */
  async setHashCache(key: Key, id: Key, value: any) {
    const data = this.parser.stringify(value);
    return this.redis.hset(key as RedisKey, id, data);
  }

  /**
   * Read-through cache for multiple fields within a single Redis hash. Issues
   * a single `HMGET`, calls `fn` for any missing fields, persists them with
   * `HMSET`, and returns the merged result aligned with the input `ids`.
   *
   * @param key - The Redis hash key.
   * @param ids - Field names to fetch.
   * @param fn - Factory invoked with the subset of field names that are not
   *   cached. Must return values in the same order.
   */
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

  /**
   * Retrieves multiple fields from a Redis hash using `HMGET`. Returns an
   * array aligned with the input `ids` where missing fields are `undefined`
   * (the `NOT_FOUND_VALUE` sentinel).
   */
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

  /**
   * Stores multiple fields in a Redis hash atomically using `HMSET`.
   *
   * @param key - The Redis hash key.
   * @param valueMap - A plain object mapping field names to serialisable values.
   */
  async setHashManyCache(key: Key, valueMap: { [id: string]: any }) {
    const params = this._buildSetParams(valueMap);
    if (params.length <= 0) {
      return [];
    }
    return this.redis.hmset(key as RedisKey, params);
  }

  /**
   * Deletes one or more fields from a Redis hash.
   *
   * @returns The number of fields that were actually removed.
   */
  async deleteHashCache(key: Key, ...ids: Key[]): Promise<number> {
    return this.redis.hdel(key as RedisKey, ...(ids as RedisKey[]));
  }

  /**
   * Atomically increments (or decrements) a Redis key and invokes `fn` with
   * the updated value. On failure the increment is automatically rolled back.
   *
   * @param key - Redis key holding the counter.
   * @param amount - Amount to add (use a negative number to decrement).
   * @param fn - Callback receiving the new counter value.
   * @param float - When `true` uses `INCRBYFLOAT` instead of `INCRBY`.
   */
  async acquire<T>(
    key: Key,
    amount: number,
    fn: (current: number) => Awaitable<T>,
    float: boolean = false,
  ): Promise<T> {
    return this.acquireHelper.acquire(key, amount, fn, float);
  }

  /**
   * Atomically increments (or decrements) a field inside a Redis hash and
   * invokes `fn` with the updated value.
   *
   * @param key - The Redis hash key.
   * @param id - The field name within the hash.
   * @param amount - Amount to add.
   * @param fn - Callback receiving the new counter value.
   * @param float - When `true` uses `HINCRBYFLOAT` instead of `HINCRBY`.
   */
  async hashAcquire<T>(
    key: Key,
    id: Key,
    amount: number,
    fn: (current: number) => Awaitable<T>,
    float: boolean = false,
  ): Promise<T> {
    return this.acquireHelper.hashAcquire(key, id, amount, fn, float);
  }

  /**
   * Atomically modifies multiple counters in a single Redis pipeline execution.
   * Each desired change is specified as an `AcquireDesire` item; `fn` receives
   * the final values.
   */
  async acquireMany<K extends string | number, T>(
    items: AcquireDesire<K>[],
    fn: (acquireResult: AcquiredResult<K>[]) => Awaitable<T>,
    options?: AcquireOptions,
  ): Promise<T> {
    return this.acquireHelper.acquireMany(items, fn, options);
  }

  /**
   * Atomically modifies multiple fields inside a single Redis hash counter
   * via a Redis pipeline.
   *
   * @param hashKey - The Redis hash key containing the counters.
   * @param items - Desired changes for each field.
   * @param fn - Callback receiving the array of results.
   */
  async hashAcquireMany<K extends string | number, T>(
    hashKey: string,
    items: AcquireDesire<K>[],
    fn: (acquireResult: AcquiredResult<K>[]) => Awaitable<T>,
    options?: AcquireOptions,
  ): Promise<T> {
    return this.acquireHelper.hashAcquireMany(hashKey, items, fn, options);
  }

  /**
   * Filters the input `keys` down to those whose corresponding entry in
   * `cachedValues` is `NOT_FOUND_VALUE`.
   */
  protected _getUncachedKeys<K extends Key, T>(
    keys: K[],
    cachedValues: CacheReturn<T>[],
  ): K[] {
    return keys.filter((_, index) => cachedValues[index] === NOT_FOUND_VALUE);
  }

  /**
   * Merges a set of cached values with a map of uncached values. Where a
   * cached entry is `NOT_FOUND_VALUE`, the corresponding value is looked up
   * from `uncachedValueMap` by key.
   */
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

  /**
   * Returns a new map with every key prefixed by `prefix`. Used internally
   * by `manyCache` to apply the configured prefix before storing.
   */
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

  /**
   * Converts a value map into a flat array of `[key, stringifiedValue, key,
   * stringifiedValue, ...]` suitable for `MSET` / `HMSET`. Entries whose
   * value is `NOT_FOUND_VALUE` are skipped.
   */
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

  /**
   * Normalises a `ValueSource` (array, `Map`, or plain object) into a uniform
   * `ValueMap` keyed by the string representation of each id. Array and `Map`
   * sources are aligned with `ids` by position.
   */
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

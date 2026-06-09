# ioredis-cache

Compact redis cache using [ioredis](https://github.com/luin/ioredis).

## Features

- Store/retrieve/expire cache
- Compatible with redis `incr`, `hincrby`,...
- Cache multiple objects at once
- Delete caches by key pattern
- Take advantage of the redis hash map for memory efficiency

## Installation

```
  npm install ioredis-cache ioredis
```

```
  yarn add ioredis-cache ioredis
```

## Usage

```javascript
  const Redis = require("ioredis")
  const Cache = require("ioredis-cache")
  const cache = new Cache(new Redis())

  const value = await cache.cache("key", async () => ({ foo: "bar" }))
```

## APIs

[#constructor](#constructor)

[#cache](#cache)

[#getCache](#getcache)

[#setCache](#setcache)

[#manyCache](#manycache)

[#getManyCache](#getmanycache)

[#setManyCache](#setmanycache)

[#deleteCache](#deletecache)

[#deletePattern](#deletepattern)

[#acquire](#acquire)

[#acquireMany](#acquiremany)

[#hashCache](#hashcache)

[#getHashCache](#gethashcache)

[#setHashCache](#sethashcache)

[#hashManyCache](#hashmanycache)

[#getHashManyCache](#gethashmanycache)

[#setHashManyCache](#sethashmanycache)

[#deleteHashCache](#deletehashcache)

[#hashAcquire](#hashacquire)

[#hashAcquireMany](#hashacquiremany)


### `#constructor`
`constructor(args: Redis | CacheOptions)`

Initialize the cache with an existing ioredis instance.

```typescript
import type {
  AcquiredResult,
  AcquireDesire,
  AcquireHelper,
  AcquireOptions,
} from 'ioredis-cache'

interface CacheOptions {
  redis: Redis
  parser: Parser
  acquire?: AcquireHelper
  acquireType?: "lua" | "pipeline"
}

interface AcquireHelper {
  acquire(key, amount, fn, options?)
  hashAcquire(key, id, amount, fn, options?)
  acquireMany(items, fn, options?)
  hashAcquireMany(hashKey, items, fn, options?)
}

interface Parser { // Parse/unparse object when store in redis. Default is JSON
  parse: (text: string) => any
  stringify: (value: any) => string
}
```

`acquireType` controls the implementation used by `acquire`, `hashAcquire`,
`acquireMany`, and `hashAcquireMany`. It defaults to `"lua"` for atomic
multi-acquire behavior. Use `"pipeline"` to use the non-Lua pipeline
implementation. Pass `acquire` to provide a custom helper object; it takes
precedence over `acquireType`.

### `#cache`
`cache(key: string, callback: async (key: string) => any, ttl?: number): Promise<any>`

Get the cached value of the key from redis. If the key does not exist, get the value from the callback, store it in redis and return the value.

If the callback return `undefined`, it will not be cached. `null` is cached normally.

If `ttl` is set, the key will expire after `ttl` second(s).

```javascript
const getPost = (id) =>
  cache(`post-${id}`, () => db.Post.getPostWithId(id), 60 * 60)
```

### `#getCache`
`getCache(key: string): Promise<any>`

Get the cached value of the key from redis. If the key does not exist, return `undefined`.

### `#setCache`
`setCache(key: string, value: any, ttl?: number)`

Store the value to the cache key.

If `ttl` is set, the key will expire after `ttl` second(s).

### `#manyCache`
`manyCache(keys: string[], callback: async (ids: string[]) => { [id: string]: any } | any[], prefix?: string, ttl?: number)`

Get cached values for a list of keys from redis. The uncached keys will be passed to the callback to get the corresponding values. These values will be stored in redis. Returns combined array of both cached and uncached values.

If `prefix` is set, it will be preend to the key when get/set in redis. (The keys which are passed to the callback still don't have the `prefix`)

This is useful if some cached ids were invalidated, you can recache multiple values at once. For example:

```javascript
// invalidate cache of the changed post
db.Post.onChange(post => cache.deleteCache(`post-${post.id}`))
// this function queries all posts that are uncached at once
const getPosts = (ids) =>
  manyCache(ids, async (uncachedIds) => {
    const posts = await db.Post.queryAllPostsWithIds(uncachedIds)
    return posts.reduce((map, post) => Object.assign(map, { [post.id]: post }), {})
  }, prefix: 'post-', 60 * 60)
```

### `#getManyCache`
`getManyCache(keys: string[]): Promise<any[]>`

Return cached values for a list of keys from redis. If a key does not exist, the value will be `undefined`.

### `#setManyCache`
`setManyCache(keys: string[], ttl?: number)`

Store the values with the corresponding keys in redis.

If `ttl` is set, the keys will expire after `ttl` second(s).

### `#deleteCache`
`deleteCache(...keys: string[]): Promise<number>`

Delete the cached keys from redis and return the deleted number

### `#deletePattern`
`deletePattern(pattern: string, batch: number = 100)`

Scan all keys and delete the keys that matched the pattern:

```javascript
deletePattern('post:*')
```
Remove all cached keys start with `"post:*"`.

### `#acquire`
`acquire(key: string, amount: number, fn: (current: number, acquired: number, lacking: number) => any, options?: AcquireOptions)`

Increase the value of `key` by `amount` and pass the current, acquired, and
lacking amounts to `fn`. If `fn` raises any exception, decrease the value of
the `key` by the acquired amount.

By default, `amount` is treated as an integer. Set `options.float = true` or
pass `true` as the fourth argument if `amount` is a float. Set `options.limit`
to cap the final counter value.

`limit` is intended for positive acquire amounts. Negative amounts decrement
the counter, but `limit` does not provide a lower bound for decrements.

### `#acquireMany`
`acquireMany(items: AcquireDesire[], fn: (results: AcquiredResult[]) => any, options?: AcquireOptions)`

Increase multiple keys with `INCRBY` and pass the acquired result list to `fn`.
Set `options.float = true` to use `INCRBYFLOAT`. If an item has `limitAmount`,
any amount above the limit is released before `fn` runs. If `fn` raises an
exception, all acquired amounts are released.

`limitAmount` is intended for positive `desireAmount` values. Negative
`desireAmount` values decrement counters, but `limitAmount` does not provide a
lower bound for decrements.

```typescript
type AcquireDesire = {
  key: string | number
  desireAmount: number
  limitAmount?: number
}

type AcquiredResult = {
  key: string | number
  currentAmount: number
  acquiredAmount: number
  lackingAmount: number
}

type AcquireOptions = {
  prefix?: string
  float?: boolean
  limit?: number
}
```

### `#hashCache`
`hashCache(key: string, id: string, callback: () => any): Promise<any>`

Get the cached id of the key from redis. If the id or key does not exist, get the value from the callback, store it in redis and return the value.

This function is similar to `#cache`, but stores value in redis hash for better memory effeciency. You can remove the hash by simply deleting the cache key. This is better than using `#deletePattern` if there are a lot of keys to be deleted. The only downside is you can't set the `ttl` for each id but only for the hash.

### `#getHashCache`
`getHashCache(key: string, id: string): Promise<any>`

Return the cached id of the key from redis. If the id / key does not exist, return `undefined`.

### `#setHashCache`
`setHashCache(key: string, value: any)`

Store the value to the id of key

### `#hashManyCache`
`hashManyCache(key: string, ids: string[], callback: (ids: string[]) => { [id: string]: any } | any[]): Promise<any[]>`

Get cached values for the id array of the key from redis. The uncached ids will be passed to the callback to get the corresponding values. These values will be stored in redis. Returns a combined array of both cached and uncached values.

It is similar to `#manyCache`, but use redis hash to store data.

```javascript
// invalidate cache of the changed post
db.Post.onChange(post => cache.deleteHashCache('post', post.id))
// this function queries all posts that are uncached at once
const getPosts = (ids) =>
  hashManyCache('post', ids, async (uncachedIds) => {
    const posts = await db.Post.queryAllPostsWithIds(uncachedIds)
    return posts.reduce((map, post) => Object.assign(map, { [post.id]: post }), {})
  })
```

### `#getHashManyCache`
`getHashManyCache(key: string, ids: string[]): Promise<any[]>`

Return cached values for the id array of the key from redis. If the id / key does not exist, the value will be `undefined`.

### `#setHashManyCache`
`setHashManyCache(key: string, valueMap: { [id: string]: any })`

Store the values with the corresponding ids of the key in redis

### `#deleteHashCache`
`deleteHashCache(key: string, ...ids: string[]): Promise<number>`

Delete the cached ids of the key from redis and return the deleted number

### `#hashAcquire`
`hashAcquire(key: string, id: string, amount: number, fn: (current: number, acquired: number, lacking: number) => any, options?: AcquireOptions)`

Increase the value of `id` in `key` by `amount` and pass the current,
acquired, and lacking amounts to `fn`. If `fn` raises any exception, decrease
the value of `id` in `key` by the acquired amount.

By default, `amount` is treated as an integer. Set `options.float = true` or
pass `true` as the fourth argument if `amount` is a float. Set `options.limit`
to cap the final field value.

`limit` is intended for positive acquire amounts. Negative amounts decrement
the field, but `limit` does not provide a lower bound for decrements.

### `#hashAcquireMany`
`hashAcquireMany(key: string, items: AcquireDesire[], fn: (results: AcquiredResult[]) => any, options?: AcquireOptions)`

Hash-based equivalent of `#acquireMany`. It increases multiple fields under one
Redis hash key with `HINCRBY`, or `HINCRBYFLOAT` when `options.float = true`.
`limitAmount` is intended for positive `desireAmount` values. Negative
`desireAmount` values decrement fields, but `limitAmount` does not provide a
lower bound for decrements.

## Run tests

Make sure the redis is running at `localhost:6379`

Run the following command:

```
yarn test
```

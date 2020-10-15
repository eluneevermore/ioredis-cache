# ioredis-cache

Compact redis cache using [ioredis](https://github.com/luin/ioredis).

## Features

- Store/retrieve/expire cache
- Compatible with redis `incr`, `hincrby`,...
- Cache multiple objects at once
- Delete caches by key pattern
- Take advantage of redis hash map for memory efficiency

## Installation

```
  npm install ioredis-cache
```

```
  yarn add ioredis-cache
```

## Usage

```javascript
  const Redis = require("ioredis")
  const Cache = require("ioredis-cache")
  const cache = new Cache(new Redis())

  const value = await cache.cache("key", async () => ({ foo: "bar" }))
```

## Notes

Depends on your cases, you may want to disconnect redis after using:
```
cache.redis.quit()
```

## APIs

### `#constructor(args: Redis | CacheOptions)`

You can initialize the cache from ioredis object or with options.

```typescript
interface CacheOptions {
  redis: object | Redis
  parser: Parser
}

interface Parser { // Parse/unparse object when store in redis. Default is JSON
  parse: (text: string) => any
  stringify: (value: any) => string
}
```

### `#cache(key: string, callback: async (key: string) => any, ttl?: number): Promise<any>`

Get the cached value of the key from redis. If the key does not exist, get the value from the callback, store it in redis and return the value.

If the callback return `undefined`, it will not be cached. `null` is cached normally.

If `ttl` is set, the key will expire after `ttl` second(s).

```javascript
const getPost = (id) =>
  cache(`post-${id}`, () => db.Post.getPostWithId(id), 60 * 60)
```

### `#getCache(key: string): Promise<any>`

Get the cached value of the key from redis. If the key does not exist, return `undefined`.

### `#setCache(key: string, value: any, ttl?: number)`

Store the value to the cache key.

If `ttl` is set, the key will expire after `ttl` second(s).

### `#manyCache(keys: string[], callback: async (ids: string[]) => { [id: string]: any }, prefix?: string, ttl?: number)`

Get cached values of a list of keys from redis. The uncached keys will be passed to the callback to get the corresponding values. These values will be stored in redis. Returns combined array of both cached and uncached values.

If `prefix` is set, it will be preend to the key when get/set in redis. (The keys which are passed to the callback still don't have the `prefix`)

This is useful if some cached ids were invalidated, you can recache multiple values at once. For example:

```javascript
// invalidate cache of the changed post
db.Post.onChange(post => cache.deleteCache(`post-${post.id}`))
// this function query all posts that are uncached at once
const getPosts = (ids) =>
  manyCache(ids, async (uncachedIds) => {
    const posts = await db.Post.queryAllPostsWithIds(uncachedIds)
    return posts.reduce((map, post) => Object.assign(map, { [post.id]: post }), {})
  }, prefix: 'post-', 60 * 60)
```

### `getManyCache(keys: string[]): Promise<any[]>`

Return cached values of a list of keys from redis. If a key does not exist, the value will be `undefined`.

### `#setManyCache(keys: string[], ttl?: number)`

Store the values with the corresponding keys in redis.

If `ttl` is set, the keys will expire after `ttl` second(s).

### `#deleteCache(...keys: string[]): Promise<number>`

Delete the cached keys from redis and return the deleted number

### `#deletePattern(pattern: string, batch: number = 100)`

Scan all keys and delete the keys that matched the pattern:

```javascript
deletePattern('post:*')
```
Will remove all cached keys start with `"post:*"`.

### `#hashCache(key: string, id: string, callback: () => any): Promise<any>`

Get the cached id of the key from redis. If the id or key does not exist, get the value from the callback, store it in redis and return the value.

This function is similar to `#cache`, but stores value in redis hash for better memory effeciency. You can remove the hash by simply deleting the cache key. This is better than using `#deletePattern` if there are a lot of keys to be deleted. The only downside is you can't set the `ttl` for each id but only for the hash.

### `#getHashCache(key: string, id: string): Promise<any>`

Return the cached id of the key from redis. If the id / key does not exist, return `undefined`.

### `#setHashCache(key: string, value: any)`

Store the value to the id of key

### `hashManyCache(key: string, ids: string[], callback: (ids: string[]) => { [id: string]: any }): Promise<any[]>`

Get cached values of the id array of the key from redis. The uncached ids will be passed to the callback to get the corresponding values. These values will be stored in redis. Returns combined array of both cached and uncached values.

It is similar to `#manyCache`, but use redis hash to store data.

```javascript
// invalidate cache of the changed post
db.Post.onChange(post => cache.deleteHashCache('post', post.id))
// this function query all posts that are uncached at once
const getPosts = (ids) =>
  hashManyCache('post', ids, async (uncachedIds) => {
    const posts = await db.Post.queryAllPostsWithIds(uncachedIds)
    return posts.reduce((map, post) => Object.assign(map, { [post.id]: post }), {})
  })
```

### `getHashManyCache(key: string, ids: string[]): Promise<any[]>`

Return cached values of the id array of the key from redis. If the id / key does not exist, the value will be `undefined`.

### `setHashManyCache(key: string, valueMap: { [id: string]: any })`

Store the values with the corresponding ids of the key in redis

### `deleteHashCache(key: string, ...ids: string[]): Promise<number>`

Delete the cached ids of the key from redis and return the deleted number

## Run tests

Make sure the redis is running at `localhost:6379`

Run the following command:

```
yarn test
```

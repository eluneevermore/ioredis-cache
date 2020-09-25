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

## API

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

### `#cache(key: string, callback: async () => any, ttl?: number): Promise<any>`

Get the cached value of the key from redis. If the key does not exist, get the value from the callback, store it in redis and return the value.

If the callback return `undefined`, it will not be cached. `null` is cached normally.

If `ttl` is set, the key will be expired after `ttl` second(s).

### `#getCache(key: string): Promise<any>`

Get the cached value of the key from redis. If the key does not exist, return `undefined`.

### `#setCache(key: string, value: any, ttl?: number)`

Store the value to the cache key.

If `ttl` is set, the key will be expired after `ttl` second(s).

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

This is useful if some ids were invalidated, you can recache multiple values at once. For example:

```javascript
// invalidate cache of the changed post
Post.onChange(post => cache.deleteHashCache('post', post.id))
// this function query all posts that are uncached at once
const getPosts = (ids) =>
  hashManyCache('post', ids, async (uncachedIds) => {
    const posts = await Post.queryAllPostsWithIds(uncachedIds)
    return posts.reduce((map, post) => {
      map[post.id] = post
      return post
    }, {})
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

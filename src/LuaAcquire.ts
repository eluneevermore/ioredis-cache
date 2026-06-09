import type Redis from "ioredis";
import type { RedisKey } from "ioredis";
import {
  AcquireFailedError,
  ReleaseFailedError,
} from "./Acquire";
import type {
  AcquiredResult,
  AcquireDesire,
  AcquireOptionsInput,
  AcquireOptions,
  ReleaseItem,
} from "./Acquire";

type Key = RedisKey | number;
type Awaitable<T> = T | Promise<T>;
type LuaValue = string | number;
type LuaRow = [LuaValue, LuaValue, LuaValue, LuaValue];
type NumericValue = string | number;
type LuaCommandArgument = string | number;

interface RedisWithLuaCommands extends Redis {
  ioredisCacheAcquireMany(
    ...args: LuaCommandArgument[]
  ): Promise<unknown>;
  ioredisCacheHashAcquireMany(
    ...args: LuaCommandArgument[]
  ): Promise<unknown>;
  ioredisCacheReleaseMany(
    ...args: LuaCommandArgument[]
  ): Promise<unknown>;
  ioredisCacheHashReleaseMany(
    ...args: LuaCommandArgument[]
  ): Promise<unknown>;
}

const DEFAULT_PREFIX = "";
const FLOAT_FLAG = "1";
const INTEGER_FLAG = "0";
const HAS_LIMIT = "1";
const NO_LIMIT = "0";
const ACQUIRE_MANY_COMMAND = "ioredisCacheAcquireMany";
const HASH_ACQUIRE_MANY_COMMAND = "ioredisCacheHashAcquireMany";
const RELEASE_MANY_COMMAND = "ioredisCacheReleaseMany";
const HASH_RELEASE_MANY_COMMAND = "ioredisCacheHashReleaseMany";
const ACQUIRE_FAILED_MESSAGE = "Failed to acquire requested amounts";
const RELEASE_FAILED_MESSAGE = "Failed to release acquired amounts";
const HASH_RELEASE_FAILED_MESSAGE = "Failed to release acquired hash amounts";
const RELEASE_AFTER_CALLBACK_FAILED_MESSAGE =
  "Failed to release acquired amounts after acquire callback failed";
const HASH_RELEASE_AFTER_CALLBACK_FAILED_MESSAGE =
  "Failed to release acquired hash amounts after acquire callback failed";
const INTEGER_RADIX = 10;
const NON_FINITE_AMOUNT_MESSAGE = "Acquire amounts must be finite numbers";

const ACQUIRE_MANY_SCRIPT = `
local isFloat = ARGV[1] == "1"
local offset = 2

for index = 1, #KEYS do
  local value = redis.call("GET", KEYS[index])
  local desire = ARGV[offset + 1]
  local hasLimit = ARGV[offset + 2] == "1"
  local limit = ARGV[offset + 3]

  if isFloat then
    if tonumber(desire) == nil then
      return redis.error_reply("ERR desire amount is not a valid float")
    end
  elseif string.match(desire, "^-?%d+$") == nil then
    return redis.error_reply("ERR desire amount is not an integer")
  end

  if hasLimit then
    if isFloat then
      if tonumber(limit) == nil then
        return redis.error_reply("ERR limit amount is not a valid float")
      end
    elseif string.match(limit, "^-?%d+$") == nil then
      return redis.error_reply("ERR limit amount is not an integer")
    end
  end

  if value ~= false then
    if isFloat then
      if tonumber(value) == nil then
        return redis.error_reply("ERR value is not a valid float")
      end
    elseif string.match(value, "^-?%d+$") == nil then
      return redis.error_reply("ERR value is not an integer or out of range")
    end
  end

  offset = offset + 4
end

local results = {}
offset = 2

for index = 1, #KEYS do
  local logicalKey = ARGV[offset]
  local desire = tonumber(ARGV[offset + 1])
  local hasLimit = ARGV[offset + 2] == "1"
  local limit = tonumber(ARGV[offset + 3])
  local current = tonumber(redis.call("GET", KEYS[index]) or "0")
  local acquired = desire
  local lacking = 0

  if hasLimit then
    local available = math.max(0, limit - current)
    acquired = math.min(desire, available)
    lacking = desire - acquired
  end

  if isFloat then
    redis.call("INCRBYFLOAT", KEYS[index], acquired)
  else
    redis.call("INCRBY", KEYS[index], acquired)
  end

  results[index] = {
    logicalKey,
    tostring(current + acquired),
    tostring(acquired),
    tostring(lacking)
  }
  offset = offset + 4
end

return results
`;

const HASH_ACQUIRE_MANY_SCRIPT = `
local isFloat = ARGV[1] == "1"
local offset = 2
local hashKey = KEYS[1]
local itemCount = tonumber(ARGV[offset])
offset = offset + 1

for index = 1, itemCount do
  local field = ARGV[offset]
  local desire = ARGV[offset + 1]
  local hasLimit = ARGV[offset + 2] == "1"
  local limit = ARGV[offset + 3]
  local value = redis.call("HGET", hashKey, field)

  if isFloat then
    if tonumber(desire) == nil then
      return redis.error_reply("ERR desire amount is not a valid float")
    end
  elseif string.match(desire, "^-?%d+$") == nil then
    return redis.error_reply("ERR desire amount is not an integer")
  end

  if hasLimit then
    if isFloat then
      if tonumber(limit) == nil then
        return redis.error_reply("ERR limit amount is not a valid float")
      end
    elseif string.match(limit, "^-?%d+$") == nil then
      return redis.error_reply("ERR limit amount is not an integer")
    end
  end

  if value ~= false then
    if isFloat then
      if tonumber(value) == nil then
        return redis.error_reply("ERR hash value is not a valid float")
      end
    elseif string.match(value, "^-?%d+$") == nil then
      return redis.error_reply("ERR hash value is not an integer or out of range")
    end
  end

  offset = offset + 4
end

local results = {}
offset = 3

for index = 1, itemCount do
  local field = ARGV[offset]
  local desire = tonumber(ARGV[offset + 1])
  local hasLimit = ARGV[offset + 2] == "1"
  local limit = tonumber(ARGV[offset + 3])
  local current = tonumber(redis.call("HGET", hashKey, field) or "0")
  local acquired = desire
  local lacking = 0

  if hasLimit then
    local available = math.max(0, limit - current)
    acquired = math.min(desire, available)
    lacking = desire - acquired
  end

  if isFloat then
    redis.call("HINCRBYFLOAT", hashKey, field, acquired)
  else
    redis.call("HINCRBY", hashKey, field, acquired)
  end

  results[index] = {
    field,
    tostring(current + acquired),
    tostring(acquired),
    tostring(lacking)
  }
  offset = offset + 4
end

return results
`;

const RELEASE_MANY_SCRIPT = `
local isFloat = ARGV[1] == "1"
local offset = 2

for index = 1, #KEYS do
  local amount = ARGV[offset + 1]
  if not isFloat and string.match(amount, "^-?%d+$") == nil then
    return redis.error_reply("ERR release amount is not an integer")
  end
  offset = offset + 2
end

offset = 2

for index = 1, #KEYS do
  local amount = tonumber(ARGV[offset + 1])
  if amount ~= 0 then
    if isFloat then
      redis.call("INCRBYFLOAT", KEYS[index], -amount)
    else
      redis.call("DECRBY", KEYS[index], amount)
    end
  end
  offset = offset + 2
end

return 1
`;

const HASH_RELEASE_MANY_SCRIPT = `
local isFloat = ARGV[1] == "1"
local hashKey = KEYS[1]
local itemCount = tonumber(ARGV[2])
local offset = 3

for index = 1, itemCount do
  local amount = ARGV[offset + 1]
  if not isFloat and string.match(amount, "^-?%d+$") == nil then
    return redis.error_reply("ERR release amount is not an integer")
  end
  offset = offset + 2
end

offset = 3

for index = 1, itemCount do
  local field = ARGV[offset]
  local amount = tonumber(ARGV[offset + 1])
  if amount ~= 0 then
    if isFloat then
      redis.call("HINCRBYFLOAT", hashKey, field, -amount)
    else
      redis.call("HINCRBY", hashKey, field, -amount)
    end
  end
  offset = offset + 2
end

return 1
`;

export class LuaAcquire {
  constructor(private readonly redis: Redis) {
    this.defineCommands();
  }

  async acquire<T>(
    key: Key,
    amount: number,
    fn: (
      currentAmount: number,
      acquiredAmount: number,
      lackingAmount: number,
    ) => Awaitable<T>,
    options?: AcquireOptionsInput,
  ): Promise<T> {
    const normalizedOptions = normalizeAcquireOptions(options);
    assertFiniteAmount(amount);
    assertFiniteLimit(normalizedOptions.limit);
    if (
      normalizedOptions.limit === undefined ||
      normalizedOptions.limit === null
    ) {
      return this.acquireSingle(key, amount, fn, normalizedOptions);
    }

    return this.acquireMany(
      [
        {
          key: String(key),
          desireAmount: amount,
          limitAmount: normalizedOptions.limit,
        },
      ],
      ([result]) =>
        fn(result.currentAmount, result.acquiredAmount, result.lackingAmount),
      normalizedOptions,
    );
  }

  async hashAcquire<T>(
    hashKey: Key,
    id: Key,
    amount: number,
    fn: (
      currentAmount: number,
      acquiredAmount: number,
      lackingAmount: number,
    ) => Awaitable<T>,
    options?: AcquireOptionsInput,
  ): Promise<T> {
    const normalizedOptions = normalizeAcquireOptions(options);
    assertFiniteAmount(amount);
    assertFiniteLimit(normalizedOptions.limit);
    if (
      normalizedOptions.limit === undefined ||
      normalizedOptions.limit === null
    ) {
      return this.hashAcquireSingle(hashKey, id, amount, fn, normalizedOptions);
    }

    return this.hashAcquireMany(
      String(hashKey),
      [
        {
          key: String(id),
          desireAmount: amount,
          limitAmount: normalizedOptions.limit,
        },
      ],
      ([result]) =>
        fn(result.currentAmount, result.acquiredAmount, result.lackingAmount),
      normalizedOptions,
    );
  }

  async acquireMany<K extends string | number, T>(
    items: AcquireDesire<K>[],
    fn: (acquireResult: AcquiredResult<K>[]) => Awaitable<T>,
    options?: AcquireOptions,
  ): Promise<T> {
    assertFiniteItems(items);
    if (!items.length) {
      return await fn([]);
    }

    const acquiredResults = await this.runAcquireManyScript(items, options);
    return this.runAcquireCallback(
      fn,
      acquiredResults,
      (releaseItems) => this.releaseMany(releaseItems, options),
      RELEASE_AFTER_CALLBACK_FAILED_MESSAGE,
    );
  }

  async hashAcquireMany<K extends string | number, T>(
    hashKey: string,
    items: AcquireDesire<K>[],
    fn: (acquireResult: AcquiredResult<K>[]) => Awaitable<T>,
    options?: AcquireOptions,
  ): Promise<T> {
    assertFiniteItems(items);
    if (!items.length) {
      return await fn([]);
    }

    const acquiredResults = await this.runHashAcquireManyScript(
      hashKey,
      items,
      options,
    );
    return this.runAcquireCallback(
      fn,
      acquiredResults,
      (releaseItems) => this.hashReleaseMany(hashKey, releaseItems, options),
      HASH_RELEASE_AFTER_CALLBACK_FAILED_MESSAGE,
    );
  }

  private async runAcquireManyScript<K extends string | number>(
    items: AcquireDesire<K>[],
    options?: AcquireOptions,
  ): Promise<AcquiredResult<K>[]> {
    const prefix = options?.prefix ?? DEFAULT_PREFIX;
    const keys = items.map((item) => `${prefix}${item.key}`);
    const args = this.buildAcquireArgs(items, options);

    try {
      const result = await this.luaRedis.ioredisCacheAcquireMany(
        keys.length,
        ...keys,
        ...args,
      );
      return this.parseAcquiredRows(items, result);
    } catch (error) {
      throw new AcquireFailedError(ACQUIRE_FAILED_MESSAGE, error);
    }
  }

  private async acquireSingle<T>(
    key: Key,
    amount: number,
    fn: (
      currentAmount: number,
      acquiredAmount: number,
      lackingAmount: number,
    ) => Awaitable<T>,
    options?: AcquireOptions,
  ): Promise<T> {
    const float = options?.float === true;
    const change = this.getChangeCommand(float);
    const parse = float ? parseFloatValue : parseIntegerValue;
    try {
      const currentAmount = parse(await change(key, amount));
      return await fn(currentAmount, amount, 0);
    } catch (error) {
      await change(key, -amount);
      throw error;
    }
  }

  private async hashAcquireSingle<T>(
    hashKey: Key,
    id: Key,
    amount: number,
    fn: (
      currentAmount: number,
      acquiredAmount: number,
      lackingAmount: number,
    ) => Awaitable<T>,
    options?: AcquireOptions,
  ): Promise<T> {
    const float = options?.float === true;
    const change = this.getHashChangeCommand(float);
    const parse = float ? parseFloatValue : parseIntegerValue;
    try {
      const currentAmount = parse(await change(hashKey, id, amount));
      return await fn(currentAmount, amount, 0);
    } catch (error) {
      await change(hashKey, id, -amount);
      throw error;
    }
  }

  private getChangeCommand(
    float: boolean,
  ): (key: Key, amount: number) => Promise<NumericValue> {
    if (float) {
      return (key, amount) => this.redis.incrbyfloat(key as RedisKey, amount);
    }
    return (key, amount) => this.redis.incrby(key as RedisKey, amount);
  }

  private getHashChangeCommand(
    float: boolean,
  ): (key: Key, id: Key, amount: number) => Promise<NumericValue> {
    if (float) {
      return (key, id, amount) =>
        this.redis.hincrbyfloat(key as RedisKey, id as string | Buffer, amount);
    }
    return (key, id, amount) =>
      this.redis.hincrby(key as RedisKey, id as string | Buffer, amount);
  }

  private async runHashAcquireManyScript<K extends string | number>(
    hashKey: string,
    items: AcquireDesire<K>[],
    options?: AcquireOptions,
  ): Promise<AcquiredResult<K>[]> {
    const redisKey = `${options?.prefix ?? DEFAULT_PREFIX}${hashKey}`;
    const args = this.buildHashAcquireArgs(items, options);

    try {
      const result = await this.luaRedis.ioredisCacheHashAcquireMany(
        redisKey,
        ...args,
      );
      return this.parseAcquiredRows(items, result);
    } catch (error) {
      throw new AcquireFailedError(ACQUIRE_FAILED_MESSAGE, error);
    }
  }

  private async runAcquireCallback<K extends string | number, T>(
    fn: (acquireResult: AcquiredResult<K>[]) => Awaitable<T>,
    acquiredResults: AcquiredResult<K>[],
    releaseAcquired: (items: ReleaseItem<K>[]) => Promise<void>,
    releaseFailureMessage: string,
  ): Promise<T> {
    try {
      return await fn(acquiredResults);
    } catch (error) {
      try {
        await releaseAcquired(this.getAcquiredReleaseItems(acquiredResults));
      } catch (releaseError) {
        throw new ReleaseFailedError(releaseFailureMessage, {
          acquireError: error,
          releaseError,
        });
      }
      throw error;
    }
  }

  private async releaseMany<K extends string | number>(
    items: ReleaseItem<K>[],
    options?: AcquireOptions,
  ): Promise<void> {
    if (!items.length) {
      return;
    }

    const prefix = options?.prefix ?? DEFAULT_PREFIX;
    const keys = items.map((item) => `${prefix}${item.key}`);
    const args = this.buildReleaseArgs(items, options);
    await this.runDynamicKeyReleaseScript(
      RELEASE_MANY_COMMAND,
      keys.length,
      [...keys, ...args],
      RELEASE_FAILED_MESSAGE,
    );
  }

  private async hashReleaseMany<K extends string | number>(
    hashKey: string,
    items: ReleaseItem<K>[],
    options?: AcquireOptions,
  ): Promise<void> {
    if (!items.length) {
      return;
    }

    const redisKey = `${options?.prefix ?? DEFAULT_PREFIX}${hashKey}`;
    const args = this.buildHashReleaseArgs(items, options);
    await this.runFixedKeyReleaseScript(
      HASH_RELEASE_MANY_COMMAND,
      [redisKey, ...args],
      HASH_RELEASE_FAILED_MESSAGE,
    );
  }

  private async runDynamicKeyReleaseScript(
    command: typeof RELEASE_MANY_COMMAND,
    keyCount: number,
    params: string[],
    failureMessage: string,
  ): Promise<void> {
    try {
      await this.luaRedis[command](keyCount, ...params);
    } catch (error) {
      throw new ReleaseFailedError(failureMessage, error);
    }
  }

  private async runFixedKeyReleaseScript(
    command: typeof HASH_RELEASE_MANY_COMMAND,
    params: string[],
    failureMessage: string,
  ): Promise<void> {
    try {
      await this.luaRedis[command](...params);
    } catch (error) {
      throw new ReleaseFailedError(failureMessage, error);
    }
  }

  private defineCommands(): void {
    this.redis.defineCommand(ACQUIRE_MANY_COMMAND, {
      lua: ACQUIRE_MANY_SCRIPT,
    });
    this.redis.defineCommand(HASH_ACQUIRE_MANY_COMMAND, {
      numberOfKeys: 1,
      lua: HASH_ACQUIRE_MANY_SCRIPT,
    });
    this.redis.defineCommand(RELEASE_MANY_COMMAND, {
      lua: RELEASE_MANY_SCRIPT,
    });
    this.redis.defineCommand(HASH_RELEASE_MANY_COMMAND, {
      numberOfKeys: 1,
      lua: HASH_RELEASE_MANY_SCRIPT,
    });
  }

  private get luaRedis(): RedisWithLuaCommands {
    return this.redis as RedisWithLuaCommands;
  }

  private buildAcquireArgs<K extends string | number>(
    items: AcquireDesire<K>[],
    options?: AcquireOptions,
  ): string[] {
    const args = [this.getFloatFlag(options)];
    for (const item of items) {
      args.push(
        String(item.key),
        String(item.desireAmount),
        item.limitAmount === undefined || item.limitAmount === null
          ? NO_LIMIT
          : HAS_LIMIT,
        String(item.limitAmount ?? 0),
      );
    }
    return args;
  }

  private buildHashAcquireArgs<K extends string | number>(
    items: AcquireDesire<K>[],
    options?: AcquireOptions,
  ): string[] {
    return [
      this.getFloatFlag(options),
      String(items.length),
      ...this.buildAcquireArgs(items).slice(1),
    ];
  }

  private buildReleaseArgs<K extends string | number>(
    items: ReleaseItem<K>[],
    options?: AcquireOptions,
  ): string[] {
    const args = [this.getFloatFlag(options)];
    for (const item of items) {
      args.push(String(item.key), String(item.amount));
    }
    return args;
  }

  private buildHashReleaseArgs<K extends string | number>(
    items: ReleaseItem<K>[],
    options?: AcquireOptions,
  ): string[] {
    return [
      this.getFloatFlag(options),
      String(items.length),
      ...this.buildReleaseArgs(items).slice(1),
    ];
  }

  private getFloatFlag(options?: AcquireOptions): string {
    return options?.float === true ? FLOAT_FLAG : INTEGER_FLAG;
  }

  private parseAcquiredRows<K extends string | number>(
    items: AcquireDesire<K>[],
    result: unknown,
  ): AcquiredResult<K>[] {
    if (!Array.isArray(result) || result.length !== items.length) {
      throw new AcquireFailedError(ACQUIRE_FAILED_MESSAGE);
    }

    return result.map((row, index) => {
      if (!this.isLuaRow(row)) {
        throw new AcquireFailedError(ACQUIRE_FAILED_MESSAGE);
      }
      return {
        key: items[index].key,
        currentAmount: Number(row[1]),
        acquiredAmount: Number(row[2]),
        lackingAmount: Number(row[3]),
      };
    });
  }

  private isLuaRow(row: unknown): row is LuaRow {
    return Array.isArray(row) && row.length === 4;
  }

  private getAcquiredReleaseItems<K extends string | number>(
    items: AcquiredResult<K>[],
  ): ReleaseItem<K>[] {
    return items
      .filter((item) => item.acquiredAmount > 0)
      .map((item) => ({ key: item.key, amount: item.acquiredAmount }));
  }
}

const parseIntegerValue = (value: NumericValue): number => {
  if (typeof value === "number") {
    return value;
  }
  return parseInt(value, INTEGER_RADIX);
};

const parseFloatValue = (value: NumericValue): number => {
  if (typeof value === "number") {
    return value;
  }
  return parseFloat(value);
};

const normalizeAcquireOptions = (
  options?: AcquireOptionsInput,
): AcquireOptions => {
  if (typeof options === "boolean") {
    return { float: options };
  }
  return options ?? {};
};

const assertFiniteItems = <K extends string | number>(
  items: AcquireDesire<K>[],
): void => {
  for (const item of items) {
    assertFiniteAmount(item.desireAmount);
    assertFiniteLimit(item.limitAmount);
  }
};

const assertFiniteAmount = (amount: number): void => {
  if (!Number.isFinite(amount)) {
    throw new AcquireFailedError(NON_FINITE_AMOUNT_MESSAGE);
  }
};

const assertFiniteLimit = (limit: number | undefined): void => {
  if (limit !== undefined && !Number.isFinite(limit)) {
    throw new AcquireFailedError(NON_FINITE_AMOUNT_MESSAGE);
  }
};

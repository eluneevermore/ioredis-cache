import type Redis from "ioredis";
import type { ChainableCommander, RedisKey } from "ioredis";

type Key = RedisKey | number;
type Awaitable<T> = T | Promise<T>;
type Pipeline = ChainableCommander;
type PipelineResult = [Error | null, unknown];
type NumericValue = string | number;

type ReleaseCommand<K extends string | number> = (
  pipeline: Pipeline,
  item: ReleaseItem<K>,
) => Pipeline;

type AcquireCommand<K extends string | number> = (
  pipeline: Pipeline,
  item: AcquireDesire<K>,
) => Pipeline;

type ReleaseAcquired<K extends string | number> = (
  items: ReleaseItem<K>[],
) => Promise<void>;

const ACQUIRE_FAILED_MESSAGE = "Failed to acquire requested amounts";
const RELEASE_FAILED_MESSAGE = "Failed to release acquired amounts";
const HASH_RELEASE_FAILED_MESSAGE = "Failed to release acquired hash amounts";
const RELEASE_AFTER_CALLBACK_FAILED_MESSAGE =
  "Failed to release acquired amounts after acquire callback failed";
const HASH_RELEASE_AFTER_CALLBACK_FAILED_MESSAGE =
  "Failed to release acquired hash amounts after acquire callback failed";
const DEFAULT_PREFIX = "";
const INTEGER_RADIX = 10;
const NON_FINITE_AMOUNT_MESSAGE = "Acquire amounts must be finite numbers";

export class AcquireFailedError extends Error {
  readonly cause?: unknown;

  constructor(message: string = ACQUIRE_FAILED_MESSAGE, cause?: unknown) {
    super(message);
    this.name = "AcquireFailedError";
    this.cause = cause;
    Object.setPrototypeOf(this, AcquireFailedError.prototype);
  }
}

export class ReleaseFailedError extends Error {
  readonly cause?: unknown;

  constructor(message: string = RELEASE_FAILED_MESSAGE, cause?: unknown) {
    super(message);
    this.name = "ReleaseFailedError";
    this.cause = cause;
    Object.setPrototypeOf(this, ReleaseFailedError.prototype);
  }
}

export type AcquireDesire<K extends string | number> = {
  key: K;
  desireAmount: number;
  limitAmount?: number;
};

export type AcquiredResult<K extends string | number> = {
  key: K;
  currentAmount: number;
  acquiredAmount: number;
  lackingAmount: number;
};

export type AcquireOptions = {
  prefix?: string;
  float?: boolean;
  limit?: number;
};

export type AcquireOptionsInput = AcquireOptions | boolean;

export type ReleaseItem<K extends string | number> = {
  key: K;
  amount: number;
};

export class Acquire {
  constructor(private readonly redis: Redis) {}

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
    const float = normalizedOptions.float === true;
    const change = this.getChangeCommand(float);
    const parse = float ? parseFloatValue : parseIntegerValue;
    let rollbackAmount = amount;
    try {
      const newAmount = parse(await change(key, amount));
      const acquireResult = this.getAcquiredResult(
        {
          key: String(key),
          desireAmount: amount,
          limitAmount: normalizedOptions.limit,
        },
        newAmount,
      );
      await this.releaseSingleLackingAmount(key, acquireResult, change);
      rollbackAmount = acquireResult.acquiredAmount;
      return await fn(
        acquireResult.currentAmount,
        acquireResult.acquiredAmount,
        acquireResult.lackingAmount,
      );
    } catch (error) {
      await change(key, -rollbackAmount);
      throw error;
    }
  }

  async hashAcquire<T>(
    key: Key,
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
    const float = normalizedOptions.float === true;
    const change = this.getHashChangeCommand(float);
    const parse = float ? parseFloatValue : parseIntegerValue;
    let rollbackAmount = amount;
    try {
      const newAmount = parse(await change(key, id, amount));
      const acquireResult = this.getAcquiredResult(
        {
          key: String(id),
          desireAmount: amount,
          limitAmount: normalizedOptions.limit,
        },
        newAmount,
      );
      await this.releaseSingleHashLackingAmount(key, id, acquireResult, change);
      rollbackAmount = acquireResult.acquiredAmount;
      return await fn(
        acquireResult.currentAmount,
        acquireResult.acquiredAmount,
        acquireResult.lackingAmount,
      );
    } catch (error) {
      await change(key, id, -rollbackAmount);
      throw error;
    }
  }

  async acquireMany<K extends string | number, T>(
    items: AcquireDesire<K>[],
    fn: (acquireResult: AcquiredResult<K>[]) => Awaitable<T>,
    options?: AcquireOptions,
  ): Promise<T> {
    assertFiniteItems(items);
    const prefix = options?.prefix ?? DEFAULT_PREFIX;
    return this.acquireBy(
      items,
      fn,
      this.getAcquireCommand(prefix, options?.float === true),
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
    const redisKey = `${options?.prefix ?? DEFAULT_PREFIX}${hashKey}`;
    return this.acquireBy(
      items,
      fn,
      this.getHashAcquireCommand(redisKey, options?.float === true),
      (releaseItems) => this.hashReleaseMany(hashKey, releaseItems, options),
      HASH_RELEASE_AFTER_CALLBACK_FAILED_MESSAGE,
    );
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

  private getAcquireCommand<K extends string | number>(
    prefix: string,
    float: boolean,
  ): AcquireCommand<K> {
    if (float) {
      return (pipeline, item) =>
        pipeline.incrbyfloat(`${prefix}${item.key}`, item.desireAmount);
    }
    return (pipeline, item) =>
      pipeline.incrby(`${prefix}${item.key}`, item.desireAmount);
  }

  private getHashAcquireCommand<K extends string | number>(
    redisKey: string,
    float: boolean,
  ): AcquireCommand<K> {
    if (float) {
      return (pipeline, item) =>
        pipeline.hincrbyfloat(redisKey, String(item.key), item.desireAmount);
    }
    return (pipeline, item) =>
      pipeline.hincrby(redisKey, String(item.key), item.desireAmount);
  }

  private async releaseMany<K extends string | number>(
    items: ReleaseItem<K>[],
    options?: AcquireOptions,
  ): Promise<void> {
    const prefix = options?.prefix ?? DEFAULT_PREFIX;
    await this.releaseBy(
      items,
      this.getReleaseCommand(prefix, options?.float === true),
      RELEASE_FAILED_MESSAGE,
    );
  }

  private async hashReleaseMany<K extends string | number>(
    hashKey: string,
    items: ReleaseItem<K>[],
    options?: AcquireOptions,
  ): Promise<void> {
    const redisKey = `${options?.prefix ?? DEFAULT_PREFIX}${hashKey}`;
    await this.releaseBy(
      items,
      this.getHashReleaseCommand(redisKey, options?.float === true),
      HASH_RELEASE_FAILED_MESSAGE,
    );
  }

  private getReleaseCommand<K extends string | number>(
    prefix: string,
    float: boolean,
  ): ReleaseCommand<K> {
    if (float) {
      return (pipeline, item) =>
        pipeline.incrbyfloat(`${prefix}${item.key}`, -item.amount);
    }
    return (pipeline, item) =>
      pipeline.decrby(`${prefix}${item.key}`, item.amount);
  }

  private getHashReleaseCommand<K extends string | number>(
    redisKey: string,
    float: boolean,
  ): ReleaseCommand<K> {
    if (float) {
      return (pipeline, item) =>
        pipeline.hincrbyfloat(redisKey, String(item.key), -item.amount);
    }
    return (pipeline, item) =>
      pipeline.hincrby(redisKey, String(item.key), -item.amount);
  }

  private async releaseBy<K extends string | number>(
    items: ReleaseItem<K>[],
    releaseCommand: ReleaseCommand<K>,
    failureMessage: string,
  ): Promise<void> {
    if (!items.length) {
      return;
    }

    let results: PipelineResult[] | null;
    try {
      results = await items.reduce(releaseCommand, this.redis.pipeline()).exec();
    } catch (error) {
      throw new ReleaseFailedError(failureMessage, error);
    }

    if (!results || results.some((result) => result[0] !== null)) {
      throw new ReleaseFailedError(failureMessage);
    }
  }

  private async acquireBy<K extends string | number, T>(
    items: AcquireDesire<K>[],
    fn: (acquireResult: AcquiredResult<K>[]) => Awaitable<T>,
    acquireCommand: AcquireCommand<K>,
    releaseAcquired: ReleaseAcquired<K>,
    releaseAfterCallbackFailedMessage: string,
  ): Promise<T> {
    if (!items.length) {
      return await fn([]);
    }

    const results = await this.executeAcquirePipeline(items, acquireCommand);
    await this.releaseAfterAcquireFailure(items, results, releaseAcquired);

    const acquiredResults = this.getAcquiredResults(items, results);
    await this.releaseLackingAmounts(acquiredResults, releaseAcquired);
    return this.runAcquireCallback(
      fn,
      acquiredResults,
      releaseAcquired,
      releaseAfterCallbackFailedMessage,
    );
  }

  private async executeAcquirePipeline<K extends string | number>(
    items: AcquireDesire<K>[],
    acquireCommand: AcquireCommand<K>,
  ): Promise<PipelineResult[]> {
    try {
      const results = await items
        .reduce(acquireCommand, this.redis.pipeline())
        .exec();
      if (!results) {
        throw new AcquireFailedError();
      }
      return results;
    } catch (error) {
      if (error instanceof AcquireFailedError) {
        throw error;
      }
      throw new AcquireFailedError(ACQUIRE_FAILED_MESSAGE, error);
    }
  }

  private async releaseAfterAcquireFailure<K extends string | number>(
    items: AcquireDesire<K>[],
    results: PipelineResult[],
    releaseAcquired: ReleaseAcquired<K>,
  ): Promise<void> {
    const errors = this.getFailedIndexes(results);
    if (!errors.size) {
      return;
    }

    await releaseAcquired(this.getDesiredReleaseItems(items, errors));
    throw new AcquireFailedError();
  }

  private async releaseLackingAmounts<K extends string | number>(
    acquiredResults: AcquiredResult<K>[],
    releaseAcquired: ReleaseAcquired<K>,
  ): Promise<void> {
    const lackingItems = acquiredResults
      .filter((item) => item.lackingAmount > 0)
      .map((item) => ({ key: item.key, amount: item.lackingAmount }));
    await releaseAcquired(lackingItems);
  }

  private async releaseSingleLackingAmount<K extends string | number>(
    key: Key,
    acquireResult: AcquiredResult<K>,
    change: (key: Key, amount: number) => Promise<NumericValue>,
  ): Promise<void> {
    if (acquireResult.lackingAmount <= 0) {
      return;
    }
    await change(key, -acquireResult.lackingAmount);
  }

  private async releaseSingleHashLackingAmount<K extends string | number>(
    key: Key,
    id: Key,
    acquireResult: AcquiredResult<K>,
    change: (key: Key, id: Key, amount: number) => Promise<NumericValue>,
  ): Promise<void> {
    if (acquireResult.lackingAmount <= 0) {
      return;
    }
    await change(key, id, -acquireResult.lackingAmount);
  }

  private async runAcquireCallback<K extends string | number, T>(
    fn: (acquireResult: AcquiredResult<K>[]) => Awaitable<T>,
    acquiredResults: AcquiredResult<K>[],
    releaseAcquired: ReleaseAcquired<K>,
    releaseAfterCallbackFailedMessage: string,
  ): Promise<T> {
    try {
      return await fn(acquiredResults);
    } catch (error) {
      await this.releaseAfterCallbackFailure(
        acquiredResults,
        releaseAcquired,
        releaseAfterCallbackFailedMessage,
        error,
      );
      throw error;
    }
  }

  private async releaseAfterCallbackFailure<K extends string | number>(
    acquiredResults: AcquiredResult<K>[],
    releaseAcquired: ReleaseAcquired<K>,
    releaseAfterCallbackFailedMessage: string,
    acquireError: unknown,
  ): Promise<void> {
    try {
      await releaseAcquired(this.getAcquiredReleaseItems(acquiredResults));
    } catch (releaseError) {
      throw new ReleaseFailedError(releaseAfterCallbackFailedMessage, {
        acquireError,
        releaseError,
      });
    }
  }

  private getFailedIndexes(results: PipelineResult[]): Set<number> {
    return results.reduce(
      (errors, result, index) =>
        result[0] !== null ? errors.add(index) : errors,
      new Set<number>(),
    );
  }

  private getDesiredReleaseItems<K extends string | number>(
    items: AcquireDesire<K>[],
    failedIndexes: Set<number>,
  ): ReleaseItem<K>[] {
    return items
      .filter((_, index) => !failedIndexes.has(index))
      .map((item) => ({ key: item.key, amount: item.desireAmount }));
  }

  private getAcquiredReleaseItems<K extends string | number>(
    items: AcquiredResult<K>[],
  ): ReleaseItem<K>[] {
    return items
      .filter((item) => item.acquiredAmount > 0)
      .map((item) => ({ key: item.key, amount: item.acquiredAmount }));
  }

  private getAcquiredResults<K extends string | number>(
    items: AcquireDesire<K>[],
    results: PipelineResult[],
  ): AcquiredResult<K>[] {
    return items.map((item, index) =>
      this.getAcquiredResult(item, Number(results[index][1])),
    );
  }

  private getAcquiredResult<K extends string | number>(
    item: AcquireDesire<K>,
    newAmount: number,
  ): AcquiredResult<K> {
    if (item.limitAmount === undefined || item.limitAmount === null) {
      return {
        key: item.key,
        currentAmount: newAmount,
        acquiredAmount: item.desireAmount,
        lackingAmount: 0,
      };
    }

    const prevAmount = newAmount - item.desireAmount;
    const availableAmount = Math.max(0, item.limitAmount - prevAmount);
    const acquiredAmount = Math.min(item.desireAmount, availableAmount);
    return {
      key: item.key,
      currentAmount: prevAmount + acquiredAmount,
      acquiredAmount,
      lackingAmount: item.desireAmount - acquiredAmount,
    };
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

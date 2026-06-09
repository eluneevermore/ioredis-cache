import type { RedisKey } from "ioredis";
import type {
  AcquiredResult,
  AcquireDesire,
  AcquireOptions,
  AcquireOptionsInput,
} from "./Acquire";

type Key = RedisKey | number;
type Awaitable<T> = T | Promise<T>;

/**
 * Structural contract for custom acquire implementations injected into Cache.
 */
export interface AcquireHelper {
  acquire<T>(
    key: Key,
    amount: number,
    fn: (
      currentAmount: number,
      acquiredAmount: number,
      lackingAmount: number,
    ) => Awaitable<T>,
    options?: AcquireOptionsInput,
  ): Promise<T>;
  hashAcquire<T>(
    key: Key,
    id: Key,
    amount: number,
    fn: (
      currentAmount: number,
      acquiredAmount: number,
      lackingAmount: number,
    ) => Awaitable<T>,
    options?: AcquireOptionsInput,
  ): Promise<T>;
  acquireMany<K extends string | number, T>(
    items: AcquireDesire<K>[],
    fn: (acquireResult: AcquiredResult<K>[]) => Awaitable<T>,
    options?: AcquireOptions,
  ): Promise<T>;
  hashAcquireMany<K extends string | number, T>(
    hashKey: string,
    items: AcquireDesire<K>[],
    fn: (acquireResult: AcquiredResult<K>[]) => Awaitable<T>,
    options?: AcquireOptions,
  ): Promise<T>;
}

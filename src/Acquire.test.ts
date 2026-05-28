/// <reference types="jest" />

import type Redis from "ioredis";
import {
  Acquire,
  AcquireFailedError,
  ReleaseFailedError,
} from "./Acquire";

type PipelineValue = number | string | null;
type PipelineResult = [Error | null, PipelineValue];
type PipelineCommand = () => PipelineResult;

const INTEGER_PATTERN = /^-?\d+$/;
const TEST_PREFIX = "acquire-test:";
const TEST_HASH_KEY = "reward-counts";
const INVALID_INTEGER_VALUE = "not-an-integer";
const EXPECTED_REJECTION_MESSAGE = "Expected promise to reject";

describe("Acquire", () => {
  describe("#acquire", () => {
    it("supports float increments", async () => {
      const { acquire, redis } = createAcquire();

      const result = await acquire.acquire("ticket", 1.5, (current) => {
        return current;
      }, true);

      expect(result).toBe(1.5);
      expect(redis.getNumber("ticket")).toBe(1.5);
    });
  });

  describe("#hashAcquire", () => {
    it("supports float hash increments", async () => {
      const { acquire, redis } = createAcquire();

      const result = await acquire.hashAcquire(
        TEST_HASH_KEY,
        "ticket",
        1.5,
        (current) => current,
        true,
      );

      expect(result).toBe(1.5);
      expect(redis.getHashNumber(TEST_HASH_KEY, "ticket")).toBe(1.5);
    });
  });

  describe("#acquireMany", () => {
    it("calls callback with empty result without creating a pipeline", async () => {
      const { acquire, redis } = createAcquire();

      const result = await acquire.acquireMany([], (acquiredResults) => {
        expect(acquiredResults).toEqual([]);
        return "empty";
      });

      expect(result).toBe("empty");
      expect(redis.pipelineCount).toBe(0);
    });

    it("increments all requested keys with the configured prefix", async () => {
      const { acquire, redis } = createAcquire();

      const result = await acquire.acquireMany(
        [{ key: "ticket", desireAmount: 2 }],
        (acquiredResults) => acquiredResults,
        { prefix: TEST_PREFIX },
      );

      expect(result).toEqual([
        { key: "ticket", acquiredAmount: 2, lackingAmount: 0 },
      ]);
      expect(redis.getNumber(`${TEST_PREFIX}ticket`)).toBe(2);
      expect(redis.getRawValue("ticket")).toBeUndefined();
    });

    it("passes fully acquired amounts to callback when no limits are configured", async () => {
      const { acquire, redis } = createAcquire();

      const result = await acquire.acquireMany(
        [{ key: "ticket", desireAmount: 2 }],
        (acquiredResults) => acquiredResults,
      );

      expect(result).toEqual([
        { key: "ticket", acquiredAmount: 2, lackingAmount: 0 },
      ]);
      expect(redis.getNumber("ticket")).toBe(2);
      expect(redis.pipelineCount).toBe(1);
    });

    it("does not release when requested amount exactly reaches the limit", async () => {
      const { acquire, redis } = createAcquire();
      redis.setValue(`${TEST_PREFIX}ticket`, 8);

      const result = await acquire.acquireMany(
        [{ key: "ticket", desireAmount: 2, limitAmount: 10 }],
        (acquiredResults) => acquiredResults,
        { prefix: TEST_PREFIX },
      );

      expect(result).toEqual([
        { key: "ticket", acquiredAmount: 2, lackingAmount: 0 },
      ]);
      expect(redis.getNumber(`${TEST_PREFIX}ticket`)).toBe(10);
      expect(redis.pipelineCount).toBe(1);
    });

    it("releases over-acquired amounts before calling callback", async () => {
      const { acquire, redis } = createAcquire();
      redis.setValue(`${TEST_PREFIX}ticket`, 8);

      const result = await acquire.acquireMany(
        [{ key: "ticket", desireAmount: 5, limitAmount: 10 }],
        (acquiredResults) => {
          expect(redis.getNumber(`${TEST_PREFIX}ticket`)).toBe(10);
          return acquiredResults;
        },
        { prefix: TEST_PREFIX },
      );

      expect(result).toEqual([
        { key: "ticket", acquiredAmount: 2, lackingAmount: 3 },
      ]);
      expect(redis.getNumber(`${TEST_PREFIX}ticket`)).toBe(10);
      expect(redis.pipelineCount).toBe(2);
    });

    it("supports float limits when configured", async () => {
      const { acquire, redis } = createAcquire();
      redis.setValue("ticket", 1.5);

      const result = await acquire.acquireMany(
        [{ key: "ticket", desireAmount: 1.25, limitAmount: 2 }],
        (acquiredResults) => acquiredResults,
        { float: true },
      );

      expect(result).toEqual([
        { key: "ticket", acquiredAmount: 0.5, lackingAmount: 0.75 },
      ]);
      expect(redis.getNumber("ticket")).toBe(2);
    });

    it("rolls back acquired amount when callback fails", async () => {
      const { acquire, redis } = createAcquire();
      redis.setValue(`${TEST_PREFIX}ticket`, 6);
      const expectedError = new Error("create failed");

      const error = await getRejectedError(() =>
        acquire.acquireMany(
          [{ key: "ticket", desireAmount: 2, limitAmount: 10 }],
          (acquiredResults) => {
            expect(acquiredResults).toEqual([
              { key: "ticket", acquiredAmount: 2, lackingAmount: 0 },
            ]);
            expect(redis.getNumber(`${TEST_PREFIX}ticket`)).toBe(8);
            throw expectedError;
          },
          { prefix: TEST_PREFIX },
        ),
      );

      expect(error).toBe(expectedError);
      expect(redis.getNumber(`${TEST_PREFIX}ticket`)).toBe(6);
    });

    it("throws release error before callback when lacking release fails", async () => {
      const { acquire, redis } = createAcquire();
      redis.setValue(`${TEST_PREFIX}ticket`, 8);
      redis.failNextDecrementFor(`${TEST_PREFIX}ticket`);
      const callback = jest.fn();

      await expect(
        acquire.acquireMany(
          [{ key: "ticket", desireAmount: 5, limitAmount: 10 }],
          callback,
          { prefix: TEST_PREFIX },
        ),
      ).rejects.toBeInstanceOf(ReleaseFailedError);
      expect(callback).not.toHaveBeenCalled();
    });

    it("throws release error with callback error as cause when rollback fails", async () => {
      const { acquire, redis } = createAcquire();
      redis.setValue(`${TEST_PREFIX}ticket`, 8);
      const expectedError = new Error("create failed");

      const error = await getRejectedError(() =>
        acquire.acquireMany(
          [{ key: "ticket", desireAmount: 2, limitAmount: 10 }],
          () => {
            redis.failNextDecrementFor(`${TEST_PREFIX}ticket`);
            throw expectedError;
          },
          { prefix: TEST_PREFIX },
        ),
      );

      expect(error).toBeInstanceOf(ReleaseFailedError);
      expect(getReleaseCause(error).acquireError).toBe(expectedError);
      expect(getReleaseCause(error).releaseError).toBeInstanceOf(
        ReleaseFailedError,
      );
      expect(redis.getNumber(`${TEST_PREFIX}ticket`)).toBe(10);
    });

    it("throws acquire error when redis does not return pipeline results", async () => {
      const { acquire, redis } = createAcquire();
      redis.returnNullOnNextExec();

      await expect(
        acquire.acquireMany([{ key: "ticket", desireAmount: 1 }], () => {
          return "created";
        }),
      ).rejects.toBeInstanceOf(AcquireFailedError);
    });

    it("throws acquire error when redis pipeline execution throws", async () => {
      const { acquire, redis } = createAcquire();
      redis.throwOnNextExec(new Error("redis unavailable"));

      await expect(
        acquire.acquireMany([{ key: "ticket", desireAmount: 1 }], () => {
          return "created";
        }),
      ).rejects.toBeInstanceOf(AcquireFailedError);
      expect(redis.getNumber("ticket")).toBe(0);
    });

    it("rolls back successful increments when one acquire command fails", async () => {
      const { acquire, redis } = createAcquire();
      redis.setValue(`${TEST_PREFIX}bad`, INVALID_INTEGER_VALUE);
      redis.setValue(`${TEST_PREFIX}good`, 4);

      await expect(
        acquire.acquireMany(
          [
            { key: "bad", desireAmount: 1 },
            { key: "good", desireAmount: 2 },
          ],
          () => {
            throw new Error("callback should not run");
          },
          { prefix: TEST_PREFIX },
        ),
      ).rejects.toBeInstanceOf(AcquireFailedError);

      expect(redis.getRawValue(`${TEST_PREFIX}bad`)).toBe(
        INVALID_INTEGER_VALUE,
      );
      expect(redis.getNumber(`${TEST_PREFIX}good`)).toBe(4);
    });

    it("throws release error when acquire failure rollback fails", async () => {
      const { acquire, redis } = createAcquire();
      redis.setValue(`${TEST_PREFIX}bad`, INVALID_INTEGER_VALUE);
      redis.setValue(`${TEST_PREFIX}good`, 4);
      redis.failNextDecrementFor(`${TEST_PREFIX}good`);

      await expect(
        acquire.acquireMany(
          [
            { key: "bad", desireAmount: 1 },
            { key: "good", desireAmount: 2 },
          ],
          () => {
            throw new Error("callback should not run");
          },
          { prefix: TEST_PREFIX },
        ),
      ).rejects.toBeInstanceOf(ReleaseFailedError);
      expect(redis.getNumber(`${TEST_PREFIX}good`)).toBe(6);
    });
  });

  describe("#hashAcquireMany", () => {
    it("calls callback with empty result without creating a pipeline", async () => {
      const { acquire, redis } = createAcquire();

      const result = await acquire.hashAcquireMany(
        TEST_HASH_KEY,
        [],
        (acquiredResults) => {
          expect(acquiredResults).toEqual([]);
          return "empty";
        },
      );

      expect(result).toBe("empty");
      expect(redis.pipelineCount).toBe(0);
    });

    it("increments hash fields under the prefixed hash key", async () => {
      const { acquire, redis } = createAcquire();

      const result = await acquire.hashAcquireMany(
        TEST_HASH_KEY,
        [{ key: "ticket", desireAmount: 2 }],
        (acquiredResults) => acquiredResults,
        { prefix: TEST_PREFIX },
      );

      expect(result).toEqual([
        { key: "ticket", acquiredAmount: 2, lackingAmount: 0 },
      ]);
      expect(redis.getHashNumber(`${TEST_PREFIX}${TEST_HASH_KEY}`, "ticket"))
        .toBe(2);
      expect(redis.getHashRawValue(TEST_HASH_KEY, "ticket")).toBeUndefined();
    });

    it("releases over-acquired hash amount before calling callback", async () => {
      const { acquire, redis } = createAcquire();
      redis.setHashValue(`${TEST_PREFIX}${TEST_HASH_KEY}`, "ticket", 8);

      const result = await acquire.hashAcquireMany(
        TEST_HASH_KEY,
        [{ key: "ticket", desireAmount: 5, limitAmount: 10 }],
        (acquiredResults) => {
          expect(
            redis.getHashNumber(`${TEST_PREFIX}${TEST_HASH_KEY}`, "ticket"),
          ).toBe(10);
          return acquiredResults;
        },
        { prefix: TEST_PREFIX },
      );

      expect(result).toEqual([
        { key: "ticket", acquiredAmount: 2, lackingAmount: 3 },
      ]);
      expect(redis.getHashNumber(`${TEST_PREFIX}${TEST_HASH_KEY}`, "ticket"))
        .toBe(10);
    });

    it("supports float hash limits when configured", async () => {
      const { acquire, redis } = createAcquire();
      redis.setHashValue(TEST_HASH_KEY, "ticket", 1.5);

      const result = await acquire.hashAcquireMany(
        TEST_HASH_KEY,
        [{ key: "ticket", desireAmount: 1.25, limitAmount: 2 }],
        (acquiredResults) => acquiredResults,
        { float: true },
      );

      expect(result).toEqual([
        { key: "ticket", acquiredAmount: 0.5, lackingAmount: 0.75 },
      ]);
      expect(redis.getHashNumber(TEST_HASH_KEY, "ticket")).toBe(2);
    });

    it("rolls back acquired hash amount when callback fails", async () => {
      const { acquire, redis } = createAcquire();
      redis.setHashValue(`${TEST_PREFIX}${TEST_HASH_KEY}`, "ticket", 6);
      const expectedError = new Error("create failed");

      const error = await getRejectedError(() =>
        acquire.hashAcquireMany(
          TEST_HASH_KEY,
          [{ key: "ticket", desireAmount: 2, limitAmount: 10 }],
          (acquiredResults) => {
            expect(acquiredResults).toEqual([
              { key: "ticket", acquiredAmount: 2, lackingAmount: 0 },
            ]);
            expect(
              redis.getHashNumber(`${TEST_PREFIX}${TEST_HASH_KEY}`, "ticket"),
            ).toBe(8);
            throw expectedError;
          },
          { prefix: TEST_PREFIX },
        ),
      );

      expect(error).toBe(expectedError);
      expect(redis.getHashNumber(`${TEST_PREFIX}${TEST_HASH_KEY}`, "ticket"))
        .toBe(6);
    });

    it("rolls back successful hash increments when one command fails", async () => {
      const { acquire, redis } = createAcquire();
      redis.setHashValue(
        `${TEST_PREFIX}${TEST_HASH_KEY}`,
        "bad",
        INVALID_INTEGER_VALUE,
      );
      redis.setHashValue(`${TEST_PREFIX}${TEST_HASH_KEY}`, "good", 4);

      await expect(
        acquire.hashAcquireMany(
          TEST_HASH_KEY,
          [
            { key: "bad", desireAmount: 1 },
            { key: "good", desireAmount: 2 },
          ],
          () => {
            throw new Error("callback should not run");
          },
          { prefix: TEST_PREFIX },
        ),
      ).rejects.toBeInstanceOf(AcquireFailedError);

      expect(
        redis.getHashRawValue(`${TEST_PREFIX}${TEST_HASH_KEY}`, "bad"),
      ).toBe(INVALID_INTEGER_VALUE);
      expect(redis.getHashNumber(`${TEST_PREFIX}${TEST_HASH_KEY}`, "good"))
        .toBe(4);
    });

    it("throws release error when acquired hash amount cannot be released", async () => {
      const { acquire, redis } = createAcquire();
      redis.setHashValue(`${TEST_PREFIX}${TEST_HASH_KEY}`, "ticket", 8);
      redis.failNextHashDecrementFor(
        `${TEST_PREFIX}${TEST_HASH_KEY}`,
        "ticket",
      );
      const callback = jest.fn();

      await expect(
        acquire.hashAcquireMany(
          TEST_HASH_KEY,
          [{ key: "ticket", desireAmount: 5, limitAmount: 10 }],
          callback,
          { prefix: TEST_PREFIX },
        ),
      ).rejects.toBeInstanceOf(ReleaseFailedError);
      expect(callback).not.toHaveBeenCalled();
    });
  });
});

const createAcquire = (): { acquire: Acquire; redis: FakeRedis } => {
  const redis = new FakeRedis();
  return {
    acquire: new Acquire(redis as unknown as Redis),
    redis,
  };
};

const getRejectedError = async (
  action: () => Promise<unknown>,
): Promise<unknown> => {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error(EXPECTED_REJECTION_MESSAGE);
};

const getReleaseCause = (
  error: unknown,
): { acquireError?: unknown; releaseError?: unknown } => {
  return (error as ReleaseFailedError).cause as {
    acquireError?: unknown;
    releaseError?: unknown;
  };
};

class FakeRedis {
  private readonly values = new Map<string, string>();
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly decrementFailures = new Set<string>();
  private readonly hashDecrementFailures = new Set<string>();
  private execFailure: Error | null = null;
  private shouldReturnNull = false;
  pipelineCount = 0;

  pipeline(): FakePipeline {
    this.pipelineCount += 1;
    return new FakePipeline(this);
  }

  async incrby(key: string, amount: number): Promise<number> {
    return this.unwrapIntegerResult(this.changeIntegerBy(key, amount));
  }

  async incrbyfloat(key: string, amount: number): Promise<string> {
    return this.unwrapStringResult(this.changeFloatBy(key, amount));
  }

  async hincrby(
    hashKey: string,
    field: string,
    amount: number,
  ): Promise<number> {
    return this.unwrapIntegerResult(
      this.changeHashIntegerBy(hashKey, field, amount),
    );
  }

  async hincrbyfloat(
    hashKey: string,
    field: string,
    amount: number,
  ): Promise<string> {
    return this.unwrapStringResult(
      this.changeHashFloatBy(hashKey, field, amount),
    );
  }

  setValue(key: string, value: string | number): void {
    this.values.set(key, String(value));
  }

  getRawValue(key: string): string | undefined {
    return this.values.get(key);
  }

  getNumber(key: string): number {
    return Number(this.values.get(key) ?? 0);
  }

  setHashValue(hashKey: string, field: string, value: string | number): void {
    this.getHash(hashKey).set(field, String(value));
  }

  getHashRawValue(hashKey: string, field: string): string | undefined {
    return this.hashes.get(hashKey)?.get(field);
  }

  getHashNumber(hashKey: string, field: string): number {
    return Number(this.hashes.get(hashKey)?.get(field) ?? 0);
  }

  failNextDecrementFor(key: string): void {
    this.decrementFailures.add(key);
  }

  failNextHashDecrementFor(hashKey: string, field: string): void {
    this.hashDecrementFailures.add(this.getHashFailureKey(hashKey, field));
  }

  returnNullOnNextExec(): void {
    this.shouldReturnNull = true;
  }

  throwOnNextExec(error: Error): void {
    this.execFailure = error;
  }

  consumeExecFailure(): Error | null {
    const error = this.execFailure;
    this.execFailure = null;
    return error;
  }

  consumeShouldReturnNull(): boolean {
    const shouldReturnNull = this.shouldReturnNull;
    this.shouldReturnNull = false;
    return shouldReturnNull;
  }

  changeIntegerBy(key: string, amount: number): PipelineResult {
    const currentValue = this.values.get(key) ?? "0";
    if (!INTEGER_PATTERN.test(currentValue)) {
      return [new Error("ERR value is not an integer or out of range"), null];
    }
    return this.changeValidNumberBy(key, currentValue, amount);
  }

  changeFloatBy(key: string, amount: number): PipelineResult {
    const currentValue = this.values.get(key) ?? "0";
    if (!isNumeric(currentValue)) {
      return [new Error("ERR value is not a valid float"), null];
    }
    return this.changeValidNumberBy(key, currentValue, amount, true);
  }

  changeHashIntegerBy(
    hashKey: string,
    field: string,
    amount: number,
  ): PipelineResult {
    const hash = this.getHash(hashKey);
    const currentValue = hash.get(field) ?? "0";
    if (!INTEGER_PATTERN.test(currentValue)) {
      return [
        new Error("ERR hash value is not an integer or out of range"),
        null,
      ];
    }
    return this.changeValidHashNumberBy(hashKey, field, currentValue, amount);
  }

  changeHashFloatBy(
    hashKey: string,
    field: string,
    amount: number,
  ): PipelineResult {
    const hash = this.getHash(hashKey);
    const currentValue = hash.get(field) ?? "0";
    if (!isNumeric(currentValue)) {
      return [new Error("ERR hash value is not a valid float"), null];
    }
    return this.changeValidHashNumberBy(
      hashKey,
      field,
      currentValue,
      amount,
      true,
    );
  }

  private changeValidNumberBy(
    key: string,
    currentValue: string,
    amount: number,
    returnsString: boolean = false,
  ): PipelineResult {
    if (amount < 0 && this.decrementFailures.delete(key)) {
      return [new Error("ERR injected decrement failure"), null];
    }

    const nextValue = Number(currentValue) + amount;
    this.values.set(key, String(nextValue));
    return [null, returnsString ? String(nextValue) : nextValue];
  }

  private changeValidHashNumberBy(
    hashKey: string,
    field: string,
    currentValue: string,
    amount: number,
    returnsString: boolean = false,
  ): PipelineResult {
    if (
      amount < 0 &&
      this.hashDecrementFailures.delete(this.getHashFailureKey(hashKey, field))
    ) {
      return [new Error("ERR injected hash decrement failure"), null];
    }

    const nextValue = Number(currentValue) + amount;
    this.getHash(hashKey).set(field, String(nextValue));
    return [null, returnsString ? String(nextValue) : nextValue];
  }

  private unwrapIntegerResult(result: PipelineResult): number {
    if (result[0]) {
      throw result[0];
    }
    return Number(result[1]);
  }

  private unwrapStringResult(result: PipelineResult): string {
    if (result[0]) {
      throw result[0];
    }
    return String(result[1]);
  }

  private getHash(hashKey: string): Map<string, string> {
    const hash = this.hashes.get(hashKey);
    if (hash) {
      return hash;
    }
    const nextHash = new Map<string, string>();
    this.hashes.set(hashKey, nextHash);
    return nextHash;
  }

  private getHashFailureKey(hashKey: string, field: string): string {
    return `${hashKey}\0${field}`;
  }
}

class FakePipeline {
  private readonly commands: PipelineCommand[] = [];

  constructor(private readonly redis: FakeRedis) {}

  incrby(key: string, amount: number): this {
    this.commands.push(() => this.redis.changeIntegerBy(key, amount));
    return this;
  }

  incrbyfloat(key: string, amount: number): this {
    this.commands.push(() => this.redis.changeFloatBy(key, amount));
    return this;
  }

  decrby(key: string, amount: number): this {
    this.commands.push(() => this.redis.changeIntegerBy(key, -amount));
    return this;
  }

  hincrby(hashKey: string, field: string, amount: number): this {
    this.commands.push(() =>
      this.redis.changeHashIntegerBy(hashKey, field, amount),
    );
    return this;
  }

  hincrbyfloat(hashKey: string, field: string, amount: number): this {
    this.commands.push(() =>
      this.redis.changeHashFloatBy(hashKey, field, amount),
    );
    return this;
  }

  async exec(): Promise<PipelineResult[] | null> {
    const error = this.redis.consumeExecFailure();
    if (error) {
      throw error;
    }

    if (this.redis.consumeShouldReturnNull()) {
      return null;
    }

    return this.commands.map((command) => command());
  }
}

const isNumeric = (value: string): boolean => {
  return value.trim() !== "" && Number.isFinite(Number(value));
};

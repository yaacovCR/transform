import { promiseWithResolvers } from './promiseWithResolvers.js';
import type { SimpleAsyncGenerator } from './SimpleAsyncGenerator.js';

interface WaitingConsumer<T> {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error?: unknown) => void;
}

type GeneratorResult<T> =
  | {
      iteratorResult: IteratorResult<T>;
      error?: never;
    }
  | {
      iteratorResult?: never;
      error: unknown;
    };

/**
 * @internal
 */
export class AsyncGeneratorCombinator<T> implements SimpleAsyncGenerator<T> {
  private _generators: Set<SimpleAsyncGenerator<T>>;
  private _availableGenerators: Set<SimpleAsyncGenerator<T>>;
  private _waitingConsumers: Array<WaitingConsumer<T>>;
  private _availableResults: Array<GeneratorResult<T>>;
  private _isDone: boolean;

  constructor() {
    this._generators = new Set();
    this._availableGenerators = new Set();
    this._waitingConsumers = [];
    this._availableResults = [];
    this._isDone = false;
  }

  add(generator: SimpleAsyncGenerator<T>): void {
    this._generators.add(generator);
    this._availableGenerators.add(generator);
    if (this._waitingConsumers.length > 0) {
      this._pollGenerator(generator);
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this._isDone) {
      return { value: undefined, done: true };
    }

    const queuedResult = this._availableResults.shift();
    if (queuedResult) {
      const iteratorResult = queuedResult.iteratorResult;
      if (iteratorResult) {
        return iteratorResult;
      }
      this._isDone = true;
      throw queuedResult.error;
    }

    const { promise, resolve, reject } =
      promiseWithResolvers<IteratorResult<T>>();

    this._waitingConsumers.push({ resolve, reject });

    this._pollAvailableGenerators();

    return promise;
  }

  async return(): Promise<IteratorResult<T>> {
    this._flush();
    await Promise.all(
      Array.from(this._generators).map((generator) => generator.return()),
    );
    return { value: undefined, done: true };
  }

  async throw(error?: unknown): Promise<IteratorResult<T>> {
    this._flush();
    await Promise.all(
      Array.from(this._generators).map((generator) => generator.throw(error)),
    );
    throw error; /* c8 ignore start */
  } /* c8 ignore stop */

  [Symbol.asyncIterator](): this {
    return this;
  }

  private _pollAvailableGenerators(): void {
    for (const generator of this._availableGenerators) {
      this._pollGenerator(generator);
    }
  }

  private _pollGenerator(generator: SimpleAsyncGenerator<T>): void {
    this._availableGenerators.delete(generator);
    generator.next().then(
      (iteratorResult) => this._onIteratorResult(generator, iteratorResult),
      (error: unknown) => this._onError(error),
    );
  }

  private _onIteratorResult(
    generator: SimpleAsyncGenerator<T>,
    iteratorResult: IteratorResult<T>,
  ): void {
    if (iteratorResult.done) {
      this._generators.delete(generator);
      if (this._generators.size === 0) {
        this._flush();
      }
    } else if (!this._isDone) {
      this._availableGenerators.add(generator);

      const waitingConsumer = this._waitingConsumers.shift();
      if (waitingConsumer) {
        waitingConsumer.resolve(iteratorResult);
        if (this._waitingConsumers.length > 0) {
          this._pollAvailableGenerators();
        }
      } else {
        this._availableResults.push({ iteratorResult });
      }
    }
  }

  private _onError(error: unknown): void {
    const waitingConsumer = this._waitingConsumers.shift();
    if (waitingConsumer) {
      waitingConsumer.reject(error);
      this._flush();
    } else {
      this._availableResults.push({ error });
    }
  }

  private _flush(): void {
    this._isDone = true;
    this._waitingConsumers.forEach(({ resolve }) =>
      resolve({ value: undefined, done: true }),
    );
    this._waitingConsumers = [];
  }
}

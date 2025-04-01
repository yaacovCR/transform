import { promiseWithResolvers } from './promiseWithResolvers.js';
import type { SimpleAsyncGenerator } from './SimpleAsyncGenerator.js';

/**
 * @internal
 */
export class AsyncIterableRegistry<T> {
  private _isDone: boolean;
  private _sources: Set<SimpleAsyncGenerator<T>>;
  private _sourcesToPoll: Set<SimpleAsyncGenerator<T>>;
  private _completedQueue: Array<IteratorResult<T>>;
  private _nextQueue: Array<(result: IteratorResult<T>) => void>;

  constructor() {
    this._isDone = false;
    this._sources = new Set();
    this._sourcesToPoll = new Set();
    this._completedQueue = [];
    this._nextQueue = [];
  }

  subscribe(): SimpleAsyncGenerator<T> {
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => this._next(),
      return: () => this._return(),
      throw: (error) => this._throw(error),
    };
  }

  add(source: SimpleAsyncGenerator<T>): void {
    this._sources.add(source);
    this._sourcesToPoll.add(source);
  }

  private async _next(): Promise<IteratorResult<T, void>> {
    if (this._isDone) {
      return { value: undefined, done: true };
    }

    const completed = this._completedQueue.shift();

    if (completed) {
      return completed;
    }

    const { promise, resolve } = promiseWithResolvers<IteratorResult<T>>();
    this._nextQueue.push(resolve);

    for (const source of this._sourcesToPoll) {
      this._issueNext(source);
    }

    return promise;
  }

  private _issueNext(source: SimpleAsyncGenerator<T>): void {
    this._sourcesToPoll.delete(source);
    source.next().then(
      (result) => this._onResult(source, result),
      (error: unknown) => this._throw(error),
    );
  }

  private _onResult(
    source: SimpleAsyncGenerator<T>,
    result: IteratorResult<T>,
  ): void {
    if (result.done) {
      this._sources.delete(source);
    } else {
      this._sourcesToPoll.add(source);

      const resolve = this._nextQueue.shift();
      if (resolve) {
        resolve(result);
      } else {
        this._completedQueue.push(result);
      }
    }

    if (this._sources.size === 0) {
      this._isDone = true;
      this._flush();
    } else if (this._nextQueue.length > 0) {
      for (const s of this._sourcesToPoll) {
        this._issueNext(s);
      }
    }
  }

  private async _return(): Promise<IteratorResult<T, void>> {
    this._isDone = true;
    await Promise.all(
      Array.from(this._sources).map((source) => this._returnSource(source)),
    );
    this._flush();
    return { value: undefined, done: true };
  }

  private async _throw(error?: unknown): Promise<IteratorResult<T, void>> {
    this._isDone = true;
    await Promise.all(
      Array.from(this._sources).map((source) => this._returnSource(source)),
    );
    this._flush();
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    return Promise.reject(error);
  }

  private _flush(): void {
    for (const resolve of this._nextQueue) {
      resolve({ value: undefined, done: true });
    }
    this._nextQueue = [];
  }

  private async _returnSource(source: SimpleAsyncGenerator<T>): Promise<void> {
    await source.return?.(undefined);
  }
}

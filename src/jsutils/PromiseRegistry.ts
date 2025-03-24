import { promiseWithResolvers } from './promiseWithResolvers.js';

/**
 * @internal
 */
export class PromiseRegistry {
  private _pending: number;
  private _promise: Promise<void>;
  private _resolve: () => void;

  constructor() {
    this._pending = 0;

    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
    const { promise, resolve } = promiseWithResolvers<void>();
    this._promise = promise;
    this._resolve = resolve;
  }

  add(promise: Promise<void>): void {
    this._pending++;
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    promise.finally(() => {
      this._pending--;
      if (this._pending === 0) {
        this._resolve();
      }
    });
  }

  pending(): boolean {
    return this._pending > 0;
  }

  wait(): Promise<void> {
    return this._promise;
  }
}

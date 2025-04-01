import { expect } from 'chai';
import { beforeEach, describe, it } from 'mocha';

import { resolveOnNextTick } from '../../__testUtils__/resolveOnNextTick.js';

import { AsyncIterableRegistry } from '../AsyncIterableRegistry.js';
import type { SimpleAsyncGenerator } from '../SimpleAsyncGenerator.js';

function createSimpleAsyncGenerator<T>(
  values: Array<T>,
  delay = 10,
  initialDelay = 0,
): SimpleAsyncGenerator<T> {
  async function* gen() {
    await new Promise((res) => setTimeout(res, initialDelay));
    for (const v of values) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((res) => setTimeout(res, delay));
      yield v;
    }
  }

  return gen();
}

describe('AsyncIterableRegistry', () => {
  let registry: AsyncIterableRegistry<any>;
  let subscription: SimpleAsyncGenerator<any>;

  beforeEach(() => {
    registry = new AsyncIterableRegistry();
    subscription = registry.subscribe();
  });

  describe('subscribe()', () => {
    it('should implement the async iterator protocol', () => {
      expect(subscription).to.have.property('next').that.is.a('function');
      expect(subscription).to.have.property('return').that.is.a('function');
      expect(subscription).to.have.property('throw').that.is.a('function');
      expect(subscription[Symbol.asyncIterator]()).to.equal(subscription);
    });
  });

  describe('yielding values from a single source', () => {
    it('should yield values in order from an async generator added to the registry', async () => {
      const gen = createSimpleAsyncGenerator([1, 2, 3], 5);
      registry.add(gen);
      const res1 = await subscription.next();
      expect(res1).to.deep.equal({ value: 1, done: false });
      const res2 = await subscription.next();
      expect(res2).to.deep.equal({ value: 2, done: false });
      const res3 = await subscription.next();
      expect(res3).to.deep.equal({ value: 3, done: false });
      const res4 = await subscription.next();
      expect(res4).to.deep.equal({ value: undefined, done: true });
    });
  });

  describe('yielding values from multiple sources', () => {
    it('should yield interleaved values from multiple async generators added to the registry', async () => {
      const gen1 = createSimpleAsyncGenerator([1, 3, 5], 20, 0);
      const gen2 = createSimpleAsyncGenerator([2, 4, 6], 20, 15);
      registry.add(gen1);
      registry.add(gen2);
      const values: Array<number> = [];
      for (let i = 0; i < 6; i++) {
        // eslint-disable-next-line no-await-in-loop
        const res = await subscription.next();
        values.push(res.value);
      }
      expect(values).to.deep.equal([1, 2, 3, 4, 5, 6]);
      const res7 = await subscription.next();
      expect(res7).to.deep.equal({ value: undefined, done: true });
    });
  });

  describe('lazy evaluation', () => {
    it('should only call next on sources when the consumer calls next', async () => {
      let callCount = 0;
      async function* lazyGen() {
        while (true) {
          callCount++;
          yield callCount;
          // eslint-disable-next-line no-await-in-loop
          await resolveOnNextTick();
        }
      }
      registry.add(lazyGen());
      expect(callCount).to.equal(0);
      const res1 = await subscription.next();
      expect(res1).to.deep.equal({ value: 1, done: false });
      expect(callCount).to.equal(1);
      const res2 = await subscription.next();
      expect(res2).to.deep.equal({ value: 2, done: false });
      expect(callCount).to.equal(2);
    });
  });

  describe('buffering extra results', () => {
    it('should buffer extra results when produced and deliver them on subsequent next calls', async () => {
      const gen = createSimpleAsyncGenerator([10, 20, 30], 0);
      registry.add(gen);
      const res1 = await subscription.next();
      expect(res1).to.deep.equal({ value: 10, done: false });
      const res2 = await subscription.next();
      expect(res2).to.deep.equal({ value: 20, done: false });
      const res3 = await subscription.next();
      expect(res3).to.deep.equal({ value: 30, done: false });
      const res4 = await subscription.next();
      expect(res4).to.deep.equal({ value: undefined, done: true });
    });
  });

  describe('completion and flushing', () => {
    it('should complete and flush pending nextQueue when all sources are done', async () => {
      const gen = createSimpleAsyncGenerator([100], 5);
      registry.add(gen);
      const promise1 = subscription.next();
      const res1 = await promise1;
      expect(res1).to.deep.equal({ value: 100, done: false });
      const res2 = await subscription.next();
      expect(res2).to.deep.equal({ value: undefined, done: true });
    });
  });

  describe('termination via return()', () => {
    it('should call return() on all sources and flush pending consumers when return() is called', async () => {
      let returned1 = false;
      let returned2 = false;
      // eslint-disable-next-line @typescript-eslint/require-await
      async function* gen1() {
        try {
          yield 1;
        } finally {
          returned1 = true;
        }
      }
      // eslint-disable-next-line @typescript-eslint/require-await
      async function* gen2() {
        try {
          yield 2;
        } finally {
          returned2 = true;
        }
      }
      registry.add(gen1());
      registry.add(gen2());
      const res1 = await subscription.next();
      expect(res1.done).to.equal(false);
      const ret = await subscription.return();
      expect(ret).to.deep.equal({ value: undefined, done: true });
      expect(returned1).to.equal(true);
      expect(returned2).to.equal(true);
      const res2 = await subscription.next();
      expect(res2).to.deep.equal({ value: undefined, done: true });
    });
  });

  describe('termination via throw()', () => {
    it('should call return() on all sources, flush pending consumers, and reject when throw() is called', async () => {
      let returned = false;
      // eslint-disable-next-line @typescript-eslint/require-await
      async function* gen() {
        try {
          yield 1;
        } finally {
          returned = true;
        }
      }
      registry.add(gen());
      const res1 = await subscription.next();
      expect(res1.done).to.equal(false);
      try {
        await subscription.throw(new Error('Test error'));
      } catch (err: any) {
        expect(err).to.be.an('error');
        expect(err.message).to.equal('Test error');
      }
      expect(returned).to.equal(true);
      const res2 = await subscription.next();
      expect(res2).to.deep.equal({ value: undefined, done: true });
    });
  });

  describe('concurrent next() calls', () => {
    it('should resolve two concurrent next() calls correctly', async () => {
      const gen = createSimpleAsyncGenerator([1, 2, 3], 10);
      registry.add(gen);
      const promise1 = subscription.next();
      const promise2 = subscription.next();
      const [result1, result2] = await Promise.all([promise1, promise2]);
      expect(result1).to.deep.equal({ value: 1, done: false });
      expect(result2).to.deep.equal({ value: 2, done: false });
      const result3 = await subscription.next();
      expect(result3).to.deep.equal({ value: 3, done: false });
      const result4 = await subscription.next();
      expect(result4).to.deep.equal({ value: undefined, done: true });
    });
  });
});

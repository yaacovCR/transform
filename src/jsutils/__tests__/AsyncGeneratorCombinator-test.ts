import { expect } from 'chai';
import { describe, it } from 'mocha';

import { expectPromise } from '../../__testUtils__/expectPromise.js';

import { AsyncGeneratorCombinator } from '../AsyncGeneratorCombinator.js';
import type { SimpleAsyncGenerator } from '../SimpleAsyncGenerator.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function* createGenerator(
  id: string,
  values: Array<string | Error>,
  delayMs = 0,
): SimpleAsyncGenerator<string> {
  for (const value of values) {
    if (delayMs > 0) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(delayMs);
    }
    if (value instanceof Error) {
      throw value;
    }
    yield `${id}-${value}`;
  }
}

async function collectResults<T>(
  combinator: AsyncGeneratorCombinator<T>,
): Promise<Array<T>> {
  const results: Array<T> = [];
  for await (const result of combinator) {
    results.push(result);
  }
  return results;
}

interface MonitoredGeneratorState {
  returned: boolean;
  threw: boolean;
  nextCalls: number;
}

function withState(originalGenerator: SimpleAsyncGenerator<string>): {
  generator: SimpleAsyncGenerator<string>;
  state: MonitoredGeneratorState;
} {
  const state: MonitoredGeneratorState = {
    returned: false,
    threw: false,
    nextCalls: 0,
  };

  return {
    generator: {
      next: () => {
        state.nextCalls++;
        return originalGenerator.next();
      },
      return: () => {
        state.returned = true;
        return originalGenerator.return();
      },
      throw: (error?: unknown) => {
        state.threw = true;
        return originalGenerator.throw(error);
      },
      /* c8 ignore next 3 */
      [Symbol.asyncIterator]() {
        return this;
      },
    },
    state,
  };
}

describe('AsyncGeneratorCombinator', () => {
  it('behaves like a single generator when only one is added', async () => {
    const combinator = new AsyncGeneratorCombinator<string>();
    const generator = createGenerator('A', ['1', '2']);
    combinator.add(generator);

    const results = await collectResults(combinator);
    expect(results).to.deep.equal(['A-1', 'A-2']);
  });

  it('handles adding a generator after next() is called and waiting', async () => {
    const combinator = new AsyncGeneratorCombinator<string>();

    const nextPromise = combinator.next();

    const genA = createGenerator('A', ['1', '2'], 5);
    combinator.add(genA);

    const result1 = await nextPromise;
    expect(result1).to.deep.equal({ value: 'A-1', done: false });

    const result2 = await combinator.next();
    expect(result2).to.deep.equal({ value: 'A-2', done: false });

    const finalResult = await combinator.next();
    expect(finalResult).to.deep.equal({ value: undefined, done: true });
  });

  it('interleaves results from multiple generators based on availability', async () => {
    const combinator = new AsyncGeneratorCombinator<string>();
    const genA = createGenerator('A', ['1', '3'], 10); // A yields slower
    const genB = createGenerator('B', ['2', '4'], 5); // B yields faster

    combinator.add(genA);
    combinator.add(genB);

    const results = await collectResults(combinator);

    expect(results).to.have.lengthOf(4);
    expect(results).to.include.members(['A-1', 'A-3', 'B-2', 'B-4']);
    // Check relative order where possible
    expect(results.indexOf('B-2')).to.be.lessThan(results.indexOf('A-1'));
    expect(results.indexOf('B-4')).to.be.lessThan(results.indexOf('A-3'));
  });

  it('does not poll generators until next() is called', async () => {
    const { generator: genA, state: stateA } = withState(
      createGenerator('A', ['1']),
    );

    const combinator = new AsyncGeneratorCombinator<string>();
    combinator.add(genA);

    expect(stateA.nextCalls).to.equal(0);

    const result1 = await combinator.next();

    expect(result1).to.deep.equal({ value: 'A-1', done: false });
    expect(stateA.nextCalls).to.equal(1);
  });

  it('does not re-poll a generator while its previous next() call is pending', async () => {
    const { generator: genA, state: stateA } = withState(
      createGenerator('A', ['1']),
    );
    const { generator: genB, state: stateB } = withState(
      createGenerator('B', ['1'], 10),
    );

    const combinator = new AsyncGeneratorCombinator<string>();
    combinator.add(genA);
    combinator.add(genB);

    expect(stateA.nextCalls).to.equal(0);
    expect(stateB.nextCalls).to.equal(0);

    const result1 = await combinator.next();

    expect(result1).to.deep.equal({ value: 'A-1', done: false });
    expect(stateA.nextCalls).to.equal(1);
    expect(stateB.nextCalls).to.equal(1);

    const result2 = await combinator.next();

    expect(result2).to.deep.equal({ value: 'B-1', done: false });
    // A gets polled again after yielding, B is still pending its first poll
    expect(stateA.nextCalls).to.equal(2);
    expect(stateB.nextCalls).to.equal(1);
  });

  it('does not poll any generators if a result is available', async () => {
    const { generator: genA, state: stateA } = withState(
      createGenerator('A', ['1']),
    );
    const { generator: genB, state: stateB } = withState(
      createGenerator('B', ['1'], 10),
    );

    const combinator = new AsyncGeneratorCombinator<string>();
    combinator.add(genA);
    combinator.add(genB);

    expect(stateA.nextCalls).to.equal(0);
    expect(stateB.nextCalls).to.equal(0);

    const result1 = await combinator.next();

    expect(result1).to.deep.equal({ value: 'A-1', done: false });
    expect(stateA.nextCalls).to.equal(1);
    expect(stateB.nextCalls).to.equal(1);

    // Wait for B to yield its result into the queue
    await sleep(10);
    const result2 = await combinator.next();

    expect(result2).to.deep.equal({ value: 'B-1', done: false });
    // Neither generator should be polled again when retrieving B-1 from the queue
    expect(stateA.nextCalls).to.equal(1);
    expect(stateB.nextCalls).to.equal(1);
  });

  it('does not poll any generators if an error is available', async () => {
    const { generator: genA, state: stateA } = withState(
      createGenerator('A', ['1']),
    );
    const { generator: genB, state: stateB } = withState(
      createGenerator('B', [new Error('Oops')], 10),
    );

    const combinator = new AsyncGeneratorCombinator<string>();
    combinator.add(genA);
    combinator.add(genB);

    expect(stateA.nextCalls).to.equal(0);
    expect(stateB.nextCalls).to.equal(0);

    const result1 = await combinator.next();

    expect(result1).to.deep.equal({ value: 'A-1', done: false });
    expect(stateA.nextCalls).to.equal(1);
    expect(stateB.nextCalls).to.equal(1);

    // Wait for B to throw its error into the queue
    await sleep(10);
    await expectPromise(combinator.next()).toRejectWith('Oops');

    // Neither generator should be polled again when retrieving the error from the queue
    expect(stateA.nextCalls).to.equal(1);
    expect(stateB.nextCalls).to.equal(1);
  });

  it('continues yielding results after one generator finishes', async () => {
    const combinator = new AsyncGeneratorCombinator<string>();
    const genA = createGenerator('A', ['1']);
    const genB = createGenerator('B', ['2', '3'], 5);

    combinator.add(genA);
    combinator.add(genB);

    const results = await collectResults(combinator);
    expect(results).to.have.lengthOf(3);
    expect(results).to.include.members(['A-1', 'B-2', 'B-3']);
  });

  it('finishes only after all generators are done', async () => {
    const combinator = new AsyncGeneratorCombinator<string>();
    const genA = createGenerator('A', ['1'], 5);
    const genB = createGenerator('B', ['2'], 10);

    combinator.add(genA);
    combinator.add(genB);

    await collectResults(combinator);

    const finalResult = await combinator.next();
    expect(finalResult).to.deep.equal({ value: undefined, done: true });
  });

  it('handles adding a generator while iterating', async () => {
    const combinator = new AsyncGeneratorCombinator<string>();
    const genA = createGenerator('A', ['1', '3'], 10);
    const genB = createGenerator('B', ['2', '4'], 5);

    combinator.add(genA);

    const results: Array<string> = [];
    let count = 0;
    for await (const result of combinator) {
      results.push(result);
      count++;
      if (count === 1) {
        combinator.add(genB);
      }
    }

    expect(results).to.have.lengthOf(4);
    expect(results).to.include.members(['A-1', 'A-3', 'B-2', 'B-4']);
    // A-1 must be first as B wasn't added yet
    expect(results[0]).to.equal('A-1');
  });

  it('calls return on underlying generators', async () => {
    const { generator: genA, state: stateA } = withState(
      createGenerator('A', ['1'], 5),
    );
    const { generator: genB, state: stateB } = withState(
      createGenerator('B', ['1'], 10),
    );

    const combinator = new AsyncGeneratorCombinator<string>();
    combinator.add(genA);
    combinator.add(genB);

    await combinator.next();

    const returnResult = await combinator.return();

    expect(returnResult).to.deep.equal({ value: undefined, done: true });
    expect(stateA.returned).to.equal(true);
    expect(stateB.returned).to.equal(true);

    const finalResult = await combinator.next();
    expect(finalResult).to.deep.equal({ value: undefined, done: true });
  });

  it('calls throw on underlying generators and re-throws', async () => {
    const errorToThrow = new Error('Oops');
    const { generator: genA, state: stateA } = withState(
      createGenerator('A', ['1'], 5),
    );
    const { generator: genB, state: stateB } = withState(
      createGenerator('B', ['1'], 10),
    );

    const combinator = new AsyncGeneratorCombinator<string>();
    combinator.add(genA);
    combinator.add(genB);

    await combinator.next();

    await expectPromise(combinator.throw(errorToThrow)).toRejectWith('Oops');

    expect(stateA.threw).to.equal(true);
    expect(stateB.threw).to.equal(true);

    const finalResult = await combinator.next();
    expect(finalResult).to.deep.equal({ value: undefined, done: true });
  });

  it('handles generators that complete immediately', async () => {
    const combinator = new AsyncGeneratorCombinator<string>();
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    async function* emptyGenerator() {} // No yields
    combinator.add(emptyGenerator());
    combinator.add(createGenerator('A', ['1']));

    const results = await collectResults(combinator);
    expect(results).to.deep.equal(['A-1']);
  });

  it('handles errors from one generator while others continue (error is surfaced)', async () => {
    const errorToThrow = new Error('Oops');

    const combinator = new AsyncGeneratorCombinator<string>();
    combinator.add(createGenerator('A', ['1', '2', '3'], 8));
    combinator.add(createGenerator('B', ['1', errorToThrow, '3'], 5));

    const results: Array<string> = [];
    let caughtError: unknown;
    try {
      for await (const result of combinator) {
        results.push(result);
      } /* c8 ignore start */
    } /* c8 ignore stop */ catch (err) {
      caughtError = err;
    }

    expect(caughtError).to.equal(errorToThrow);
    expect(results).to.include.members(['A-1', 'B-1']);
    // Other results might or might not arrive depending on timing
  });

  it('handles concurrent calls to next()', async () => {
    const combinator = new AsyncGeneratorCombinator<string>();
    const genA = createGenerator('A', ['1', '2', '3'], 5);
    combinator.add(genA);

    const promise1 = combinator.next();
    const promise2 = combinator.next();
    const promise3 = combinator.next();

    const [result1, result2, result3] = await Promise.all([
      promise1,
      promise2,
      promise3,
    ]);

    expect(result1).to.deep.equal({ value: 'A-1', done: false });
    expect(result2).to.deep.equal({ value: 'A-2', done: false });
    expect(result3).to.deep.equal({ value: 'A-3', done: false });

    const finalResult = await combinator.next();
    expect(finalResult).to.deep.equal({ value: undefined, done: true });
  });
});

import { expect } from 'chai';
import { describe, it } from 'mocha';

import { PromiseRegistry } from '../PromiseRegistry.js';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('PromiseRegistry', () => {
  it('should report not pending initially', () => {
    const registry = new PromiseRegistry();
    expect(registry.pending()).to.equal(false);
  });

  it('should resolve wait() after a single promise is added and resolves', async () => {
    const registry = new PromiseRegistry();
    let resolved = false;

    const p = delay(50).then(() => {
      resolved = true;
    });
    registry.add(p);

    expect(registry.pending()).to.equal(true);

    await registry.wait();
    expect(resolved).to.equal(true);
    expect(registry.pending()).to.equal(false);
  });

  it('should wait for multiple promises to resolve', async () => {
    const registry = new PromiseRegistry();
    const order: Array<string> = [];

    const p1 = delay(30).then(() => {
      order.push('p1');
    });
    const p2 = delay(60).then(() => {
      order.push('p2');
    });
    registry.add(p1);
    registry.add(p2);

    expect(registry.pending()).to.equal(true);
    await registry.wait();
    expect(order).to.deep.equal(['p1', 'p2']);
    expect(registry.pending()).to.equal(false);
  });

  it('should delay resolution of wait() if new promises are added after wait() is called', async () => {
    const registry = new PromiseRegistry();
    let firstResolved = false;
    let secondResolved = false;

    const p1 = delay(30).then(() => {
      firstResolved = true;
    });
    registry.add(p1);

    const waitPromise = registry.wait();

    setTimeout(() => {
      const p2 = delay(50).then(() => {
        secondResolved = true;
      });
      registry.add(p2);
    }, 10);

    await waitPromise;

    expect(firstResolved).to.equal(true);
    expect(secondResolved).to.equal(true);
    expect(registry.pending()).to.equal(false);
  });
});

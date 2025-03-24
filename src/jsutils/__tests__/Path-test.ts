import { expect } from 'chai';
import { describe, it } from 'mocha';

import { addPath, pathToArray } from '../Path.js';

describe('Path', () => {
  it('can create a Path', () => {
    const first = addPath(undefined, 1, false);

    expect(first).to.deep.equal({
      prev: undefined,
      key: 1,
      nullable: false,
    });
  });

  it('can add a new key to an existing Path', () => {
    const first = addPath(undefined, 1, false);
    const second = addPath(first, 'two', true);

    expect(second).to.deep.equal({
      prev: first,
      key: 'two',
      nullable: true,
    });
  });

  it('can convert a Path to an array of its keys', () => {
    const root = addPath(undefined, 0, false);
    const first = addPath(root, 'one', true);
    const second = addPath(first, 2, false);

    const path = pathToArray(second);
    expect(path).to.deep.equal([0, 'one', 2]);
  });
});

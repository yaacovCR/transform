import { GraphQLError } from 'graphql';
import { describe, it } from 'mocha';

import { expectJSON } from '../../__testUtils__/expectJSON.js';

import { embedErrors } from '../embedErrors.js';

describe('embedErrors', () => {
  it('can embed an error', () => {
    const error = new GraphQLError('error message', { path: ['a', 'b', 'c'] });
    const data = { a: { b: { c: null } } };
    embedErrors(data, [error]);
    expectJSON(data).toDeepEqual({
      a: { b: { c: new AggregateError([error]) } },
    });
  });

  it('can embed a bubbled error', () => {
    const error = new GraphQLError('error message', {
      path: ['a', 'b', 'c', 'd'],
    });
    const data = { a: { b: { c: null } } };
    embedErrors(data, [error]);
    expectJSON(data).toDeepEqual({
      a: { b: { c: new AggregateError([error]) } },
    });
  });

  it('can embed multiple errors', () => {
    const error1 = new GraphQLError('error message 1', {
      path: ['a', 'b', 'c'],
    });
    const error2 = new GraphQLError('error message 2', {
      path: ['a', 'b', 'c'],
    });
    const data = { a: { b: { c: null } } };
    embedErrors(data, [error1, error2]);
    expectJSON(data).toDeepEqual({
      a: { b: { c: new AggregateError([error1, error2]) } },
    });
  });

  it('returns errors with no path', () => {
    const error = new GraphQLError('error message');
    const data = { a: { b: { c: null } } };
    embedErrors(data, [error]);
    expectJSON(data).toDeepEqual(data);
  });

  it('returns errors with empty path', () => {
    const error = new GraphQLError('error message', { path: [] });
    const data = { a: { b: { c: null } } };
    embedErrors(data, [error]);
    expectJSON(data).toDeepEqual(data);
  });

  it('returns errors with invalid numeric path', () => {
    const error = new GraphQLError('error message', {
      path: ['a', 0],
    });
    const data = { a: { b: { c: null } } };
    embedErrors(data, [error]);
    expectJSON(data).toDeepEqual(data);
  });

  it('returns errors with invalid non-terminating numeric path segment', () => {
    const error = new GraphQLError('error message', {
      path: ['a', 0, 'c'],
    });
    const data = { a: { b: { c: null } } };
    embedErrors(data, [error]);
    expectJSON(data).toDeepEqual(data);
  });

  it('returns errors with invalid string path', () => {
    const error = new GraphQLError('error message', {
      path: ['a', 'b'],
    });
    const data = { a: [{ b: { c: null } }] };
    embedErrors(data, [error]);
    expectJSON(data).toDeepEqual(data);
  });

  it('returns errors with invalid non-terminating string path segment', () => {
    const error = new GraphQLError('error message', {
      path: ['a', 'b', 'c'],
    });
    const data = { a: [{ b: { c: null } }] };
    embedErrors(data, [error]);
    expectJSON(data).toDeepEqual(data);
  });

  it('returns errors with invalid path without null', () => {
    const error = new GraphQLError('error message', {
      path: ['a', 'b', 'c', 'd'],
    });
    const data = { a: { b: { c: 1 } } };
    embedErrors(data, [error]);
    expectJSON(data).toDeepEqual(data);
  });

  it('returns errors with invalid path without null with invalid non-terminating path segment', () => {
    const error = new GraphQLError('error message', {
      path: ['a', 'b', 'c', 'd', 'e'],
    });
    const data = { a: { b: { c: 1 } } };
    embedErrors(data, [error]);
    expectJSON(data).toDeepEqual(data);
  });
});

import { assert } from 'chai';
import type {
  DocumentNode,
  InitialIncrementalExecutionResult,
  SubsequentIncrementalExecutionResult,
} from 'graphql';
import {
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  Kind,
  parse,
} from 'graphql';
import { describe, it } from 'mocha';

import { expectJSON } from '../../__testUtils__/expectJSON.js';

import { invariant } from '../../jsutils/invariant.js';
import { isPromise } from '../../jsutils/isPromise.js';
import type { ObjMap } from '../../jsutils/ObjMap.js';

import type { Transformers } from '../buildTransformationContext.js';
import { transformResult } from '../transformResult.js';

const queryType: GraphQLObjectType = new GraphQLObjectType({
  name: 'Query',
  fields: () => ({
    someField: { type: GraphQLString },
    anotherField: { type: GraphQLString },
    nonNullableField: { type: new GraphQLNonNull(GraphQLString) },
    someObjectField: { type: queryType },
    someListField: { type: new GraphQLList(GraphQLString) },
    someListOfNonNullableItems: {
      type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
    },
  }),
});

const schema = new GraphQLSchema({
  query: queryType,
});

async function complete(
  document: DocumentNode,
  rootValue: ObjMap<unknown>,
  transformers?: Partial<Transformers>,
) {
  const result = transformResult(
    {
      schema,
      document,
      rootValue,
    },
    transformers,
  );

  invariant(!isPromise(result));
  invariant('initialResult' in result);

  const results: Array<
    InitialIncrementalExecutionResult | SubsequentIncrementalExecutionResult
  > = [result.initialResult];
  for await (const patch of result.subsequentResults) {
    results.push(patch);
  }
  return results;
}

describe('transformResult', () => {
  it('handles invalid document', () => {
    const result = transformResult({
      schema,
      document: { kind: Kind.DOCUMENT, definitions: [] },
    });

    expectJSON(result).toDeepEqual({
      errors: [
        {
          message: 'Must provide an operation.',
        },
      ],
    });
  });

  describe('handles non-nullable fields from original executor', () => {
    it('handles non-nullable root field', () => {
      const result = transformResult({
        schema,
        document: parse('{ nonNullableField }'),
        rootValue: { someField: null },
      });

      expectJSON(result).toDeepEqual({
        data: null,
        errors: [
          {
            message:
              'Cannot return null for non-nullable field Query.nonNullableField.',
            locations: [{ line: 1, column: 3 }],
            path: ['nonNullableField'],
          },
        ],
      });
    });

    it('handles deferred payloads', async () => {
      const document = parse(`
        query {
          someObjectField {
            ... @defer { someField }
            ... @defer { anotherField }
          }
        }
      `);
      const result = await complete(document, {
        someObjectField: {
          someField: 'someField',
          anotherField: 'anotherField',
        },
      });
      expectJSON(result).toDeepEqual([
        {
          data: { someObjectField: {} },
          pending: [
            { id: '0', path: ['someObjectField'] },
            { id: '1', path: ['someObjectField'] },
          ],
          hasNext: true,
        },
        {
          incremental: [
            {
              data: { someField: 'someField' },
              id: '0',
            },
            {
              data: { anotherField: 'anotherField' },
              id: '1',
            },
          ],
          completed: [{ id: '0' }, { id: '1' }],
          hasNext: false,
        },
      ]);
    });

    it('handles null-bubbling within deferred payloads', async () => {
      const document = parse(`
        query {
          someObjectField {
            ... @defer { someField anotherField }
            ... @defer { someField nonNullableField }
          }
        }
      `);
      const result = await complete(document, {
        someObjectField: {
          someField: 'someField',
          anotherField: 'anotherField',
          nonNullableField: null,
        },
      });
      expectJSON(result).toDeepEqual([
        {
          data: { someObjectField: {} },
          pending: [
            { id: '0', path: ['someObjectField'] },
            { id: '1', path: ['someObjectField'] },
          ],
          hasNext: true,
        },
        {
          incremental: [
            {
              data: { someField: 'someField' },
              id: '0',
            },
            {
              data: { anotherField: 'anotherField' },
              id: '0',
            },
          ],
          completed: [
            { id: '0' },
            {
              id: '1',
              errors: [
                {
                  message:
                    'Cannot return null for non-nullable field Query.nonNullableField.',
                  locations: [{ line: 5, column: 36 }],
                  path: ['someObjectField', 'nonNullableField'],
                },
              ],
            },
          ],
          hasNext: false,
        },
      ]);
    });

    it('handles a stream', async () => {
      const document = parse('{ someListField @stream }');
      const result = await complete(document, {
        someListField: ['a', 'b', 'c'],
      });
      expectJSON(result).toDeepEqual([
        {
          data: { someListField: [] },
          pending: [{ id: '0', path: ['someListField'] }],
          hasNext: true,
        },
        {
          incremental: [
            {
              items: ['a', 'b', 'c'],
              id: '0',
            },
          ],
          completed: [{ id: '0' }],
          hasNext: false,
        },
      ]);
    });

    it('handles null bubbling within a stream', async () => {
      const document = parse('{ someListOfNonNullableItems @stream }');
      const result = await complete(document, {
        someListOfNonNullableItems: ['a', 'b', 'c'],
      });
      expectJSON(result).toDeepEqual([
        {
          data: { someListOfNonNullableItems: [] },
          pending: [{ id: '0', path: ['someListOfNonNullableItems'] }],
          hasNext: true,
        },
        {
          incremental: [
            {
              items: ['a', 'b', 'c'],
              id: '0',
            },
          ],
          completed: [{ id: '0' }],
          hasNext: false,
        },
      ]);
    });
  });

  describe('handles synchronously transformed field values', () => {
    describe('handles transformed field values', () => {
      it('handles transformation', () => {
        const result = transformResult(
          {
            schema,
            document: parse('{ someField }'),
            rootValue: { someField: 'someField' },
          },
          {
            objectFieldTransformers: {
              Query: { someField: () => 'transformed' },
            },
          },
        );

        expectJSON(result).toDeepEqual({
          data: { someField: 'transformed' },
        });
      });

      it('handles transformation returning null', () => {
        const result = transformResult(
          {
            schema,
            document: parse('{ someField }'),
            rootValue: { someField: 'someField' },
          },
          {
            objectFieldTransformers: {
              Query: { someField: () => null },
            },
          },
        );

        expectJSON(result).toDeepEqual({ data: { someField: null } });
      });

      it('handles transformation throwing an error', () => {
        const result = transformResult(
          {
            schema,
            document: parse('{ someField }'),
            rootValue: { someField: 'someField' },
          },
          {
            objectFieldTransformers: {
              Query: {
                someField: () => {
                  throw new Error('Oops');
                },
              },
            },
          },
        );

        expectJSON(result).toDeepEqual({
          data: { someField: null },
          errors: [
            {
              message: 'Oops',
              path: ['someField'],
              locations: [{ line: 1, column: 3 }],
            },
          ],
        });
      });

      it('handles transformation returning an error', () => {
        const result = transformResult(
          {
            schema,
            document: parse('{ someField }'),
            rootValue: { someField: 'someField' },
          },
          {
            objectFieldTransformers: {
              Query: {
                someField: () => new Error('Oops'),
              },
            },
          },
        );

        expectJSON(result).toDeepEqual({
          data: { someField: null },
          errors: [
            {
              message: 'Oops',
              path: ['someField'],
              locations: [{ line: 1, column: 3 }],
            },
          ],
        });
      });
    });

    describe('handles transformed non-nullable field values', () => {
      it('handles transformation', () => {
        const result = transformResult(
          {
            schema,
            document: parse('{ nonNullableField }'),
            rootValue: { nonNullableField: 'nonNullableField' },
          },
          {
            objectFieldTransformers: {
              Query: {
                nonNullableField: () => 'transformed',
              },
            },
          },
        );

        expectJSON(result).toDeepEqual({
          data: { nonNullableField: 'transformed' },
        });
      });

      it('handles transformation returning null', () => {
        const result = transformResult(
          {
            schema,
            document: parse('{ nonNullableField }'),
            rootValue: { nonNullableField: 'nonNullableField' },
          },
          {
            objectFieldTransformers: {
              Query: {
                nonNullableField: () => null,
              },
            },
          },
        );

        expectJSON(result).toDeepEqual({
          data: null,
          errors: [
            {
              message:
                'Cannot return null for non-nullable field Query.nonNullableField.',
              path: ['nonNullableField'],
              locations: [{ line: 1, column: 3 }],
            },
          ],
        });
      });

      it('handles transformation throwing an error', () => {
        const result = transformResult(
          {
            schema,
            document: parse('{ nonNullableField }'),
            rootValue: { nonNullableField: 'nonNullableField' },
          },
          {
            objectFieldTransformers: {
              Query: {
                nonNullableField: () => {
                  throw new Error('Oops');
                },
              },
            },
          },
        );

        expectJSON(result).toDeepEqual({
          data: null,
          errors: [
            {
              message: 'Oops',
              path: ['nonNullableField'],
              locations: [{ line: 1, column: 3 }],
            },
          ],
        });
      });

      it('handles transformation returning an error', () => {
        const result = transformResult(
          {
            schema,
            document: parse('{ nonNullableField }'),
            rootValue: { nonNullableField: 'nonNullableField' },
          },
          {
            objectFieldTransformers: {
              Query: {
                nonNullableField: () => new Error('Oops'),
              },
            },
          },
        );

        expectJSON(result).toDeepEqual({
          data: null,
          errors: [
            {
              message: 'Oops',
              path: ['nonNullableField'],
              locations: [{ line: 1, column: 3 }],
            },
          ],
        });
      });
    });

    describe('handles transformations of deferred fragments', () => {
      it('handles transformation within a deferred payload', async () => {
        const document = parse(`
          query {
            someObjectField {
              ... @defer { someField }
            }
          }
        `);
        const result = await complete(
          document,
          {
            someObjectField: {
              someField: 'someField',
            },
          },
          {
            objectFieldTransformers: {
              Query: {
                someField: () => 'transformed',
              },
            },
          },
        );
        expectJSON(result).toDeepEqual([
          {
            data: { someObjectField: {} },
            pending: [{ id: '0', path: ['someObjectField'] }],
            hasNext: true,
          },
          {
            incremental: [
              {
                data: { someField: 'transformed' },
                id: '0',
              },
            ],
            completed: [{ id: '0' }],
            hasNext: false,
          },
        ]);
      });

      it('handles transformation within a deferred payload causing the fragment to fail', async () => {
        const document = parse(`
          query {
            someObjectField {
              ... @defer { nonNullableField }
            }
          }
        `);
        const result = await complete(
          document,
          {
            someObjectField: {
              nonNullableField: 'nonNullableField',
            },
          },
          {
            objectFieldTransformers: {
              Query: {
                nonNullableField: () => null,
              },
            },
          },
        );
        expectJSON(result).toDeepEqual([
          {
            data: { someObjectField: {} },
            pending: [{ id: '0', path: ['someObjectField'] }],
            hasNext: true,
          },
          {
            completed: [
              {
                id: '0',
                errors: [
                  {
                    message:
                      'Cannot return null for non-nullable field Query.nonNullableField.',
                    path: ['someObjectField', 'nonNullableField'],
                    locations: [{ line: 4, column: 28 }],
                  },
                ],
              },
            ],
            hasNext: false,
          },
        ]);
      });
    });
  });

  describe('handles asynchronously transformed field values', () => {
    describe('handles transformed field values', () => {
      it('handles transformation', async () => {
        let result = transformResult(
          {
            schema,
            document: parse('{ someField }'),
            rootValue: { someField: 'someField' },
          },
          {
            objectFieldTransformers: {
              Query: {
                someField: () => Promise.resolve('transformed'),
              },
            },
          },
        );

        assert(isPromise(result));

        result = await result;

        expectJSON(result).toDeepEqual({
          data: { someField: 'transformed' },
        });
      });

      it('handles transformation returning null', async () => {
        let result = transformResult(
          {
            schema,
            document: parse('{ someField }'),
            rootValue: { someField: 'someField' },
          },
          {
            objectFieldTransformers: {
              Query: {
                someField: () => Promise.resolve(null),
              },
            },
          },
        );

        assert(isPromise(result));

        result = await result;

        expectJSON(result).toDeepEqual({ data: { someField: null } });
      });

      it('handles transformation throwing an error', async () => {
        let result = transformResult(
          {
            schema,
            document: parse('{ someField }'),
            rootValue: { someField: 'someField' },
          },
          {
            objectFieldTransformers: {
              Query: {
                someField: () => Promise.reject(new Error('Oops')),
              },
            },
          },
        );

        assert(isPromise(result));

        result = await result;

        expectJSON(result).toDeepEqual({
          data: { someField: null },
          errors: [
            {
              message: 'Oops',
              path: ['someField'],
              locations: [{ line: 1, column: 3 }],
            },
          ],
        });
      });

      it('handles transformation returning an error', async () => {
        let result = transformResult(
          {
            schema,
            document: parse('{ someField }'),
            rootValue: { someField: 'someField' },
          },
          {
            objectFieldTransformers: {
              Query: {
                someField: () => Promise.resolve(new Error('Oops')),
              },
            },
          },
        );

        assert(isPromise(result));

        result = await result;

        expectJSON(result).toDeepEqual({
          data: { someField: null },
          errors: [
            {
              message: 'Oops',
              path: ['someField'],
              locations: [{ line: 1, column: 3 }],
            },
          ],
        });
      });
    });

    describe('handles transformed non-nullable field values', () => {
      it('handles transformation', async () => {
        let result = transformResult(
          {
            schema,
            document: parse('{ nonNullableField }'),
            rootValue: { nonNullableField: 'nonNullableField' },
          },
          {
            objectFieldTransformers: {
              Query: {
                nonNullableField: () => Promise.resolve('transformed'),
              },
            },
          },
        );

        assert(isPromise(result));

        result = await result;

        expectJSON(result).toDeepEqual({
          data: { nonNullableField: 'transformed' },
        });
      });

      it('handles transformation returning null', async () => {
        let result = transformResult(
          {
            schema,
            document: parse('{ nonNullableField }'),
            rootValue: { nonNullableField: 'nonNullableField' },
          },
          {
            objectFieldTransformers: {
              Query: {
                nonNullableField: () => Promise.resolve(null),
              },
            },
          },
        );

        assert(isPromise(result));

        result = await result;

        expectJSON(result).toDeepEqual({
          data: null,
          errors: [
            {
              message:
                'Cannot return null for non-nullable field Query.nonNullableField.',
              path: ['nonNullableField'],
              locations: [{ line: 1, column: 3 }],
            },
          ],
        });
      });

      it('handles transformation throwing an error', async () => {
        let result = transformResult(
          {
            schema,
            document: parse('{ nonNullableField }'),
            rootValue: { nonNullableField: 'nonNullableField' },
          },
          {
            objectFieldTransformers: {
              Query: {
                nonNullableField: () => Promise.reject(new Error('Oops')),
              },
            },
          },
        );

        assert(isPromise(result));

        result = await result;

        expectJSON(result).toDeepEqual({
          data: null,
          errors: [
            {
              message: 'Oops',
              path: ['nonNullableField'],
              locations: [{ line: 1, column: 3 }],
            },
          ],
        });
      });

      it('handles transformation returning an error', async () => {
        let result = transformResult(
          {
            schema,
            document: parse('{ nonNullableField }'),
            rootValue: { nonNullableField: 'nonNullableField' },
          },
          {
            objectFieldTransformers: {
              Query: {
                nonNullableField: () => Promise.resolve(new Error('Oops')),
              },
            },
          },
        );

        assert(isPromise(result));

        result = await result;

        expectJSON(result).toDeepEqual({
          data: null,
          errors: [
            {
              message: 'Oops',
              path: ['nonNullableField'],
              locations: [{ line: 1, column: 3 }],
            },
          ],
        });
      });
    });

    describe('handles transformations of deferred fragments', () => {
      it('handles transformation within a deferred payload', async () => {
        const document = parse(`
          query {
            someObjectField {
              ... @defer { someField }
            }
          }
        `);
        const result = await complete(
          document,
          {
            someObjectField: {
              someField: 'someField',
            },
          },
          {
            objectFieldTransformers: {
              Query: {
                someField: () => Promise.resolve('transformed'),
              },
            },
          },
        );
        expectJSON(result).toDeepEqual([
          {
            data: { someObjectField: {} },
            pending: [{ id: '0', path: ['someObjectField'] }],
            hasNext: true,
          },
          {
            incremental: [
              {
                data: { someField: 'transformed' },
                id: '0',
              },
            ],
            completed: [{ id: '0' }],
            hasNext: false,
          },
        ]);
      });

      it('handles transformation within a deferred payload causing the fragment to fail', async () => {
        const document = parse(`
          query {
            someObjectField {
              ... @defer { nonNullableField }
            }
          }
        `);
        const result = await complete(
          document,
          {
            someObjectField: {
              nonNullableField: 'nonNullableField',
            },
          },
          {
            objectFieldTransformers: {
              Query: {
                nonNullableField: () => Promise.resolve(null),
              },
            },
          },
        );
        expectJSON(result).toDeepEqual([
          {
            data: { someObjectField: {} },
            pending: [{ id: '0', path: ['someObjectField'] }],
            hasNext: true,
          },
          {
            completed: [
              {
                id: '0',
                errors: [
                  {
                    message:
                      'Cannot return null for non-nullable field Query.nonNullableField.',
                    path: ['someObjectField', 'nonNullableField'],
                    locations: [{ line: 4, column: 28 }],
                  },
                ],
              },
            ],
            hasNext: false,
          },
        ]);
      });
    });
  });

  describe('handles synchronously transformed leaf values', () => {
    describe('handles transformed leaf values', () => {
      it('handles transformation', () => {
        const result = transformResult(
          {
            schema,
            document: parse('{ someField }'),
            rootValue: { someField: 'someField' },
          },
          { leafTransformers: { String: () => 'transformed' } },
        );

        expectJSON(result).toDeepEqual({
          data: { someField: 'transformed' },
        });
      });

      it('handles transformation returning null', () => {
        const result = transformResult(
          {
            schema,
            document: parse('{ someField }'),
            rootValue: { someField: 'someField' },
          },
          { leafTransformers: { String: () => null } },
        );

        expectJSON(result).toDeepEqual({ data: { someField: null } });
      });

      it('handles transformation throwing an error', () => {
        const result = transformResult(
          {
            schema,
            document: parse('{ someField }'),
            rootValue: { someField: 'someField' },
          },
          {
            leafTransformers: {
              String: () => {
                throw new Error('Oops');
              },
            },
          },
        );

        expectJSON(result).toDeepEqual({
          data: { someField: null },
          errors: [
            {
              message: 'Oops',
              path: ['someField'],
              locations: [{ line: 1, column: 3 }],
            },
          ],
        });
      });

      it('handles transformation returning an error', () => {
        const result = transformResult(
          {
            schema,
            document: parse('{ someField }'),
            rootValue: { someField: 'someField' },
          },
          {
            leafTransformers: {
              String: () => new Error('Oops'),
            },
          },
        );

        expectJSON(result).toDeepEqual({
          data: { someField: null },
          errors: [
            {
              message: 'Oops',
              path: ['someField'],
              locations: [{ line: 1, column: 3 }],
            },
          ],
        });
      });
    });

    describe('handles transformed non-nullable leaf values', () => {
      it('handles transformation', () => {
        const result = transformResult(
          {
            schema,
            document: parse('{ nonNullableField }'),
            rootValue: { nonNullableField: 'nonNullableField' },
          },
          { leafTransformers: { String: () => 'transformed' } },
        );

        expectJSON(result).toDeepEqual({
          data: { nonNullableField: 'transformed' },
        });
      });

      it('handles transformation returning null', () => {
        const result = transformResult(
          {
            schema,
            document: parse('{ nonNullableField }'),
            rootValue: { nonNullableField: 'nonNullableField' },
          },
          { leafTransformers: { String: () => null } },
        );

        expectJSON(result).toDeepEqual({
          data: null,
          errors: [
            {
              message:
                'Cannot return null for non-nullable field nonNullableField.',
              path: ['nonNullableField'],
              locations: [{ line: 1, column: 3 }],
            },
          ],
        });
      });

      it('handles transformation throwing an error', () => {
        const result = transformResult(
          {
            schema,
            document: parse('{ nonNullableField }'),
            rootValue: { nonNullableField: 'nonNullableField' },
          },
          {
            leafTransformers: {
              String: () => {
                throw new Error('Oops');
              },
            },
          },
        );

        expectJSON(result).toDeepEqual({
          data: null,
          errors: [
            {
              message: 'Oops',
              path: ['nonNullableField'],
              locations: [{ line: 1, column: 3 }],
            },
          ],
        });
      });

      it('handles transformation returning an error', () => {
        const result = transformResult(
          {
            schema,
            document: parse('{ nonNullableField }'),
            rootValue: { nonNullableField: 'nonNullableField' },
          },
          {
            leafTransformers: {
              String: () => new Error('Oops'),
            },
          },
        );

        expectJSON(result).toDeepEqual({
          data: null,
          errors: [
            {
              message: 'Oops',
              path: ['nonNullableField'],
              locations: [{ line: 1, column: 3 }],
            },
          ],
        });
      });
    });

    describe('handles transformations of deferred fragments', () => {
      it('handles transformation within a deferred payload', async () => {
        const document = parse(`
          query {
            someObjectField {
              ... @defer { someField }
            }
          }
        `);
        const result = await complete(
          document,
          {
            someObjectField: {
              someField: 'someField',
            },
          },
          {
            leafTransformers: {
              String: () => 'transformed',
            },
          },
        );
        expectJSON(result).toDeepEqual([
          {
            data: { someObjectField: {} },
            pending: [{ id: '0', path: ['someObjectField'] }],
            hasNext: true,
          },
          {
            incremental: [
              {
                data: { someField: 'transformed' },
                id: '0',
              },
            ],
            completed: [{ id: '0' }],
            hasNext: false,
          },
        ]);
      });

      it('handles transformation within a deferred payload causing the fragment to fail', async () => {
        const document = parse(`
          query {
            someObjectField {
              ... @defer { nonNullableField }
            }
          }
        `);
        const result = await complete(
          document,
          {
            someObjectField: {
              nonNullableField: 'nonNullableField',
            },
          },
          {
            leafTransformers: {
              String: () => null,
            },
          },
        );
        expectJSON(result).toDeepEqual([
          {
            data: { someObjectField: {} },
            pending: [{ id: '0', path: ['someObjectField'] }],
            hasNext: true,
          },
          {
            completed: [
              {
                id: '0',
                errors: [
                  {
                    message:
                      'Cannot return null for non-nullable field nonNullableField.',
                    path: ['someObjectField', 'nonNullableField'],
                    locations: [{ line: 4, column: 28 }],
                  },
                ],
              },
            ],
            hasNext: false,
          },
        ]);
      });
    });

    describe('handles transformations of streams', () => {
      it('handles transformation within a stream', async () => {
        const document = parse('{ someListField @stream }');
        const result = await complete(
          document,
          {
            someListField: ['a', 'b', 'c'],
          },
          {
            leafTransformers: {
              String: () => 'transformed',
            },
          },
        );
        expectJSON(result).toDeepEqual([
          {
            data: { someListField: [] },
            pending: [{ id: '0', path: ['someListField'] }],
            hasNext: true,
          },
          {
            incremental: [
              {
                items: ['transformed', 'transformed', 'transformed'],
                id: '0',
              },
            ],
            completed: [{ id: '0' }],
            hasNext: false,
          },
        ]);
      });

      it('handles transformation within a stream causing the stream to fail', async () => {
        const document = parse('{ someListOfNonNullableItems @stream }');
        const result = await complete(
          document,
          {
            someListOfNonNullableItems: ['a', 'b', 'c'],
          },
          {
            leafTransformers: {
              String: () => null,
            },
          },
        );
        expectJSON(result).toDeepEqual([
          {
            data: { someListOfNonNullableItems: [] },
            pending: [{ id: '0', path: ['someListOfNonNullableItems'] }],
            hasNext: true,
          },
          {
            completed: [
              {
                id: '0',
                errors: [
                  {
                    message:
                      'Cannot return null for non-nullable field someListOfNonNullableItems.',
                    path: ['someListOfNonNullableItems', 0],
                    locations: [{ line: 1, column: 3 }],
                  },
                ],
              },
            ],
            hasNext: false,
          },
        ]);
      });
    });
  });

  describe('handles asynchronously transformed leaf values', () => {
    describe('handles transformed leaf values', () => {
      it('handles transformation', async () => {
        let result = transformResult(
          {
            schema,
            document: parse('{ someField }'),
            rootValue: { someField: 'someField' },
          },
          {
            leafTransformers: {
              String: () => Promise.resolve('transformed'),
            },
          },
        );

        assert(isPromise(result));

        result = await result;

        expectJSON(result).toDeepEqual({
          data: { someField: 'transformed' },
        });
      });

      it('handles transformation returning null', async () => {
        let result = transformResult(
          {
            schema,
            document: parse('{ someField }'),
            rootValue: { someField: 'someField' },
          },
          { leafTransformers: { String: () => Promise.resolve(null) } },
        );

        assert(isPromise(result));

        result = await result;

        expectJSON(result).toDeepEqual({ data: { someField: null } });
      });

      it('handles transformation throwing an error', async () => {
        let result = transformResult(
          {
            schema,
            document: parse('{ someField }'),
            rootValue: { someField: 'someField' },
          },
          {
            leafTransformers: {
              String: () => Promise.reject(new Error('Oops')),
            },
          },
        );

        assert(isPromise(result));

        result = await result;

        expectJSON(result).toDeepEqual({
          data: { someField: null },
          errors: [
            {
              message: 'Oops',
              path: ['someField'],
              locations: [{ line: 1, column: 3 }],
            },
          ],
        });
      });

      it('handles transformation returning an error', async () => {
        let result = transformResult(
          {
            schema,
            document: parse('{ someField }'),
            rootValue: { someField: 'someField' },
          },
          {
            leafTransformers: {
              String: () => Promise.resolve(new Error('Oops')),
            },
          },
        );

        assert(isPromise(result));

        result = await result;

        expectJSON(result).toDeepEqual({
          data: { someField: null },
          errors: [
            {
              message: 'Oops',
              path: ['someField'],
              locations: [{ line: 1, column: 3 }],
            },
          ],
        });
      });
    });

    describe('handles transformed non-nullable leaf values', () => {
      it('handles transformation', async () => {
        let result = transformResult(
          {
            schema,
            document: parse('{ nonNullableField }'),
            rootValue: { nonNullableField: 'nonNullableField' },
          },
          {
            leafTransformers: {
              String: () => Promise.resolve('transformed'),
            },
          },
        );

        assert(isPromise(result));

        result = await result;

        expectJSON(result).toDeepEqual({
          data: { nonNullableField: 'transformed' },
        });
      });

      it('handles transformation returning null', async () => {
        let result = transformResult(
          {
            schema,
            document: parse('{ nonNullableField }'),
            rootValue: { nonNullableField: 'nonNullableField' },
          },
          { leafTransformers: { String: () => Promise.resolve(null) } },
        );

        assert(isPromise(result));

        result = await result;

        expectJSON(result).toDeepEqual({
          data: null,
          errors: [
            {
              message:
                'Cannot return null for non-nullable field nonNullableField.',
              path: ['nonNullableField'],
              locations: [{ line: 1, column: 3 }],
            },
          ],
        });
      });

      it('handles transformation throwing an error', async () => {
        let result = transformResult(
          {
            schema,
            document: parse('{ nonNullableField }'),
            rootValue: { nonNullableField: 'nonNullableField' },
          },
          {
            leafTransformers: {
              String: () => Promise.reject(new Error('Oops')),
            },
          },
        );

        assert(isPromise(result));

        result = await result;

        expectJSON(result).toDeepEqual({
          data: null,
          errors: [
            {
              message: 'Oops',
              path: ['nonNullableField'],
              locations: [{ line: 1, column: 3 }],
            },
          ],
        });
      });

      it('handles transformation returning an error', async () => {
        let result = transformResult(
          {
            schema,
            document: parse('{ nonNullableField }'),
            rootValue: { nonNullableField: 'nonNullableField' },
          },
          {
            leafTransformers: {
              String: () => Promise.resolve(new Error('Oops')),
            },
          },
        );

        assert(isPromise(result));

        result = await result;

        expectJSON(result).toDeepEqual({
          data: null,
          errors: [
            {
              message: 'Oops',
              path: ['nonNullableField'],
              locations: [{ line: 1, column: 3 }],
            },
          ],
        });
      });
    });

    describe('handles transformations of deferred fragments', () => {
      it('handles transformation within a deferred payload', async () => {
        const document = parse(`
          query {
            someObjectField {
              ... @defer { someField }
            }
          }
        `);
        const result = await complete(
          document,
          {
            someObjectField: {
              someField: 'someField',
            },
          },
          {
            leafTransformers: {
              String: () => Promise.resolve('transformed'),
            },
          },
        );
        expectJSON(result).toDeepEqual([
          {
            data: { someObjectField: {} },
            pending: [{ id: '0', path: ['someObjectField'] }],
            hasNext: true,
          },
          {
            incremental: [
              {
                data: { someField: 'transformed' },
                id: '0',
              },
            ],
            completed: [{ id: '0' }],
            hasNext: false,
          },
        ]);
      });

      it('handles transformation within a deferred payload causing the fragment to fail', async () => {
        const document = parse(`
          query {
            someObjectField {
              ... @defer { nonNullableField }
            }
          }
        `);
        const result = await complete(
          document,
          {
            someObjectField: {
              nonNullableField: 'nonNullableField',
            },
          },
          {
            leafTransformers: {
              String: () => Promise.resolve(null),
            },
          },
        );
        expectJSON(result).toDeepEqual([
          {
            data: { someObjectField: {} },
            pending: [{ id: '0', path: ['someObjectField'] }],
            hasNext: true,
          },
          {
            completed: [
              {
                id: '0',
                errors: [
                  {
                    message:
                      'Cannot return null for non-nullable field nonNullableField.',
                    path: ['someObjectField', 'nonNullableField'],
                    locations: [{ line: 4, column: 28 }],
                  },
                ],
              },
            ],
            hasNext: false,
          },
        ]);
      });
    });

    describe('handles transformations of streams', () => {
      it('handles transformation within a stream', async () => {
        const document = parse('{ someListField @stream }');
        const result = await complete(
          document,
          {
            someListField: ['a', 'b', 'c'],
          },
          {
            leafTransformers: {
              String: () => Promise.resolve('transformed'),
            },
          },
        );
        expectJSON(result).toDeepEqual([
          {
            data: { someListField: [] },
            pending: [{ id: '0', path: ['someListField'] }],
            hasNext: true,
          },
          {
            incremental: [{ items: ['transformed'], id: '0' }],
            hasNext: true,
          },
          {
            incremental: [{ items: ['transformed'], id: '0' }],
            hasNext: true,
          },
          {
            incremental: [{ items: ['transformed'], id: '0' }],
            completed: [{ id: '0' }],
            hasNext: false,
          },
        ]);
      });

      it('handles transformation within a stream causing the stream to fail', async () => {
        const document = parse('{ someListOfNonNullableItems @stream }');
        const result = await complete(
          document,
          {
            someListOfNonNullableItems: ['a', 'b', 'c'],
          },
          {
            leafTransformers: {
              String: () => Promise.resolve(null),
            },
          },
        );
        expectJSON(result).toDeepEqual([
          {
            data: { someListOfNonNullableItems: [] },
            pending: [{ id: '0', path: ['someListOfNonNullableItems'] }],
            hasNext: true,
          },
          {
            completed: [
              {
                id: '0',
                errors: [
                  {
                    message:
                      'Cannot return null for non-nullable field someListOfNonNullableItems.',
                    path: ['someListOfNonNullableItems', 0],
                    locations: [{ line: 1, column: 3 }],
                  },
                ],
              },
            ],
            hasNext: false,
          },
        ]);
      });
    });
  });
});

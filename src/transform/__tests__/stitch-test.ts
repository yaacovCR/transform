import type {
  DocumentNode,
  InitialIncrementalExecutionResult,
  SubsequentIncrementalExecutionResult,
} from 'graphql';
import {
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  parse,
} from 'graphql';
import { describe, it } from 'mocha';

import { expectJSON } from '../../__testUtils__/expectJSON.js';

import { invariant } from '../../jsutils/invariant.js';
import type { ObjMap } from '../../jsutils/ObjMap.js';

import type { SubschemaConfig } from '../buildTransformationContext.js';
import { transform } from '../transform.js';

const queryA: GraphQLObjectType = new GraphQLObjectType({
  name: 'Query',
  fields: () => ({
    fieldA: { type: GraphQLString },
    nested: { type: queryA },
  }),
});

const subschemaA = new GraphQLSchema({
  query: queryA,
});

const subschemaB = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: () => ({
      fieldB: { type: GraphQLString },
    }),
  }),
});

const query: GraphQLObjectType = new GraphQLObjectType({
  name: 'Query',
  fields: () => ({
    fieldA: { type: GraphQLString },
    fieldB: { type: GraphQLString },
    nested: { type: query },
  }),
});

const superSchema = new GraphQLSchema({
  query,
});

async function complete(
  document: DocumentNode,
  subschemaConfigs: ReadonlyArray<SubschemaConfig>,
  rootValue: ObjMap<unknown> = {},
) {
  const result = await transform({
    schema: superSchema,
    document,
    subschemas: subschemaConfigs,
    rootValue,
  });

  invariant('initialResult' in result);

  const results: Array<
    InitialIncrementalExecutionResult | SubsequentIncrementalExecutionResult
  > = [result.initialResult];
  for await (const patch of result.subsequentResults) {
    results.push(patch);
  }
  return results;
}

describe('stitching', () => {
  it('merges root fields from multiple subschemas', () => {
    const document: DocumentNode = parse('{ fieldA fieldB }');

    const subschemaConfigs: ReadonlyArray<SubschemaConfig> = [
      { label: 'subschemaA', schema: subschemaA },
      { label: 'subschemaB', schema: subschemaB },
    ];

    const result = transform({
      schema: superSchema,
      document,
      subschemas: subschemaConfigs,
      rootValue: {
        fieldA: 'valueA',
        fieldB: 'valueB',
      },
    });

    expectJSON(result).toDeepEqual({
      data: {
        fieldA: 'valueA',
        fieldB: 'valueB',
      },
    });
  });

  it('merges deferred root fields from multiple subschemas', async () => {
    const document: DocumentNode = parse(`
      query {
        ... @defer { fieldA }
        ... @defer { fieldB }
      }
    `);

    const subschemaConfigs: ReadonlyArray<SubschemaConfig> = [
      { label: 'subschemaA', schema: subschemaA },
      { label: 'subschemaB', schema: subschemaB },
    ];

    const result = await complete(document, subschemaConfigs, {
      fieldA: 'valueA',
      fieldB: 'valueB',
    });

    expectJSON(result).toDeepEqual([
      {
        data: {},
        pending: [
          { id: '0', path: [] },
          { id: '1', path: [] },
        ],
        hasNext: true,
      },
      {
        incremental: [
          {
            data: { fieldA: 'valueA' },
            id: '0',
          },
        ],
        completed: [{ id: '0' }],
        hasNext: true,
      },
      {
        incremental: [
          {
            data: { fieldB: 'valueB' },
            id: '1',
          },
        ],
        completed: [{ id: '1' }],
        hasNext: false,
      },
    ]);
  });

  it('merges subfields from multiple subschemas', () => {
    const document: DocumentNode = parse('{ nested { fieldA fieldB } }');

    const subschemaConfigs: ReadonlyArray<SubschemaConfig> = [
      { label: 'subschemaA', schema: subschemaA },
      { label: 'subschemaB', schema: subschemaB },
    ];

    const result = transform({
      schema: superSchema,
      document,
      subschemas: subschemaConfigs,
      rootValue: {
        nested: {
          fieldA: 'valueA',
        },
        fieldB: 'valueB',
      },
    });

    expectJSON(result).toDeepEqual({
      data: {
        nested: {
          fieldA: 'valueA',
          fieldB: 'valueB',
        },
      },
    });
  });

  it('merges async subfields from multiple subschemas', async () => {
    const document: DocumentNode = parse('{ nested { fieldA fieldB } }');

    const subschemaConfigs: ReadonlyArray<SubschemaConfig> = [
      { label: 'subschemaA', schema: subschemaA },
      { label: 'subschemaB', schema: subschemaB },
    ];

    const result = await transform({
      schema: superSchema,
      document,
      subschemas: subschemaConfigs,
      rootValue: {
        nested: {
          fieldA: Promise.resolve('valueA'),
        },
        fieldB: Promise.resolve('valueB'),
      },
    });

    expectJSON(result).toDeepEqual({
      data: {
        nested: {
          fieldA: 'valueA',
          fieldB: 'valueB',
        },
      },
    });
  });
});

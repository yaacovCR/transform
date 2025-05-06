import { expect } from 'chai';
import type { OperationDefinitionNode } from 'graphql';
import {
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  Kind,
  parse,
  print,
} from 'graphql';
// eslint-disable-next-line n/no-missing-import
import { collectFields } from 'graphql/execution/collectFields.js';
import { describe, it } from 'mocha';

import { dedent } from '../../__testUtils__/dedent.js';

import { groupedFieldSetToSelectionSet } from '../groupedFieldSetToSelectionSet.js';

const query = new GraphQLObjectType({
  name: 'Query',
  fields: {
    a: { type: GraphQLString },
    b: { type: GraphQLString },
    c: { type: GraphQLString },
  },
});
const schema = new GraphQLSchema({
  query,
});

function expectSourceToMatch(source: string): void {
  const document = parse(source);
  const operation = document.definitions[0] as OperationDefinitionNode;
  const { groupedFieldSet } = collectFields(
    schema,
    {},
    { sources: {}, coerced: {} },
    query,
    operation.selectionSet,
    false,
  );

  const selectionSet = groupedFieldSetToSelectionSet(groupedFieldSet);

  const printed = print({
    kind: Kind.DOCUMENT,
    definitions: [
      {
        kind: Kind.OPERATION_DEFINITION,
        operation: 'query',
        selectionSet,
      },
    ],
  });

  expect(printed).to.equal(dedent`${source}`);
}

describe('groupedFieldSetToSelectionSet', () => {
  it('should handle field set without @defer', () => {
    expectSourceToMatch(`
      {
        a
        b
      }
    `);
  });

  it('should handle field set with single @defer', () => {
    expectSourceToMatch(`
      {
        a
        b
        ... @defer(label: "label") {
          c
        }
      }
    `);
  });

  it('should handle field set with nested @defer', () => {
    expectSourceToMatch(`
      {
        a
        b
        ... @defer(label: "outer") {
          c
          ... @defer(label: "inner") {
            d
          }
        }
      }
    `);
  });

  it('should handle field set with multiple @defer', () => {
    expectSourceToMatch(`
      {
        a
        b
        ... @defer(label: "label1") {
          c
        }
        ... @defer(label: "label2") {
          d
        }
      }
    `);
  });
});

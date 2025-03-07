import { expect } from 'chai';
import {
  GraphQLInterfaceType,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  Kind,
  parse,
} from 'graphql';
// eslint-disable-next-line n/no-missing-import
import { validateExecutionArgs } from 'graphql/execution/execute.js';
import { describe, it } from 'mocha';

import { invariant } from '../../jsutils/invariant.js';

import { collectRootFields, collectSubfields } from '../collectFields.js';

describe('collectFields', () => {
  const someParentInterface = new GraphQLInterfaceType({
    name: 'SomeParentInterface',
    fields: { someField: { type: GraphQLString } },
  });
  const someChildInterface = new GraphQLInterfaceType({
    name: 'SomeChildInterface',
    interfaces: [someParentInterface],
    fields: { someField: { type: GraphQLString } },
  });
  const someObjectType = new GraphQLObjectType({
    name: 'SomeObjectType',
    interfaces: [someChildInterface, someParentInterface],
    fields: { someField: { type: GraphQLString } },
  });
  const query = new GraphQLObjectType({
    name: 'Query',
    fields: {
      someField: { type: GraphQLString },
      anotherField: { type: someParentInterface },
    },
  });
  const schema = new GraphQLSchema({
    query,
    types: [someObjectType],
  });

  it('collects fields from a selection set', () => {
    const document = parse('{ someField }');

    const validatedExecutionArgs = validateExecutionArgs({
      schema,
      document,
    });

    invariant('schema' in validatedExecutionArgs);

    const { groupedFieldSet } = collectRootFields(
      validatedExecutionArgs,
      query,
    );

    expect(groupedFieldSet.get('someField')).to.deep.equal([
      {
        node: validatedExecutionArgs.operation.selectionSet.selections[0],
        deferUsage: undefined,
        fragmentVariableValues: undefined,
      },
    ]);
  });

  it('collects fields, skipping a field', () => {
    const document = parse('{ someField @skip(if: true) }');

    const validatedExecutionArgs = validateExecutionArgs({
      schema,
      document,
    });

    invariant('schema' in validatedExecutionArgs);

    const { groupedFieldSet } = collectRootFields(
      validatedExecutionArgs,
      query,
    );

    expect(groupedFieldSet.size).to.equal(0);
  });

  it('collects fields, not including a field', () => {
    const document = parse('{ someField @include(if: false) }');

    const validatedExecutionArgs = validateExecutionArgs({
      schema,
      document,
    });

    invariant('schema' in validatedExecutionArgs);

    const { groupedFieldSet } = collectRootFields(
      validatedExecutionArgs,
      query,
    );

    expect(groupedFieldSet.size).to.equal(0);
  });

  it('collects fields from a selection with an inline fragment', () => {
    const document = parse('{ ... { someField } }');

    const validatedExecutionArgs = validateExecutionArgs({
      schema,
      document,
    });

    invariant('schema' in validatedExecutionArgs);

    const inlineFragment =
      validatedExecutionArgs.operation.selectionSet.selections[0];

    invariant(inlineFragment.kind === Kind.INLINE_FRAGMENT);

    const { groupedFieldSet } = collectRootFields(
      validatedExecutionArgs,
      query,
    );

    expect(groupedFieldSet.get('someField')).to.deep.equal([
      {
        node: inlineFragment.selectionSet.selections[0],
        deferUsage: undefined,
        fragmentVariableValues: undefined,
      },
    ]);
  });

  it('collects fields from a selection with a named fragment with a non-matching conditional type', () => {
    const document = parse(`
      query { ...SomeFragment }
      fragment SomeFragment on SomeObject { someField }
    `);

    const validatedExecutionArgs = validateExecutionArgs({
      schema,
      document,
    });

    invariant('schema' in validatedExecutionArgs);

    const { groupedFieldSet } = collectRootFields(
      validatedExecutionArgs,
      query,
    );

    expect(groupedFieldSet.size).to.equal(0);
  });

  it('collects fields from a selection with an inline fragment with a conditional type', () => {
    const document = parse('{ ... on Query { someField } }');

    const validatedExecutionArgs = validateExecutionArgs({
      schema,
      document,
    });

    invariant('schema' in validatedExecutionArgs);

    const inlineFragment =
      validatedExecutionArgs.operation.selectionSet.selections[0];

    invariant(inlineFragment.kind === Kind.INLINE_FRAGMENT);

    const { groupedFieldSet } = collectRootFields(
      validatedExecutionArgs,
      query,
    );

    expect(groupedFieldSet.get('someField')).to.deep.equal([
      {
        node: inlineFragment.selectionSet.selections[0],
        deferUsage: undefined,
        fragmentVariableValues: undefined,
      },
    ]);
  });

  it('collects fields from a selection with an inline fragment with a conditional abstract subtype', () => {
    const document = parse(
      '{ anotherField { ... on SomeChildInterface { someField } } }',
    );

    const validatedExecutionArgs = validateExecutionArgs({
      schema,
      document,
    });

    invariant('schema' in validatedExecutionArgs);

    const { groupedFieldSet } = collectRootFields(
      validatedExecutionArgs,
      query,
    );

    const fieldDetailsList = groupedFieldSet.get('anotherField');

    invariant(fieldDetailsList != null);

    const { groupedFieldSet: nestedGroupedFieldSet } = collectSubfields(
      validatedExecutionArgs,
      someObjectType,
      fieldDetailsList,
    );

    const field = validatedExecutionArgs.operation.selectionSet.selections[0];

    invariant(field.kind === Kind.FIELD);

    const inlineFragment = field.selectionSet?.selections[0];

    invariant(inlineFragment?.kind === Kind.INLINE_FRAGMENT);

    expect(nestedGroupedFieldSet.get('someField')).to.deep.equal([
      {
        node: inlineFragment.selectionSet.selections[0],
        deferUsage: undefined,
        fragmentVariableValues: undefined,
      },
    ]);
  });

  it('collects fields from a selection with an inline fragment with a non-matching conditional subtype', () => {
    const document = parse('{ ... on SomeObject { someField } }');

    const validatedExecutionArgs = validateExecutionArgs({
      schema,
      document,
    });

    invariant('schema' in validatedExecutionArgs);

    const { groupedFieldSet } = collectRootFields(
      validatedExecutionArgs,
      query,
    );

    expect(groupedFieldSet.size).to.equal(0);
  });

  it('collects fields, using fragment variables', () => {
    const document = parse(
      `
        query { ...SomeFragment(skip: false) }
        fragment SomeFragment($skip: Boolean ) on Query { someField @skip(if: $skip) }
      `,
      {
        experimentalFragmentArguments: true,
      },
    );

    const validatedExecutionArgs = validateExecutionArgs({
      schema,
      document,
    });

    invariant('schema' in validatedExecutionArgs);

    const { groupedFieldSet } = collectRootFields(
      validatedExecutionArgs,
      query,
    );

    expect(groupedFieldSet.size).to.equal(1);
  });
});

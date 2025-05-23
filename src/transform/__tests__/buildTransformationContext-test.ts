import { expect } from 'chai';
import {
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  parse,
} from 'graphql';
// eslint-disable-next-line n/no-missing-import
import { validateExecutionArgs } from 'graphql/execution/execute.js';
import { describe, it } from 'mocha';

import { invariant } from '../../jsutils/invariant.js';

import { buildDeferPlan } from '../buildDeferPlan.js';
import { buildTransformationContext } from '../buildTransformationContext.js';

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: { someField: { type: GraphQLString } },
  }),
});

describe('buildTransformationContext', () => {
  it('should build a transformation context', () => {
    const validatedExecutionArgs = validateExecutionArgs({
      schema,
      document: parse('{ someField }'),
    });

    invariant('schema' in validatedExecutionArgs);

    const context = buildTransformationContext(
      validatedExecutionArgs,
      [],
      { objectFieldTransformers: {}, leafTransformers: {} },
      buildDeferPlan,
      '__prefix__',
    );

    expect(context.originalLabels instanceof Map).to.equal(true);
    expect(context.deferPlanBuilder).to.equal(buildDeferPlan);
    expect(context.prefix).to.equal('__prefix__');
  });

  it('should handle non-standard directives', () => {
    const validatedExecutionArgs = validateExecutionArgs({
      schema,
      document: parse('{ ... @someDirective { someField } }'),
    });

    invariant('schema' in validatedExecutionArgs);

    expect(() =>
      buildTransformationContext(
        validatedExecutionArgs,
        [],
        { objectFieldTransformers: {}, leafTransformers: {} },
        buildDeferPlan,
        '__prefix__',
      ),
    ).not.to.throw();
  });
});

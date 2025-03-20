import type {
  ArgumentNode,
  DirectiveNode,
  SelectionNode,
  SelectionSetNode,
  ValidatedExecutionArgs,
} from 'graphql';
import {
  GraphQLDeferDirective,
  GraphQLStreamDirective,
  Kind,
  TypeNameMetaFieldDef,
} from 'graphql';
// eslint-disable-next-line n/no-missing-import
import type { GroupedFieldSet } from 'graphql/execution/collectFields.js';

import { invariant } from '../jsutils/invariant.js';
import { mapValue } from '../jsutils/mapValue.js';

import type { DeferUsageSet, ExecutionPlan } from './buildExecutionPlan.js';

export type ExecutionPlanBuilder = (
  originalGroupedFieldSet: GroupedFieldSet,
  parentDeferUsages?: DeferUsageSet,
) => ExecutionPlan;

export interface TransformationContext {
  transformedArgs: ValidatedExecutionArgs;
  originalLabels: Map<string, string | undefined>;
  executionPlanBuilder: ExecutionPlanBuilder;
  prefix: string;
}

interface RequestTransformationContext {
  prefix: string;
  incrementalCounter: number;
  originalLabels: Map<string, string | undefined>;
}

export function buildTransformationContext(
  originalArgs: ValidatedExecutionArgs,
  executionPlanBuilder: ExecutionPlanBuilder,
  prefix: string,
): TransformationContext {
  const { operation, fragments } = originalArgs;

  const context: RequestTransformationContext = {
    prefix,
    incrementalCounter: 0,
    originalLabels: new Map(),
  };

  const transformedFragments = mapValue(fragments, (details) => ({
    ...details,
    definition: {
      ...details.definition,
      selectionSet: transformRootSelectionSet(
        context,
        details.definition.selectionSet,
      ),
    },
  }));

  const transformedArgs: ValidatedExecutionArgs = {
    ...originalArgs,
    operation: {
      ...operation,
      selectionSet: transformRootSelectionSet(context, operation.selectionSet),
    },
    fragmentDefinitions: mapValue(
      transformedFragments,
      ({ definition }) => definition,
    ),
    fragments: transformedFragments,
  };

  return {
    transformedArgs,
    originalLabels: context.originalLabels,
    executionPlanBuilder,
    prefix,
  };
}

function transformRootSelectionSet(
  context: RequestTransformationContext,
  selectionSet: SelectionSetNode,
): SelectionSetNode {
  return {
    ...selectionSet,
    selections: [
      ...selectionSet.selections.map((node) =>
        transformSelection(context, node),
      ),
    ],
  };
}

function transformNestedSelectionSet(
  context: RequestTransformationContext,
  selectionSet: SelectionSetNode,
): SelectionSetNode {
  return {
    ...selectionSet,
    selections: [
      ...selectionSet.selections.map((node) =>
        transformSelection(context, node),
      ),
      {
        kind: Kind.FIELD,
        name: {
          kind: Kind.NAME,
          value: TypeNameMetaFieldDef.name,
        },
        alias: {
          kind: Kind.NAME,
          value: context.prefix,
        },
      },
    ],
  };
}

function transformSelection(
  context: RequestTransformationContext,
  selection: SelectionNode,
): SelectionNode {
  if (selection.kind === Kind.FIELD) {
    const selectionSet = selection.selectionSet;
    if (selectionSet) {
      return {
        ...selection,
        selectionSet: transformNestedSelectionSet(context, selectionSet),
        directives: selection.directives?.map((directive) =>
          transformMaybeStreamDirective(context, directive),
        ),
      };
    }
    return {
      ...selection,
      directives: selection.directives?.map((directive) =>
        transformMaybeStreamDirective(context, directive),
      ),
    };
  } else if (selection.kind === Kind.INLINE_FRAGMENT) {
    return {
      ...selection,
      selectionSet: transformRootSelectionSet(context, selection.selectionSet),
      directives: selection.directives?.map((directive) =>
        transformMaybeDeferDirective(context, directive),
      ),
    };
  }

  return {
    ...selection,
    directives: selection.directives?.map((directive) =>
      transformMaybeDeferDirective(context, directive),
    ),
  };
}

function transformMaybeDeferDirective(
  context: RequestTransformationContext,
  directive: DirectiveNode,
): DirectiveNode {
  const name = directive.name.value;

  if (name !== GraphQLDeferDirective.name) {
    return directive;
  }

  let foundLabel = false;
  const newArgs: Array<ArgumentNode> = [];
  const args = directive.arguments;
  if (args) {
    for (const arg of args) {
      if (arg.name.value === 'label') {
        foundLabel = true;
        const value = arg.value;

        invariant(value.kind === Kind.STRING);

        const originalLabel = value.value;
        const prefixedLabel = `${context.prefix}defer${context.incrementalCounter++}__${originalLabel}`;
        context.originalLabels.set(prefixedLabel, originalLabel);
        newArgs.push({
          ...arg,
          value: {
            ...value,
            value: prefixedLabel,
          },
        });
      } else {
        newArgs.push(arg);
      }
    }
  }

  if (!foundLabel) {
    const newLabel = `${context.prefix}defer${context.incrementalCounter++}`;
    context.originalLabels.set(newLabel, undefined);
    newArgs.push({
      kind: Kind.ARGUMENT,
      name: {
        kind: Kind.NAME,
        value: 'label',
      },
      value: {
        kind: Kind.STRING,
        value: newLabel,
      },
    });
  }

  return {
    ...directive,
    arguments: newArgs,
  };
}

function transformMaybeStreamDirective(
  context: RequestTransformationContext,
  directive: DirectiveNode,
): DirectiveNode {
  const name = directive.name.value;

  if (name !== GraphQLStreamDirective.name) {
    return directive;
  }

  let foundLabel = false;
  const newArgs: Array<ArgumentNode> = [];
  const args = directive.arguments;
  if (args) {
    for (const arg of args) {
      if (arg.name.value === 'label') {
        foundLabel = true;
        const value = arg.value;

        invariant(value.kind === Kind.STRING);

        const originalLabel = value.value;
        const prefixedLabel = `${context.prefix}stream${context.incrementalCounter++}__${originalLabel}`;
        context.originalLabels.set(prefixedLabel, originalLabel);
        newArgs.push({
          ...arg,
          value: {
            ...value,
            value: prefixedLabel,
          },
        });
      } else {
        newArgs.push(arg);
      }
    }
  }

  if (!foundLabel) {
    const newLabel = `${context.prefix}stream${context.incrementalCounter++}`;
    context.originalLabels.set(newLabel, undefined);
    newArgs.push({
      kind: Kind.ARGUMENT,
      name: {
        kind: Kind.NAME,
        value: 'label',
      },
      value: {
        kind: Kind.STRING,
        value: newLabel,
      },
    });
  }

  return {
    ...directive,
    arguments: newArgs,
  };
}

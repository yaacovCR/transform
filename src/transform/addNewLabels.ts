import type {
  ArgumentNode,
  DirectiveNode,
  OperationDefinitionNode,
  SelectionNode,
  SelectionSetNode,
} from 'graphql';
import { GraphQLDeferDirective, GraphQLStreamDirective } from 'graphql';
// eslint-disable-next-line n/no-missing-import
import type { FragmentDetails } from 'graphql/execution/collectFields.js';
// eslint-disable-next-line n/no-missing-import
import { Kind } from 'graphql/language/kinds.js';

import { invariant } from '../jsutils/invariant.js';
import { mapValue } from '../jsutils/mapValue.js';
import type { ObjMap } from '../jsutils/ObjMap.js';

interface AddNewLabelsContext {
  prefix: string;
  incrementalCounter: number;
  originalLabels: Map<string, string | undefined>;
}

export function addNewLabels(
  operation: OperationDefinitionNode,
  fragments: ObjMap<FragmentDetails>,
  prefix: string,
): {
  operation: OperationDefinitionNode;
  fragments: ObjMap<FragmentDetails>;
  originalLabels: Map<string, string | undefined>;
} {
  const context: AddNewLabelsContext = {
    prefix,
    incrementalCounter: 0,
    originalLabels: new Map(),
  };

  const transformedFragments = mapValue(fragments, (details) => ({
    ...details,
    definition: {
      ...details.definition,
      selectionSet: transformSelectionSet(
        context,
        details.definition.selectionSet,
      ),
    },
  }));

  return {
    operation: {
      ...operation,
      selectionSet: transformSelectionSet(context, operation.selectionSet),
    },
    fragments: transformedFragments,
    originalLabels: context.originalLabels,
  };
}

function transformSelectionSet(
  context: AddNewLabelsContext,
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

function transformSelection(
  context: AddNewLabelsContext,
  selection: SelectionNode,
): SelectionNode {
  if (selection.kind === Kind.FIELD) {
    const selectionSet = selection.selectionSet;
    if (selectionSet) {
      return {
        ...selection,
        selectionSet: transformSelectionSet(context, selectionSet),
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
      selectionSet: transformSelectionSet(context, selection.selectionSet),
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
  context: AddNewLabelsContext,
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
  context: AddNewLabelsContext,
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

import type {
  SelectionNode,
  SelectionSetNode,
  ValidatedExecutionArgs,
} from 'graphql';
import { TypeNameMetaFieldDef } from 'graphql';
// eslint-disable-next-line n/no-missing-import
import { Kind } from 'graphql/language/kinds.js';

import { mapValue } from '../jsutils/mapValue.js';

export function transformForTargetSubschema(
  originalArgs: ValidatedExecutionArgs,
  prefix: string,
): ValidatedExecutionArgs {
  const { operation, fragments } = originalArgs;

  const transformedFragments = mapValue(fragments, (details) => ({
    ...details,
    definition: {
      ...details.definition,
      selectionSet: transformSelectionSet(
        details.definition.selectionSet,
        prefix,
      ),
    },
  }));

  const argsForTargetSubschema: ValidatedExecutionArgs = {
    ...originalArgs,
    operation: {
      ...operation,
      selectionSet: transformSelectionSet(operation.selectionSet, prefix),
    },
    fragmentDefinitions: mapValue(
      transformedFragments,
      ({ definition }) => definition,
    ),
    fragments: transformedFragments,
  };

  return argsForTargetSubschema;
}

function transformSelectionSet(
  selectionSet: SelectionSetNode,
  prefix: string,
): SelectionSetNode {
  return {
    ...selectionSet,
    selections: [
      ...selectionSet.selections.map((node) =>
        transformSelection(prefix, node),
      ),
    ],
  };
}

function transformSelection(
  prefix: string,
  selection: SelectionNode,
): SelectionNode {
  if (selection.kind === Kind.FIELD) {
    const selectionSet = selection.selectionSet;
    if (selectionSet) {
      return {
        ...selection,
        selectionSet: transformSubSelectionSet(prefix, selectionSet),
      };
    }
    return {
      ...selection,
    };
  } else if (selection.kind === Kind.INLINE_FRAGMENT) {
    return {
      ...selection,
      selectionSet: transformSelectionSet(selection.selectionSet, prefix),
    };
  }

  return selection;
}

function transformSubSelectionSet(
  prefix: string,
  selectionSet: SelectionSetNode,
): SelectionSetNode {
  return {
    ...selectionSet,
    selections: [
      ...selectionSet.selections.map((selection) =>
        transformSelection(prefix, selection),
      ),
      {
        kind: Kind.FIELD,
        name: {
          kind: Kind.NAME,
          value: TypeNameMetaFieldDef.name,
        },
        alias: {
          kind: Kind.NAME,
          value: prefix,
        },
      },
    ],
  };
}

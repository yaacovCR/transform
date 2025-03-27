import type {
  FieldNode,
  FragmentDefinitionNode,
  GraphQLCompositeType,
  GraphQLSchema,
  OperationDefinitionNode,
  SelectionSetNode,
} from 'graphql';
import {
  GraphQLError,
  Kind,
  TypeInfo,
  TypeNameMetaFieldDef,
  visit,
  visitWithTypeInfo,
} from 'graphql';
// eslint-disable-next-line n/no-missing-import
import type { FragmentDetails } from 'graphql/execution/collectFields.js';

import { invariant } from '../jsutils/invariant.js';
import { mapValue } from '../jsutils/mapValue.js';
import type { ObjMap } from '../jsutils/ObjMap.js';

export function transformForTargetSubschema(
  operation: OperationDefinitionNode,
  fragments: ObjMap<FragmentDetails>,
  targetSchema: GraphQLSchema,
  prefix: string,
):
  | {
      operation: OperationDefinitionNode;
      fragments: ObjMap<FragmentDetails>;
    }
  | ReadonlyArray<GraphQLError> {
  const fragmentDefinitions = mapValue(
    fragments,
    (details) => details.definition,
  );

  const transformedFragments = mapValue(fragments, (details) => {
    const definition = details.definition;
    const { typeCondition, selectionSet } = definition;
    const typeName = typeCondition.name.value;
    const type = targetSchema.getType(typeName) as GraphQLCompositeType;
    invariant(type != null);
    return {
      ...details,
      definition: {
        ...definition,
        selectionSet: transformSelectionSet(
          targetSchema,
          selectionSet,
          type,
          prefix,
          fragmentDefinitions,
        ),
      },
    };
  });

  const { operation: operationType, selectionSet } = operation;
  const rootType = targetSchema.getRootType(operationType);
  if (rootType == null) {
    return [
      new GraphQLError(
        `Schema is not configured to execute ${operation.operation} operation.`,
        {
          nodes: [operation],
        },
      ),
    ];
  }

  const transformedOperation = {
    ...operation,
    selectionSet: transformSelectionSet(
      targetSchema,
      selectionSet,
      rootType,
      prefix,
      fragmentDefinitions,
    ),
  };

  return {
    operation: transformedOperation,
    fragments: transformedFragments,
  };
}

function transformSelectionSet(
  targetSchema: GraphQLSchema,
  selectionSet: SelectionSetNode,
  initialType: GraphQLCompositeType,
  prefix: string,
  fragmentDefinitions: ObjMap<FragmentDefinitionNode>,
): SelectionSetNode {
  const typeInfo = new TypeInfo(targetSchema, initialType);

  const visitor = visitWithTypeInfo(typeInfo, {
    FragmentSpread(node) {
      const fragment = fragmentDefinitions[node.name.value];
      invariant(fragment !== undefined);
      const typeName = fragment.typeCondition.name.value;
      const type = targetSchema.getType(typeName);
      // TODO: fix test coverage
      /* c8 ignore next 3 */
      if (!type) {
        return null;
      }
      return undefined;
    },
    InlineFragment(node) {
      if (node.typeCondition) {
        const typeName = node.typeCondition.name.value;
        const type = targetSchema.getType(typeName);
        // TODO: fix test coverage
        /* c8 ignore next 3 */
        if (!type) {
          return null;
        }
      }
      return undefined;
    },
    Field(node: FieldNode): FieldNode | null | undefined {
      const fieldDef = typeInfo.getFieldDef();
      if (!fieldDef) {
        return null;
      }
      if (node.selectionSet) {
        // TODO: add test case
        /* c8 ignore next 3 */
        if (node.selectionSet.selections.length === 0) {
          return null;
        }
        return {
          ...node,
          selectionSet: {
            ...node.selectionSet,
            selections: [
              ...node.selectionSet.selections,
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
          },
        };
      }
      return undefined;
    },
  });

  return visit(selectionSet, visitor);
}

import type {
  FieldNode,
  GraphQLCompositeType,
  GraphQLSchema,
  SelectionSetNode,
} from 'graphql';
import {
  Kind,
  TypeInfo,
  TypeNameMetaFieldDef,
  visit,
  visitWithTypeInfo,
} from 'graphql';
// eslint-disable-next-line n/no-missing-import
import type { FragmentDetails } from 'graphql/execution/collectFields.js';

import { invariant } from '../jsutils/invariant.js';
import type { ObjMap } from '../jsutils/ObjMap.js';

export function transformSelectionSetForTargetSubschema(
  selectionSet: SelectionSetNode,
  fragments: ObjMap<FragmentDetails>,
  parentType: GraphQLCompositeType,
  targetSchema: GraphQLSchema,
  prefix: string,
): SelectionSetNode {
  const typeInfo = new TypeInfo(targetSchema, parentType);

  const visitor = visitWithTypeInfo(typeInfo, {
    FragmentSpread(node) {
      const fragment = fragments[node.name.value].definition;
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

import type {
  ArgumentNode,
  DirectiveNode,
  InlineFragmentNode,
  SelectionNode,
  SelectionSetNode,
} from 'graphql';
import { GraphQLDeferDirective, Kind } from 'graphql';
import type {
  DeferUsage,
  GroupedFieldSet,
} from 'graphql/execution/collectFields';

export function groupedFieldSetToSelectionSet(
  groupedFieldSet: GroupedFieldSet,
): SelectionSetNode {
  const rootSelections: Array<SelectionNode> = [];

  const selectionsByDefer = new Map<
    DeferUsage | undefined,
    Array<SelectionNode>
  >();

  function addInlineFragment(
    deferUsage: DeferUsage | undefined,
  ): Array<SelectionNode> {
    let selections = selectionsByDefer.get(deferUsage);
    if (selections) {
      return selections;
    }

    selections = [];
    selectionsByDefer.set(deferUsage, selections);

    const directives: Array<DirectiveNode> = [];
    const inlineFragment: InlineFragmentNode = {
      kind: Kind.INLINE_FRAGMENT,
      directives,
      selectionSet: { kind: Kind.SELECTION_SET, selections },
    };

    if (deferUsage) {
      const args: Array<ArgumentNode> =
        deferUsage.label !== undefined
          ? [
              {
                kind: Kind.ARGUMENT,
                name: { kind: Kind.NAME, value: 'label' },
                value: { kind: Kind.STRING, value: deferUsage.label },
              },
            ]
          : [];
      directives.push({
        kind: Kind.DIRECTIVE,
        name: { kind: Kind.NAME, value: GraphQLDeferDirective.name },
        arguments: args,
      });
    }

    const parent = deferUsage?.parentDeferUsage;
    if (parent) {
      const parentSelections = addInlineFragment(parent);
      parentSelections.push(inlineFragment);
    } else {
      rootSelections.push(inlineFragment);
    }
    return selections;
  }

  for (const detailList of groupedFieldSet.values()) {
    for (const { node, deferUsage } of detailList) {
      // TODO: add support for fragmentVariableValues
      if (deferUsage) {
        const selections = addInlineFragment(deferUsage);
        selections.push(node);
      } else {
        rootSelections.push(node);
      }
    }
  }

  return { kind: Kind.SELECTION_SET, selections: rootSelections };
}

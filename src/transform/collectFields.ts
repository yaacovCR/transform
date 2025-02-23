import type {
  FieldNode,
  FragmentDefinitionNode,
  FragmentSpreadNode,
  GraphQLObjectType,
  GraphQLSchema,
  InlineFragmentNode,
  SelectionSetNode,
  ValidatedExecutionArgs,
} from 'graphql';
import {
  getDirectiveValues,
  GraphQLDeferDirective,
  GraphQLIncludeDirective,
  GraphQLSkipDirective,
  isAbstractType,
  Kind,
  typeFromAST,
} from 'graphql';
// eslint-disable-next-line n/no-missing-import
import type { FragmentDetails } from 'graphql/execution/collectFields.js';
// eslint-disable-next-line n/no-missing-import
import type { VariableValues } from 'graphql/execution/values.js';
// eslint-disable-next-line n/no-missing-import
import { getFragmentVariableValues } from 'graphql/execution/values.js';

import { AccumulatorMap } from '../jsutils/AccumulatorMap.js';
import { invariant } from '../jsutils/invariant.js';
import type { ObjMap } from '../jsutils/ObjMap.js';

export interface DeferUsage {
  label: string | undefined;
  parentDeferUsage: DeferUsage | undefined;
}

export interface FieldDetails {
  node: FieldNode;
  deferUsage?: DeferUsage | undefined;
  fragmentVariableValues?: VariableValues | undefined;
}

export type GroupedFieldSet = Map<string, ReadonlyArray<FieldDetails>>;

interface CollectFieldsContext {
  schema: GraphQLSchema;
  fragments: ObjMap<FragmentDetails>;
  variableValues: VariableValues;
  runtimeType: GraphQLObjectType;
  visitedFragmentNames: Set<string>;
  hideSuggestions: boolean;
}

export interface GroupedFieldSetTree {
  groupedFieldSet: GroupedFieldSet;
  deferredFragmentDetails: Map<string, GroupedFieldSetTree>;
}

/**
 * Given a selectionSet, collects all of the fields and returns them.
 *
 * CollectFields requires the "runtime type" of an object. For a field that
 * returns an Interface or Union type, the "runtime type" will be the actual
 * object type returned by that field.
 *
 * @internal
 */

export function collectRootFields(
  validatedExecutionArgs: ValidatedExecutionArgs,
  runtimeType: GraphQLObjectType,
): GroupedFieldSetTree {
  const { schema, fragments, operation, variableValues, hideSuggestions } =
    validatedExecutionArgs;
  const context: CollectFieldsContext = {
    schema,
    fragments,
    variableValues,
    runtimeType,
    visitedFragmentNames: new Set(),
    hideSuggestions,
  };

  const groupedFieldSet = new AccumulatorMap<string, FieldDetails>();
  const deferredFragmentDetails = new Map<string, GroupedFieldSetTree>();
  collectFieldsImpl(
    context,
    operation.selectionSet,
    groupedFieldSet,
    deferredFragmentDetails,
  );
  return { groupedFieldSet, deferredFragmentDetails };
}

/**
 * Given an array of field nodes, collects all of the subfields of the passed
 * in fields, and returns them at the end.
 *
 * CollectSubFields requires the "return type" of an object. For a field that
 * returns an Interface or Union type, the "return type" will be the actual
 * object type returned by that field.
 *
 * @internal
 */
export function collectSubfields(
  validatedExecutionArgs: ValidatedExecutionArgs,
  returnType: GraphQLObjectType,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
): GroupedFieldSetTree {
  const { schema, fragments, variableValues, hideSuggestions } =
    validatedExecutionArgs;
  const context: CollectFieldsContext = {
    schema,
    fragments,
    variableValues,
    runtimeType: returnType,
    visitedFragmentNames: new Set(),
    hideSuggestions,
  };
  const groupedFieldSet = new AccumulatorMap<string, FieldDetails>();
  const deferredFragmentDetails = new Map<string, GroupedFieldSetTree>();

  for (const fieldDetail of fieldDetailsList) {
    const deferUsage = fieldDetail.deferUsage;
    const selectionSet = fieldDetail.node.selectionSet;
    if (selectionSet) {
      const { fragmentVariableValues } = fieldDetail;
      collectFieldsImpl(
        context,
        selectionSet,
        groupedFieldSet,
        deferredFragmentDetails,
        deferUsage,
        fragmentVariableValues,
      );
    }
  }

  return { groupedFieldSet, deferredFragmentDetails };
}

// eslint-disable-next-line @typescript-eslint/max-params
function collectFieldsImpl(
  context: CollectFieldsContext,
  selectionSet: SelectionSetNode,
  groupedFieldSet: AccumulatorMap<string, FieldDetails>,
  deferredFragmentDetails: Map<string, GroupedFieldSetTree>,
  deferUsage?: DeferUsage,
  fragmentVariableValues?: VariableValues,
): void {
  const {
    schema,
    fragments,
    variableValues,
    runtimeType,
    visitedFragmentNames,
    hideSuggestions,
  } = context;

  for (const selection of selectionSet.selections) {
    switch (selection.kind) {
      case Kind.FIELD: {
        if (
          !shouldIncludeNode(selection, variableValues, fragmentVariableValues)
        ) {
          continue;
        }
        groupedFieldSet.add(getFieldEntryKey(selection), {
          node: selection,
          deferUsage,
          fragmentVariableValues,
        });
        break;
      }
      case Kind.INLINE_FRAGMENT: {
        if (
          !shouldIncludeNode(
            selection,
            variableValues,
            fragmentVariableValues,
          ) ||
          !doesFragmentConditionMatch(schema, selection, runtimeType)
        ) {
          continue;
        }

        collectFragment(
          context,
          selection,
          selection.selectionSet,
          groupedFieldSet,
          deferredFragmentDetails,
          variableValues,
          deferUsage,
          fragmentVariableValues,
        );

        break;
      }
      case Kind.FRAGMENT_SPREAD: {
        const fragName = selection.name.value;

        if (
          visitedFragmentNames.has(fragName) ||
          !shouldIncludeNode(selection, variableValues, fragmentVariableValues)
        ) {
          continue;
        }

        const fragment = fragments[fragName];
        if (
          fragment == null ||
          !doesFragmentConditionMatch(schema, fragment.definition, runtimeType)
        ) {
          continue;
        }

        const fragmentVariableSignatures = fragment.variableSignatures;
        let newFragmentVariableValues: VariableValues | undefined;
        if (fragmentVariableSignatures) {
          newFragmentVariableValues = getFragmentVariableValues(
            selection,
            fragmentVariableSignatures,
            variableValues,
            fragmentVariableValues,
            hideSuggestions,
          );
        }

        collectFragment(
          context,
          selection,
          fragment.definition.selectionSet,
          groupedFieldSet,
          deferredFragmentDetails,
          variableValues,
          deferUsage,
          newFragmentVariableValues,
        );

        break;
      }
    }
  }
}

// eslint-disable-next-line @typescript-eslint/max-params
function collectFragment(
  context: CollectFieldsContext,
  selection: FragmentSpreadNode | InlineFragmentNode,
  selectionSet: SelectionSetNode,
  groupedFieldSet: AccumulatorMap<string, FieldDetails>,
  deferredFragmentDetails: Map<string, GroupedFieldSetTree>,
  variableValues: VariableValues,
  deferUsage?: DeferUsage,
  fragmentVariableValues?: VariableValues,
): boolean {
  const newDeferLabel = isDeferred(
    selection,
    variableValues,
    fragmentVariableValues,
  );
  if (newDeferLabel !== undefined) {
    collectNewDeferredFragment(
      context,
      selectionSet,
      deferredFragmentDetails,
      newDeferLabel,
      deferUsage,
      fragmentVariableValues,
    );
    return true;
  }

  if (selection.kind === Kind.FRAGMENT_SPREAD) {
    context.visitedFragmentNames.add(selection.name.value);
  }

  collectFieldsImpl(
    context,
    selectionSet,
    groupedFieldSet,
    deferredFragmentDetails,
    deferUsage,
    fragmentVariableValues,
  );
  return false;
}

// eslint-disable-next-line @typescript-eslint/max-params
function collectNewDeferredFragment(
  context: CollectFieldsContext,
  selectionSet: SelectionSetNode,
  deferredFragmentDetails: Map<string, GroupedFieldSetTree>,
  newDeferLabel: string,
  deferUsage?: DeferUsage,
  fragmentVariableValues?: VariableValues,
): void {
  const deferredGroupedFieldSet = new AccumulatorMap<string, FieldDetails>();
  const nestedDeferredFragmentDetails = new Map<string, GroupedFieldSetTree>();
  const newDeferUsage = {
    label: newDeferLabel,
    parentDeferUsage: deferUsage,
  };
  collectFieldsImpl(
    context,
    selectionSet,
    deferredGroupedFieldSet,
    nestedDeferredFragmentDetails,
    newDeferUsage,
    fragmentVariableValues,
  );
  deferredFragmentDetails.set(newDeferLabel, {
    groupedFieldSet: deferredGroupedFieldSet,
    deferredFragmentDetails: nestedDeferredFragmentDetails,
  });
}

/**
 * Determines if a field should be included based on the `@include` and `@skip`
 * directives, where `@skip` has higher precedence than `@include`.
 */
function shouldIncludeNode(
  node: FragmentSpreadNode | FieldNode | InlineFragmentNode,
  variableValues: VariableValues,
  fragmentVariableValues: VariableValues | undefined,
): boolean {
  const skip = getDirectiveValues(
    GraphQLSkipDirective,
    node,
    variableValues,
    fragmentVariableValues,
  );
  if (skip?.if === true) {
    return false;
  }

  const include = getDirectiveValues(
    GraphQLIncludeDirective,
    node,
    variableValues,
    fragmentVariableValues,
  );
  if (include?.if === false) {
    return false;
  }
  return true;
}

/**
 * Determines if a fragment is applicable to the given type.
 */
function doesFragmentConditionMatch(
  schema: GraphQLSchema,
  fragment: FragmentDefinitionNode | InlineFragmentNode,
  type: GraphQLObjectType,
): boolean {
  const typeConditionNode = fragment.typeCondition;
  if (!typeConditionNode) {
    return true;
  }
  const conditionalType = typeFromAST(schema, typeConditionNode);
  if (conditionalType === type) {
    return true;
  }
  if (isAbstractType(conditionalType)) {
    return schema.isSubType(conditionalType, type);
  }
  return false;
}

/**
 * Implements the logic to compute the key of a given field's entry
 */
function getFieldEntryKey(node: FieldNode): string {
  return node.alias ? node.alias.value : node.name.value;
}

/**
 * Implements the logic to check if a fragment annotated with the `@defer`
 * directive has been actually deferred or inlined.
 */
function isDeferred(
  node: FragmentSpreadNode | FieldNode | InlineFragmentNode,
  variableValues: VariableValues,
  fragmentVariableValues: VariableValues | undefined,
): string | undefined {
  const defer = getDirectiveValues(
    GraphQLDeferDirective,
    node,
    variableValues,
    fragmentVariableValues,
  );
  if (!defer || defer?.if === false) {
    return;
  }

  const label = defer.label;
  invariant(typeof label === 'string');
  return label;
}

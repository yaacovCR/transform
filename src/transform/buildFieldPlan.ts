import type {
  ExecutionResult,
  ExperimentalIncrementalExecutionResults,
  GraphQLObjectType,
  GraphQLSchema,
  OperationDefinitionNode,
  ValidatedExecutionArgs,
} from 'graphql';
import { experimentalExecuteQueryOrMutationOrSubscriptionEvent } from 'graphql';
import type {
  DeferUsage,
  FieldDetails,
  FragmentDetails,
  GroupedFieldSet,
  // eslint-disable-next-line n/no-missing-import
} from 'graphql/execution/collectFields.js';
import {
  collectFields,
  collectSubfields,
  // eslint-disable-next-line n/no-missing-import
} from 'graphql/execution/collectFields.js';
// eslint-disable-next-line n/no-missing-import
import type { VariableValues } from 'graphql/execution/values.js';

import { invariant } from '../jsutils/invariant.js';
import { mapValue } from '../jsutils/mapValue.js';
import { memoize3 } from '../jsutils/memoize3.js';
import type { ObjMap } from '../jsutils/ObjMap.js';
import type { PromiseOrValue } from '../jsutils/PromiseOrValue.js';

import type {
  Executor,
  SubschemaConfig,
} from './buildTransformationContext.js';
import { groupedFieldSetToSelectionSet } from './groupedFieldSetToSelectionSet.js';
import { transformSelectionSetForTargetSubschema } from './transformSelectionSetForTargetSubschema.js';

interface PlanContext {
  superschema: GraphQLSchema;
  subschemas: ObjMap<SubschemaConfig>;
  operation: OperationDefinitionNode;
  fragments: ObjMap<FragmentDetails>;
  variableValues: VariableValues;
  fragmentsBySubschema: ObjMap<ObjMap<FragmentDetails>>;
  hideSuggestions: boolean;
  originalArgs: ValidatedExecutionArgs;
  prefix: string;
}

interface RootFieldPlan {
  plansBySubschema: Map<SubschemaConfig, SubschemaPlan>;
  newDeferUsages: ReadonlyArray<DeferUsage>;
}

interface SubschemaPlan {
  groupedFieldSet: GroupedFieldSet;
  executor: () => PromiseOrValue<
    ExecutionResult | ExperimentalIncrementalExecutionResults
  >;
}

export function buildRootFieldPlan(
  context: PlanContext,
  rootType: GraphQLObjectType,
): RootFieldPlan {
  const {
    superschema,
    subschemas,
    operation,
    fragments,
    variableValues,
    fragmentsBySubschema,
    hideSuggestions,
    originalArgs,
    prefix,
  } = context;

  const { groupedFieldSet: originalGroupedFieldSet, newDeferUsages } =
    collectFields(
      superschema,
      fragments,
      variableValues,
      rootType,
      operation.selectionSet,
      hideSuggestions,
    );

  const plansBySubschema = new Map<SubschemaConfig, SubschemaPlan>();
  const usedKeys = new Set<string>();
  for (const subschemaConfig of Object.values(subschemas)) {
    const subschema = subschemaConfig.schema;

    const subschemaRootType = subschema.getRootType(operation.operation);
    invariant(subschemaRootType != null);

    const filteredGroupedFieldSet = filterGroupedFieldSet(
      originalGroupedFieldSet,
      subschema,
      subschemaRootType,
      usedKeys,
    );

    if (filteredGroupedFieldSet.size > 0) {
      const executor: Executor =
        subschemaConfig.executor ??
        experimentalExecuteQueryOrMutationOrSubscriptionEvent;

      const selectionSet = groupedFieldSetToSelectionSet(
        filteredGroupedFieldSet,
      );

      const transformedFragments = fragmentsBySubschema[subschemaConfig.label];
      invariant(transformedFragments !== undefined);

      const result = () =>
        executor({
          ...originalArgs,
          schema: subschema,
          operation: {
            ...operation,
            selectionSet: transformSelectionSetForTargetSubschema(
              selectionSet,
              transformedFragments,
              subschemaRootType,
              subschema,
              prefix,
            ),
          },
          fragments: transformedFragments,
          fragmentDefinitions: mapValue(
            transformedFragments,
            (details) => details.definition,
          ),
        });

      plansBySubschema.set(subschemaConfig, {
        groupedFieldSet: filteredGroupedFieldSet,
        executor: result,
      });
    }
  }

  return {
    plansBySubschema,
    newDeferUsages,
  };
}

function filterGroupedFieldSet(
  originalGroupedFieldSet: GroupedFieldSet,
  subschema: GraphQLSchema,
  parentType: GraphQLObjectType,
  usedKeys: Set<string>,
): GroupedFieldSet {
  const filteredMap = new Map<string, ReadonlyArray<FieldDetails>>();

  for (const [responseKey, fieldDetailsList] of originalGroupedFieldSet) {
    if (usedKeys.has(responseKey)) {
      continue;
    }

    const fieldName = fieldDetailsList[0].node.name.value;
    const fieldDef = subschema.getField(parentType, fieldName);
    if (fieldDef) {
      filteredMap.set(responseKey, fieldDetailsList);
      usedKeys.add(responseKey);
    }
  }
  return filteredMap;
}

const _collectSubfields = memoize3(
  (
    context: PlanContext,
    returnType: GraphQLObjectType,
    fieldDetailsList: ReadonlyArray<FieldDetails>,
  ) => {
    const { superschema, fragments, variableValues, hideSuggestions } = context;
    return collectSubfields(
      superschema,
      fragments,
      variableValues,
      returnType,
      fieldDetailsList,
      hideSuggestions,
    );
  },
);

export function buildSubFieldPlan(
  context: PlanContext,
  returnType: GraphQLObjectType,
  fieldDetailsList: ReadonlyArray<FieldDetails>,
): {
  groupedFieldSet: GroupedFieldSet;
  newDeferUsages: ReadonlyArray<DeferUsage>;
} {
  return _collectSubfields(context, returnType, fieldDetailsList);
}

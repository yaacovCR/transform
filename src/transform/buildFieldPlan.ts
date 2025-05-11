import type {
  ExecutionResult,
  ExperimentalIncrementalExecutionResults,
  GraphQLObjectType,
  GraphQLSchema,
  OperationDefinitionNode,
  ValidatedExecutionArgs,
} from 'graphql';
import {
  experimentalExecuteQueryOrMutationOrSubscriptionEvent,
  isObjectType,
} from 'graphql';
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
import { memoize3of5 } from '../jsutils/memoize3of5.js';
import type { ObjMap } from '../jsutils/ObjMap.js';
import type { PromiseOrValue } from '../jsutils/PromiseOrValue.js';

import type { DeferUsageSet } from './buildDeferPlan.js';
import type {
  DeferPlanBuilder,
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
  deferPlanBuilder: DeferPlanBuilder;
  prefix: string;
}

interface SubfieldPlan {
  groupedFieldSet: GroupedFieldSet;
  newGroupedFieldSets: Map<DeferUsageSet, GroupedFieldSet>;
  plansBySubschema: Map<SubschemaConfig, SubschemaPlan>;
  newDeferUsages: ReadonlyArray<DeferUsage>;
}

interface RootFieldPlan {
  plansBySubschema: Map<SubschemaConfig, SubschemaPlan>;
  newDeferUsages: ReadonlyArray<DeferUsage>;
}

export interface SubschemaPlan {
  groupedFieldSet: GroupedFieldSet;
  newGroupedFieldSets: Map<DeferUsageSet, GroupedFieldSet>;
  executor: () => PromiseOrValue<
    ExecutionResult | ExperimentalIncrementalExecutionResults
  >;
}

export function buildRootFieldPlan(
  context: PlanContext,
  rootType: GraphQLObjectType,
): RootFieldPlan {
  const { superschema, operation, fragments, variableValues, hideSuggestions } =
    context;

  const { groupedFieldSet: originalGroupedFieldSet, newDeferUsages } =
    collectFields(
      superschema,
      fragments,
      variableValues,
      rootType,
      operation.selectionSet,
      hideSuggestions,
    );

  const { plansBySubschema } = getPlansBySubschema(
    context,
    originalGroupedFieldSet,
    rootType,
  );

  return {
    plansBySubschema,
    newDeferUsages,
  };
}

function getPlansBySubschema(
  context: PlanContext,
  originalGroupedFieldSet: GroupedFieldSet,
  parentType: GraphQLObjectType,
): {
  groupedFieldSet: undefined;
  newGroupedFieldSets: undefined;
  plansBySubschema: Map<SubschemaConfig, SubschemaPlan>;
};
function getPlansBySubschema(
  context: PlanContext,
  originalGroupedFieldSet: GroupedFieldSet,
  parentType: GraphQLObjectType,
  baseSubschemaConfig: SubschemaConfig,
  deferUsageSet: DeferUsageSet | undefined,
): {
  groupedFieldSet: GroupedFieldSet;
  newGroupedFieldSets: Map<DeferUsageSet, GroupedFieldSet>;
  plansBySubschema: Map<SubschemaConfig, SubschemaPlan>;
};
function getPlansBySubschema(
  context: PlanContext,
  originalGroupedFieldSet: GroupedFieldSet,
  parentType: GraphQLObjectType,
  baseSubschemaConfig?: SubschemaConfig,
  deferUsageSet?: DeferUsageSet,
): {
  groupedFieldSet: GroupedFieldSet | undefined;
  newGroupedFieldSets: Map<DeferUsageSet, GroupedFieldSet> | undefined;
  plansBySubschema: Map<SubschemaConfig, SubschemaPlan>;
} {
  const { subschemas, operation, fragmentsBySubschema, originalArgs, prefix } =
    context;
  const plansBySubschema = new Map<SubschemaConfig, SubschemaPlan>();
  const usedKeys = new Set<string>();
  let groupedFieldSet: GroupedFieldSet | undefined;
  let newGroupedFieldSets: Map<DeferUsageSet, GroupedFieldSet> | undefined;
  for (const subschemaConfig of Object.values(subschemas)) {
    const subschema = subschemaConfig.schema;

    const subschemaParentType = subschema.getType(parentType.name);
    invariant(isObjectType(subschemaParentType));
    const filteredGroupedFieldSet = new Map<
      string,
      ReadonlyArray<FieldDetails>
    >();

    for (const [responseKey, fieldDetailsList] of originalGroupedFieldSet) {
      if (usedKeys.has(responseKey)) {
        continue;
      }

      const fieldName = fieldDetailsList[0].node.name.value;
      const fieldDef = subschema.getField(subschemaParentType, fieldName);
      if (fieldDef) {
        filteredGroupedFieldSet.set(responseKey, fieldDetailsList);
        usedKeys.add(responseKey);
      }
    }

    if (subschemaConfig === baseSubschemaConfig) {
      ({ groupedFieldSet, newGroupedFieldSets } = context.deferPlanBuilder(
        filteredGroupedFieldSet,
        deferUsageSet,
      ));
      continue;
    }

    const executor: Executor =
      subschemaConfig.executor ??
      experimentalExecuteQueryOrMutationOrSubscriptionEvent;

    const selectionSet = groupedFieldSetToSelectionSet(filteredGroupedFieldSet);

    const transformedFragments = fragmentsBySubschema[subschemaConfig.label];
    invariant(transformedFragments !== undefined);

    if (filteredGroupedFieldSet.size > 0) {
      const result = () =>
        executor({
          ...originalArgs,
          schema: subschema,
          operation: {
            ...operation,
            selectionSet: transformSelectionSetForTargetSubschema(
              selectionSet,
              transformedFragments,
              subschemaParentType,
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
        ...context.deferPlanBuilder(filteredGroupedFieldSet, deferUsageSet),
        executor: result,
      });
    }
  }

  return {
    groupedFieldSet,
    newGroupedFieldSets,
    plansBySubschema,
  };
}

export const buildSubfieldPlan = memoize3of5(
  (
    context: PlanContext,
    returnType: GraphQLObjectType,
    fieldDetailsList: ReadonlyArray<FieldDetails>,
    subschemaConfig: SubschemaConfig,
    deferUsageSet: DeferUsageSet | undefined,
  ): SubfieldPlan => {
    const { superschema, fragments, variableValues, hideSuggestions } = context;
    const { groupedFieldSet: originalGroupedFieldSet, newDeferUsages } =
      collectSubfields(
        superschema,
        fragments,
        variableValues,
        returnType,
        fieldDetailsList,
        hideSuggestions,
      );

    return {
      ...getPlansBySubschema(
        context,
        originalGroupedFieldSet,
        returnType,
        subschemaConfig,
        deferUsageSet,
      ),
      newDeferUsages,
    };
  },
);

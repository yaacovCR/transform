import type {
  ExecutionArgs,
  ExecutionResult,
  GraphQLObjectType,
  GraphQLSchema,
} from 'graphql';
import {
  experimentalExecuteQueryOrMutationOrSubscriptionEvent,
  GraphQLError,
} from 'graphql';
import type {
  FieldDetails,
  GroupedFieldSet,
  // eslint-disable-next-line n/no-missing-import
} from 'graphql/execution/collectFields.js';
import {
  collectFields,
  // eslint-disable-next-line n/no-missing-import
} from 'graphql/execution/collectFields.js';
// eslint-disable-next-line n/no-missing-import
import { validateExecutionArgs } from 'graphql/execution/execute.js';
import type {
  ExperimentalIncrementalExecutionResults,
  // eslint-disable-next-line n/no-missing-import
} from 'graphql/execution/types.js';

import { invariant } from '../jsutils/invariant.js';
import { isPromise } from '../jsutils/isPromise.js';
import { mapValue } from '../jsutils/mapValue.js';
import type { ObjMap } from '../jsutils/ObjMap.js';
import type { PromiseOrValue } from '../jsutils/PromiseOrValue.js';

import { buildBranchingExecutionPlan } from './buildBranchingExecutionPlan.js';
import type { DeferUsageSet, ExecutionPlan } from './buildExecutionPlan.js';
import { buildExecutionPlan } from './buildExecutionPlan.js';
import type {
  Executor,
  SubschemaConfig,
  Transformers,
} from './buildTransformationContext.js';
import { buildTransformationContext } from './buildTransformationContext.js';
import type { CompletedInitialResult } from './completeValue.js';
import { completeInitialResult } from './completeValue.js';
import { getDefaultPayloadPublisher } from './getDefaultPayloadPublisher.js';
import type { LegacyExperimentalIncrementalExecutionResults } from './getLegacyPayloadPublisher.js';
import { getLegacyPayloadPublisher } from './getLegacyPayloadPublisher.js';
import { groupedFieldSetToSelectionSet } from './groupedFieldSetToSelectionSet.js';
import { IncrementalPublisher } from './IncrementalPublisher.js';
import { MergedResult } from './MergedResult.js';
import type { PayloadPublisher } from './PayloadPublisher.js';
import { transformSelectionSetForTargetSubschema } from './transformSelectionSetForTargetSubschema.js';
import type { DeferredFragment, IncrementalDataRecord } from './types.js';

export interface TransformArgs extends ExecutionArgs {
  subschemas?: ReadonlyArray<SubschemaConfig> | undefined;
  transformers?: Transformers | undefined;
  useLegacyIncremental?: boolean | undefined;
  prefix?: string | undefined;
}

export function transform(
  args: TransformArgs & { useLegacyIncremental?: false | undefined },
): PromiseOrValue<ExecutionResult | ExperimentalIncrementalExecutionResults>;
export function transform(
  args: TransformArgs & { useLegacyIncremental: true },
): PromiseOrValue<
  ExecutionResult | LegacyExperimentalIncrementalExecutionResults
>;
export function transform(
  args: TransformArgs,
): PromiseOrValue<
  | ExecutionResult
  | ExperimentalIncrementalExecutionResults
  | LegacyExperimentalIncrementalExecutionResults
> {
  const originalArgs = validateExecutionArgs(args);

  if (!('schema' in originalArgs)) {
    return { errors: originalArgs };
  }

  const {
    subschemas = [
      {
        label: 'target',
        schema: originalArgs.schema,
      },
    ],
    transformers = {},
    useLegacyIncremental = false,
    prefix = '__transform__',
  } = args;

  let payloadPublisher: PayloadPublisher<any, any>;
  let executionPlanBuilder: (
    originalGroupedFieldSet: GroupedFieldSet,
    parentDeferUsages?: DeferUsageSet,
  ) => ExecutionPlan;
  if (useLegacyIncremental) {
    payloadPublisher = getLegacyPayloadPublisher();
    executionPlanBuilder = buildBranchingExecutionPlan;
  } else {
    payloadPublisher = getDefaultPayloadPublisher();
    executionPlanBuilder = buildExecutionPlan;
  }

  const context = buildTransformationContext(
    originalArgs,
    subschemas,
    transformers,
    executionPlanBuilder,
    prefix,
  );

  const mergedResult = new MergedResult();
  const transformedResults: Array<
    PromiseOrValue<ExecutionResult | CompletedInitialResult>
  > = [];

  const usedKeys = new Set<string>();
  let containsPromise = false;
  for (const subschemaConfig of Object.values(
    args.subschemas ?? {
      target: {
        label: 'target',
        schema: args.schema,
      },
    },
  )) {
    const {
      superschema,
      operation,
      fragments,
      variableValues,
      fragmentsBySubschema,
      hideSuggestions,
    } = context;

    const { schema: subschema, label: subschemaLabel } = subschemaConfig;

    const superschemaRootType = superschema.getRootType(operation.operation);
    if (superschemaRootType == null) {
      return {
        data: null,
        errors: [
          new GraphQLError(
            `Schema is not configured to execute ${operation.operation} operation.`,
            {
              nodes: [operation],
            },
          ),
        ],
      };
    }

    const transformedFragments = fragmentsBySubschema[subschemaLabel];

    const { groupedFieldSet: originalGroupedFieldSet, newDeferUsages } =
      collectFields(
        superschema,
        fragments,
        variableValues,
        superschemaRootType,
        operation.selectionSet,
        hideSuggestions,
      );

    const subschemaRootType = subschema.getRootType(operation.operation);
    invariant(subschemaRootType != null);

    const filteredGroupedFieldSet = filterGroupedFieldSet(
      originalGroupedFieldSet,
      subschema,
      subschemaRootType,
      usedKeys,
    );

    const selectionSet = groupedFieldSetToSelectionSet(filteredGroupedFieldSet);

    const executor: Executor =
      subschemaConfig.executor ??
      experimentalExecuteQueryOrMutationOrSubscriptionEvent;

    const originalResult = executor({
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

    if (isPromise(originalResult)) {
      containsPromise = true;
      transformedResults.push(
        originalResult.then((resolved) =>
          completeInitialResult(
            context,
            superschemaRootType,
            filteredGroupedFieldSet,
            newDeferUsages,
            subschemaLabel,
            resolved,
            mergedResult,
          ),
        ),
      );
      continue;
    }
    const transformed = completeInitialResult(
      context,
      superschemaRootType,
      filteredGroupedFieldSet,
      newDeferUsages,
      subschemaLabel,
      originalResult,
      mergedResult,
    );
    // TODO: add test case for asynchronous transform
    /* c8 ignore next 3 */
    if (isPromise(transformed)) {
      containsPromise = true;
    }
    transformedResults.push(transformed);
  }

  if (containsPromise) {
    return Promise.all(transformedResults).then((resolved) =>
      buildResponse(resolved, mergedResult, payloadPublisher),
    );
  }

  return buildResponse(
    transformedResults as Array<ExecutionResult | CompletedInitialResult>,
    mergedResult,
    payloadPublisher,
  );
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

function buildResponse<TSubsequent, TIncremental>(
  transformedResults: Array<ExecutionResult | CompletedInitialResult>,
  mergedResult: MergedResult,
  payloadPublisher: PayloadPublisher<TSubsequent, TIncremental>,
): PromiseOrValue<ExecutionResult | TIncremental> {
  let mergedData: ObjMap<unknown> | null = Object.create(null);
  const mergedErrors: Array<GraphQLError> = [];
  const mergedDeferredFragments: Array<DeferredFragment> = [];
  const mergedIncrementalDataRecords: Array<IncrementalDataRecord> = [];

  for (const transformedResult of transformedResults) {
    const { data, errors } = transformedResult;
    if (data == null) {
      mergedData = null;
    } else if (mergedData !== null) {
      Object.assign(mergedData, data);
    }
    if (errors) {
      mergedErrors.push(...errors);
    }
    if (!('deferredFragments' in transformedResult)) {
      continue;
    }
    const { deferredFragments, incrementalDataRecords } = transformedResult;
    mergedDeferredFragments.push(...deferredFragments);
    mergedIncrementalDataRecords.push(...incrementalDataRecords);
  }

  if (mergedData === null) {
    return {
      errors: mergedErrors,
      data: mergedData,
    };
  }

  if (mergedIncrementalDataRecords.length === 0) {
    return mergedErrors.length === 0
      ? { data: mergedData }
      : { errors: mergedErrors, data: mergedData };
  }

  const incrementalPublisher = new IncrementalPublisher(
    payloadPublisher,
    mergedResult,
  );

  return incrementalPublisher.buildResponse(
    mergedData,
    mergedErrors,
    mergedDeferredFragments,
    mergedIncrementalDataRecords,
  );
}

import type {
  ExecutionArgs,
  ExecutionResult,
  GraphQLError,
  OperationDefinitionNode,
} from 'graphql';
import { experimentalExecuteQueryOrMutationOrSubscriptionEvent } from 'graphql';
import type {
  FragmentDetails,
  GroupedFieldSet,
  // eslint-disable-next-line n/no-missing-import
} from 'graphql/execution/collectFields.js';
// eslint-disable-next-line n/no-missing-import
import { validateExecutionArgs } from 'graphql/execution/execute.js';
import type {
  ExperimentalIncrementalExecutionResults,
  // eslint-disable-next-line n/no-missing-import
} from 'graphql/execution/types.js';

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
import { IncrementalPublisher } from './IncrementalPublisher.js';
import { MergedResult } from './MergedResult.js';
import type { PayloadPublisher } from './PayloadPublisher.js';
import { transformForTargetSubschema } from './transformForTargetSubschema.js';
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

  const argsWithNewLabels = context.argsWithNewLabels;

  const withExecutors: Array<{
    subschemaConfig: SubschemaConfig;
    operation: OperationDefinitionNode;
    fragments: ObjMap<FragmentDetails>;
    executor: () => PromiseOrValue<
      ExecutionResult | ExperimentalIncrementalExecutionResults
    >;
  }> = [];
  for (const subschemaConfig of Object.values(
    args.subschemas ?? {
      target: {
        label: 'target',
        schema: args.schema,
      },
    },
  )) {
    const { operation, fragments } = argsWithNewLabels;
    const subschema = subschemaConfig.schema;
    const transformedForSubschema = transformForTargetSubschema(
      operation,
      fragments,
      subschema,
      prefix,
    );

    if (!('operation' in transformedForSubschema)) {
      // return `data: null` to mimic non-gateway behavior
      return { data: null, errors: transformedForSubschema };
    }

    const executor: Executor =
      subschemaConfig.executor ??
      experimentalExecuteQueryOrMutationOrSubscriptionEvent;

    const { operation: transformedOperation, fragments: transformedFragments } =
      transformedForSubschema;

    const transformedFragmentDefinitions = mapValue(
      transformedFragments,
      (details) => details.definition,
    );

    withExecutors.push({
      subschemaConfig,
      operation: transformedOperation,
      fragments: transformedFragments,
      executor: () =>
        executor({
          ...argsWithNewLabels,
          schema: subschema,
          operation: transformedOperation,
          fragments: transformedFragments,
          fragmentDefinitions: transformedFragmentDefinitions,
        }),
    });
  }

  const mergedResult = new MergedResult();
  const transformedResults: Array<
    PromiseOrValue<ExecutionResult | CompletedInitialResult>
  > = [];

  let containsPromise = false;
  for (const {
    subschemaConfig,
    operation,
    fragments,
    executor,
  } of withExecutors) {
    const originalResult = executor();
    const subschemaLabel = subschemaConfig.label;
    if (isPromise(originalResult)) {
      containsPromise = true;
      transformedResults.push(
        originalResult.then((resolved) => {
          mergedResult.add(subschemaLabel, resolved);
          return completeInitialResult(
            context,
            operation,
            fragments,
            mergedResult.getMergedData(),
          );
        }),
      );
      continue;
    }
    mergedResult.add(subschemaLabel, originalResult);
    const transformed = completeInitialResult(
      context,
      operation,
      fragments,
      mergedResult.getMergedData(),
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

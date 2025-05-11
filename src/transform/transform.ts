import type { ExecutionArgs, ExecutionResult } from 'graphql';
import { GraphQLError } from 'graphql';
import type {
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
import type { ObjMap } from '../jsutils/ObjMap.js';
import type { PromiseOrValue } from '../jsutils/PromiseOrValue.js';

import { buildBranchingDeferPlan } from './buildBranchingDeferPlan.js';
import type { DeferPlan, DeferUsageSet } from './buildDeferPlan.js';
import { buildDeferPlan } from './buildDeferPlan.js';
import { buildRootFieldPlan } from './buildFieldPlan.js';
import type {
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
import { interpolateFragmentArguments } from './interpolateFragmentArguments.js';
import type { MergedResult } from './MergedResult.js';
import type { PayloadPublisher } from './PayloadPublisher.js';
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
  const originalArgs = validateExecutionArgs({
    ...args,
    document: interpolateFragmentArguments(args.document),
  });

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
  let deferPlanBuilder: (
    originalGroupedFieldSet: GroupedFieldSet,
    parentDeferUsages?: DeferUsageSet,
  ) => DeferPlan;
  if (useLegacyIncremental) {
    payloadPublisher = getLegacyPayloadPublisher();
    deferPlanBuilder = buildBranchingDeferPlan;
  } else {
    payloadPublisher = getDefaultPayloadPublisher();
    deferPlanBuilder = buildDeferPlan;
  }

  const context = buildTransformationContext(
    originalArgs,
    subschemas,
    transformers,
    deferPlanBuilder,
    prefix,
  );

  const transformedResults: Array<
    PromiseOrValue<ExecutionResult | CompletedInitialResult>
  > = [];

  const { superschema, operation } = context;

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

  const { plansBySubschema, newDeferUsages } = buildRootFieldPlan(
    context,
    superschemaRootType,
  );

  let containsPromise = false;
  for (const subschemaConfig of Object.values(subschemas)) {
    const subschemaPlan = plansBySubschema.get(subschemaConfig);
    if (subschemaPlan === undefined) {
      continue;
    }

    const { groupedFieldSet, newGroupedFieldSets, executor } = subschemaPlan;

    const originalResult = executor();

    if (isPromise(originalResult)) {
      containsPromise = true;
      transformedResults.push(
        originalResult.then((resolved) =>
          completeInitialResult(
            context,
            superschemaRootType,
            groupedFieldSet,
            newDeferUsages,
            newGroupedFieldSets,
            subschemaConfig,
            resolved,
          ),
        ),
      );
      continue;
    }
    const transformed = completeInitialResult(
      context,
      superschemaRootType,
      groupedFieldSet,
      newDeferUsages,
      newGroupedFieldSets,
      subschemaConfig,
      originalResult,
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
      buildResponse(resolved, context.mergedResult, payloadPublisher),
    );
  }

  return buildResponse(
    transformedResults as Array<ExecutionResult | CompletedInitialResult>,
    context.mergedResult,
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

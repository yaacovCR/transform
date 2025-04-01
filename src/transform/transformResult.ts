import type { ExecutionArgs, ExecutionResult, GraphQLError } from 'graphql';
import { experimentalExecuteQueryOrMutationOrSubscriptionEvent } from 'graphql';
// eslint-disable-next-line n/no-missing-import
import { validateExecutionArgs } from 'graphql/execution/execute.js';
import type {
  ExperimentalIncrementalExecutionResults,
  InitialIncrementalExecutionResult,
  PendingResult,
  SubsequentIncrementalExecutionResult,
  // eslint-disable-next-line n/no-missing-import
} from 'graphql/execution/types.js';

import { isPromise } from '../jsutils/isPromise.js';
import type { ObjMap } from '../jsutils/ObjMap.js';
import type { PromiseOrValue } from '../jsutils/PromiseOrValue.js';
import type { SubsequentResults } from '../jsutils/SimpleAsyncGenerator.js';

import { buildExecutionPlan } from './buildExecutionPlan.js';
import type {
  ExecutionPlanBuilder,
  TransformationContext,
  Transformers,
} from './buildTransformationContext.js';
import { buildTransformationContext } from './buildTransformationContext.js';
import { completeInitialResult } from './completeValue.js';
import { embedErrors } from './embedErrors.js';
import { getDefaultPayloadPublisher } from './getDefaultPayloadPublisher.js';
import { IncrementalPublisher } from './IncrementalPublisher.js';
import type { PayloadPublisher } from './PayloadPublisher.js';
import { transformForTargetSubschema } from './transformForTargetSubschema.js';
import type {
  DeferredFragment,
  IncrementalDataRecord,
  IncrementalResults,
} from './types.js';

export function transformResult<
  TInitial extends ExecutionResult = InitialIncrementalExecutionResult,
  TSubsequent = SubsequentIncrementalExecutionResult,
>(
  args: ExecutionArgs,
  transformers: Transformers<TInitial, TSubsequent> = {},
  payloadPublisher: PayloadPublisher<
    TInitial,
    TSubsequent
  > = getDefaultPayloadPublisher() as unknown as PayloadPublisher<
    TInitial,
    TSubsequent
  >,
  executionPlanBuilder: ExecutionPlanBuilder = buildExecutionPlan,
  prefix = '__transformResult__',
): PromiseOrValue<ExecutionResult | IncrementalResults<TInitial, TSubsequent>> {
  const originalArgs = validateExecutionArgs(args);

  if (!('schema' in originalArgs)) {
    return { errors: originalArgs };
  }

  const context = buildTransformationContext(
    originalArgs,
    transformers,
    executionPlanBuilder,
    prefix,
  );

  const argsForTargetSubschema = transformForTargetSubschema(
    context.argsWithNewLabels,
    prefix,
  );

  const originalResult = experimentalExecuteQueryOrMutationOrSubscriptionEvent(
    argsForTargetSubschema,
  );

  return isPromise(originalResult)
    ? originalResult.then((resolved) =>
        transformOriginalResult(context, resolved, payloadPublisher),
      )
    : transformOriginalResult(context, originalResult, payloadPublisher);
}

function transformOriginalResult<TInitial extends ExecutionResult, TSubsequent>(
  context: TransformationContext<TInitial, TSubsequent>,
  result: ExecutionResult | ExperimentalIncrementalExecutionResults,
  payloadPublisher: PayloadPublisher<TInitial, TSubsequent>,
): PromiseOrValue<ExecutionResult | IncrementalResults<TInitial, TSubsequent>> {
  if ('initialResult' in result) {
    const { initialResult, subsequentResults } = result;
    const { data, errors, pending } = initialResult;

    embedErrors(data, errors);

    const completed = completeInitialResult(context, data);

    return isPromise(completed)
      ? completed.then((resolved) =>
          buildIncrementalResponse(
            data,
            resolved,
            payloadPublisher,
            pending,
            subsequentResults,
          ),
        )
      : buildIncrementalResponse(
          data,
          completed,
          payloadPublisher,
          pending,
          subsequentResults,
        );
  }

  const { data: originalData, errors: originalErrors } = result;
  if (originalData == null) {
    return result;
  }

  embedErrors(originalData, originalErrors);
  const completed = completeInitialResult(context, originalData);

  if (isPromise(completed)) {
    return completed.then((resolved) =>
      buildResponse(resolved, originalData, payloadPublisher),
    );
  }

  return buildResponse(completed, originalData, payloadPublisher);
}

function buildResponse<TInitial, TSubsequent>(
  completed: {
    data: ObjMap<unknown>;
    errors: ReadonlyArray<GraphQLError>;
    deferredFragments: ReadonlyArray<
      DeferredFragment<IncrementalResults<TInitial, TSubsequent>>
    >;
    incrementalDataRecords: ReadonlyArray<
      IncrementalDataRecord<IncrementalResults<TInitial, TSubsequent>>
    >;
  },
  originalData: ObjMap<unknown>,
  payloadPublisher: PayloadPublisher<TInitial, TSubsequent>,
): PromiseOrValue<ExecutionResult | IncrementalResults<TInitial, TSubsequent>> {
  const { incrementalDataRecords } = completed;
  if (incrementalDataRecords.length === 0) {
    const { data, errors } = completed;
    return errors.length === 0 ? { data } : { errors, data };
  }

  return buildIncrementalResponse(originalData, completed, payloadPublisher);
}

function buildIncrementalResponse<TInitial, TSubsequent>(
  originalData: ObjMap<unknown>,
  initialResult: {
    data: ObjMap<unknown>;
    errors: ReadonlyArray<GraphQLError>;
    deferredFragments: ReadonlyArray<
      DeferredFragment<IncrementalResults<TInitial, TSubsequent>>
    >;
    incrementalDataRecords: ReadonlyArray<
      IncrementalDataRecord<IncrementalResults<TInitial, TSubsequent>>
    >;
  },
  payloadPublisher: PayloadPublisher<TInitial, TSubsequent>,
  pending?: ReadonlyArray<PendingResult>,
  subsequentResults?: SubsequentResults<SubsequentIncrementalExecutionResult>,
): IncrementalResults<TInitial, TSubsequent> {
  const { data, errors, deferredFragments, incrementalDataRecords } =
    initialResult;

  const incrementalPublisher = new IncrementalPublisher(
    originalData,
    payloadPublisher,
    pending,
    subsequentResults,
  );

  return incrementalPublisher.buildResponse(
    data,
    errors,
    deferredFragments,
    incrementalDataRecords,
  );
}

import type {
  ExecutionArgs,
  ExecutionResult,
  ExperimentalIncrementalExecutionResults,
  GraphQLError,
} from 'graphql';
import { experimentalExecuteQueryOrMutationOrSubscriptionEvent } from 'graphql';
// eslint-disable-next-line n/no-missing-import
import { validateExecutionArgs } from 'graphql/execution/execute.js';
import type {
  PendingResult,
  SubsequentIncrementalExecutionResult,
  // eslint-disable-next-line n/no-missing-import
} from 'graphql/execution/types.js';

import { isPromise } from '../jsutils/isPromise.js';
import type { ObjMap } from '../jsutils/ObjMap.js';
import type { PromiseOrValue } from '../jsutils/PromiseOrValue.js';

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
import type { IncrementalDataRecord } from './types.js';

export function transformResult<
  TSubsequent = SubsequentIncrementalExecutionResult,
  TIncremental = ExperimentalIncrementalExecutionResults,
>(
  args: ExecutionArgs,
  transformers: Transformers = {},
  payloadPublisher: PayloadPublisher<
    TSubsequent,
    TIncremental
  > = getDefaultPayloadPublisher() as unknown as PayloadPublisher<
    TSubsequent,
    TIncremental
  >,
  executionPlanBuilder: ExecutionPlanBuilder = buildExecutionPlan,
  prefix = '__transformResult__',
): PromiseOrValue<ExecutionResult | TIncremental> {
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

function transformOriginalResult<TSubsequent, TIncremental>(
  context: TransformationContext,
  result: ExecutionResult | ExperimentalIncrementalExecutionResults,
  payloadPublisher: PayloadPublisher<TSubsequent, TIncremental>,
): PromiseOrValue<ExecutionResult | TIncremental> {
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
    return completed.then((resolved) => {
      const { incrementalDataRecords } = resolved;
      if (incrementalDataRecords.length === 0) {
        const { data, errors } = resolved;
        return errors.length === 0 ? { data } : { errors, data };
      }
      return buildIncrementalResponse(originalData, resolved, payloadPublisher);
    });
  }

  const { incrementalDataRecords } = completed;
  if (incrementalDataRecords.length === 0) {
    const { data, errors } = completed;
    return errors.length === 0 ? { data } : { errors, data };
  }

  return buildIncrementalResponse(originalData, completed, payloadPublisher);
}

function buildIncrementalResponse<TSubsequent, TIncremental>(
  originalData: ObjMap<unknown>,
  initialResult: {
    data: ObjMap<unknown>;
    errors: ReadonlyArray<GraphQLError>;
    incrementalDataRecords: ReadonlyArray<IncrementalDataRecord>;
  },
  payloadPublisher: PayloadPublisher<TSubsequent, TIncremental>,
  pending?: ReadonlyArray<PendingResult>,
  subsequentResults?: AsyncGenerator<SubsequentIncrementalExecutionResult>,
): TIncremental {
  const { data, errors, incrementalDataRecords } = initialResult;

  const incrementalPublisher = new IncrementalPublisher(
    originalData,
    payloadPublisher,
    pending,
    subsequentResults,
  );

  return incrementalPublisher.buildResponse(
    data,
    errors,
    incrementalDataRecords,
  );
}

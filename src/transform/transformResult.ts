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

import type { TransformationContext } from './buildTransformationContext.js';
import { buildTransformationContext } from './buildTransformationContext.js';
import { completeInitialResult } from './completeValue.js';
import { embedErrors } from './embedErrors.js';
import { IncrementalPublisher } from './IncrementalPublisher.js';
import type { PayloadPublisher } from './PayloadPublisher.js';
import type { IncrementalDataRecord } from './types.js';

export function transformResult<TSubsequent, TIncremental>(
  args: ExecutionArgs,
  payloadPublisher: PayloadPublisher<TSubsequent, TIncremental>,
  prefix = '__transformResult__',
): PromiseOrValue<ExecutionResult | TIncremental> {
  const originalArgs = validateExecutionArgs(args);

  if (!('schema' in originalArgs)) {
    return { errors: originalArgs };
  }

  const context = buildTransformationContext(originalArgs, prefix);

  const originalResult = experimentalExecuteQueryOrMutationOrSubscriptionEvent(
    context.transformedArgs,
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
): ExecutionResult | TIncremental {
  if ('initialResult' in result) {
    const { initialResult, subsequentResults } = result;
    const { data, errors, pending } = initialResult;

    embedErrors(data, errors);

    return buildIncrementalResponse(
      data,
      completeInitialResult(context, data),
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
    incrementalDataRecords,
    payloadPublisher.getSubsequentPayloadPublisher(),
    pending,
    subsequentResults,
  );

  return payloadPublisher.getPayloads(
    data,
    errors,
    incrementalPublisher.subscribe(),
  );
}

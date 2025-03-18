import type {
  ExecutionResult,
  ExperimentalIncrementalExecutionResults,
  GraphQLError,
} from 'graphql';
import type {
  PendingResult,
  SubsequentIncrementalExecutionResult,
  // eslint-disable-next-line n/no-missing-import
} from 'graphql/execution/types.js';

import type { ObjMap } from '../jsutils/ObjMap.js';

import type { TransformationContext } from './buildTransformationContext.js';
import { completeInitialResult } from './completeValue.js';
import { embedErrors } from './embedErrors.js';
import { IncrementalPublisher } from './IncrementalPublisher.js';
import type {
  LegacyExperimentalIncrementalExecutionResults,
  LegacySubsequentIncrementalExecutionResult,
  PayloadPublisher,
} from './PayloadPublisher.js';
import type { IncrementalDataRecord } from './types.js';

export function transformResult(
  context: TransformationContext,
  result: ExecutionResult | ExperimentalIncrementalExecutionResults,
  payloadPublisher: PayloadPublisher<
    LegacySubsequentIncrementalExecutionResult,
    LegacyExperimentalIncrementalExecutionResults
  >,
): ExecutionResult | LegacyExperimentalIncrementalExecutionResults {
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

function buildIncrementalResponse(
  originalData: ObjMap<unknown>,
  initialResult: {
    data: ObjMap<unknown>;
    errors: ReadonlyArray<GraphQLError>;
    incrementalDataRecords: ReadonlyArray<IncrementalDataRecord>;
  },
  payloadPublisher: PayloadPublisher<
    LegacySubsequentIncrementalExecutionResult,
    LegacyExperimentalIncrementalExecutionResults
  >,
  pending?: ReadonlyArray<PendingResult>,
  subsequentResults?: AsyncGenerator<SubsequentIncrementalExecutionResult>,
): LegacyExperimentalIncrementalExecutionResults {
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

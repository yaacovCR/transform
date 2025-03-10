import type {
  ExecutionResult,
  ExperimentalIncrementalExecutionResults,
} from 'graphql';

import type { TransformationContext } from './buildTransformationContext.js';
import { completeInitialResult } from './completeValue.js';
import { embedErrors } from './embedErrors.js';
import { IncrementalPublisher } from './IncrementalPublisher.js';
import type { LegacyExperimentalIncrementalExecutionResults } from './PayloadPublisher.js';

export function transformResult(
  context: TransformationContext,
  result: ExecutionResult | ExperimentalIncrementalExecutionResults,
): ExecutionResult | LegacyExperimentalIncrementalExecutionResults {
  if ('initialResult' in result) {
    const { initialResult, subsequentResults } = result;
    const { data, errors, pending } = initialResult;

    embedErrors(data, errors);
    const completed = completeInitialResult(context, data);

    const incrementalPublisher = new IncrementalPublisher(data);
    return incrementalPublisher.buildResponse(
      completed,
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

  const incrementalPublisher = new IncrementalPublisher(originalData);
  return incrementalPublisher.buildResponse(completed);
}

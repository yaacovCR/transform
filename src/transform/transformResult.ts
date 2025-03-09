import type {
  ExecutionResult,
  ExperimentalIncrementalExecutionResults,
} from 'graphql';

import type { TransformationContext } from './buildTransformationContext.js';
import { IncrementalPublisher } from './IncrementalPublisher.js';
import type { LegacyExperimentalIncrementalExecutionResults } from './PayloadPublisher.js';

export function transformResult(
  context: TransformationContext,
  result: ExecutionResult | ExperimentalIncrementalExecutionResults,
): ExecutionResult | LegacyExperimentalIncrementalExecutionResults {
  const incrementalPublisher = new IncrementalPublisher(context);
  return incrementalPublisher.buildResponse(result);
}

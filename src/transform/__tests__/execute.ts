import type {
  ExecutionArgs,
  ExecutionResult,
  ExperimentalIncrementalExecutionResults,
} from 'graphql';

import { isPromise } from '../../jsutils/isPromise.js';
import type { PromiseOrValue } from '../../jsutils/PromiseOrValue.js';

import { transformResult } from '../transformResult.js';

export function executeSync(args: ExecutionArgs): ExecutionResult {
  const result = transformResult(args);

  // Assert that the execution was synchronous.
  if (isPromise(result) || 'initialResult' in result) {
    throw new Error('GraphQL execution failed to complete synchronously.');
  }

  return result;
}

export function execute(
  args: ExecutionArgs,
): PromiseOrValue<ExecutionResult | ExperimentalIncrementalExecutionResults> {
  return transformResult(args);
}

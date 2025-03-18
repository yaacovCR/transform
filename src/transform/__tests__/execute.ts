import type { ExecutionArgs, ExecutionResult } from 'graphql';

import { isPromise } from '../../jsutils/isPromise.js';
import type { PromiseOrValue } from '../../jsutils/PromiseOrValue.js';

import type { LegacyExperimentalIncrementalExecutionResults } from '../legacyExecuteIncrementally.js';
import { legacyExecuteIncrementally } from '../legacyExecuteIncrementally.js';

export function executeSync(args: ExecutionArgs): ExecutionResult {
  const result = legacyExecuteIncrementally(args);

  // Assert that the execution was synchronous.
  if (isPromise(result) || 'initialResult' in result) {
    throw new Error('GraphQL execution failed to complete synchronously.');
  }

  return result;
}

export function execute(
  args: ExecutionArgs,
): PromiseOrValue<
  ExecutionResult | LegacyExperimentalIncrementalExecutionResults
> {
  return legacyExecuteIncrementally(args);
}

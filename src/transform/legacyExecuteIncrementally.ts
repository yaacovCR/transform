import type { ExecutionArgs, ExecutionResult } from 'graphql';
import { experimentalExecuteQueryOrMutationOrSubscriptionEvent } from 'graphql';
// eslint-disable-next-line n/no-missing-import
import { validateExecutionArgs } from 'graphql/execution/execute.js';

import { isPromise } from '../jsutils/isPromise.js';
import type { PromiseOrValue } from '../jsutils/PromiseOrValue.js';

import { buildTransformationContext } from './buildTransformationContext.js';
import type { LegacyExperimentalIncrementalExecutionResults } from './transformResult.js';
import { transformResult } from './transformResult.js';

export function legacyExecuteIncrementally(
  args: ExecutionArgs,
  prefix = '__legacyExecuteIncrementally__',
): PromiseOrValue<
  ExecutionResult | LegacyExperimentalIncrementalExecutionResults
> {
  const originalArgs = validateExecutionArgs(args);

  if (!('schema' in originalArgs)) {
    return { errors: originalArgs };
  }

  const context = buildTransformationContext(originalArgs, prefix);

  const originalResult = experimentalExecuteQueryOrMutationOrSubscriptionEvent(
    context.transformedArgs,
  );

  return isPromise(originalResult)
    ? originalResult.then((resolved) => transformResult(context, resolved))
    : transformResult(context, originalResult);
}

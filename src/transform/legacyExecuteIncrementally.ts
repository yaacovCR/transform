import type { ExecutionResult } from 'graphql';

import type { PromiseOrValue } from '../jsutils/PromiseOrValue.js';

import type { LegacyExperimentalIncrementalExecutionResults } from './getLegacyPayloadPublisher.js';
import type { TransformArgs } from './transform.js';
import { transform } from './transform.js';

export function legacyExecuteIncrementally(
  args: TransformArgs,
): PromiseOrValue<
  ExecutionResult | LegacyExperimentalIncrementalExecutionResults
> {
  return transform({
    ...args,
    useLegacyIncremental: true,
  });
}

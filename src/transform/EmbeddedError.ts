import type { GraphQLError } from 'graphql';

/**
 * @internal
 */
export class EmbeddedErrors {
  errors: Array<GraphQLError>;

  constructor(errors: ReadonlyArray<GraphQLError>) {
    this.errors = errors.slice();
  }
}

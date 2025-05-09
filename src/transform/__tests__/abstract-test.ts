import { expect } from 'chai';
import {
  assertInterfaceType,
  buildSchema,
  GraphQLBoolean,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  GraphQLUnionType,
  parse,
} from 'graphql';
import { describe, it } from 'mocha';

import { expectJSON } from '../../__testUtils__/expectJSON.js';

import { execute, executeSync } from './execute.js';

interface Context {
  async: boolean;
}

async function executeQuery(args: {
  schema: GraphQLSchema;
  query: string;
  rootValue?: unknown;
}) {
  const { schema, query, rootValue } = args;
  const document = parse(query);
  const result = executeSync({
    schema,
    document,
    rootValue,
    contextValue: { async: false } satisfies Context,
  });
  const asyncResult = await execute({
    schema,
    document,
    rootValue,
    contextValue: { async: true } satisfies Context,
  });

  expectJSON(result).toDeepEqual(asyncResult);
  return result;
}

class Dog {
  name: string;
  woofs: boolean;

  constructor(name: string, woofs: boolean) {
    this.name = name;
    this.woofs = woofs;
  }
}

class Cat {
  name: string;
  meows: boolean;

  constructor(name: string, meows: boolean) {
    this.name = name;
    this.meows = meows;
  }
}

describe('Execute: Handles execution of abstract types', () => {
  it('isTypeOf used to resolve runtime type for Interface', async () => {
    const PetType = new GraphQLInterfaceType({
      name: 'Pet',
      fields: {
        name: { type: GraphQLString },
      },
    });

    const DogType = new GraphQLObjectType<Dog, { async: boolean }>({
      name: 'Dog',
      interfaces: [PetType],
      isTypeOf(obj, context) {
        const isDog = obj instanceof Dog;
        return context.async ? Promise.resolve(isDog) : isDog;
      },
      fields: {
        name: { type: GraphQLString },
        woofs: { type: GraphQLBoolean },
      },
    });

    const CatType = new GraphQLObjectType<Cat, { async: boolean }>({
      name: 'Cat',
      interfaces: [PetType],
      isTypeOf(obj, context) {
        const isCat = obj instanceof Cat;
        return context.async ? Promise.resolve(isCat) : isCat;
      },
      fields: {
        name: { type: GraphQLString },
        meows: { type: GraphQLBoolean },
      },
    });

    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          pets: {
            type: new GraphQLList(PetType),
            resolve() {
              return [new Dog('Odie', true), new Cat('Garfield', false)];
            },
          },
        },
      }),
      types: [CatType, DogType],
    });

    const query = `
      {
        pets {
          name
          ... on Dog {
            woofs
          }
          ... on Cat {
            meows
          }
        }
      }
    `;

    expect(await executeQuery({ schema, query })).to.deep.equal({
      data: {
        pets: [
          {
            name: 'Odie',
            woofs: true,
          },
          {
            name: 'Garfield',
            meows: false,
          },
        ],
      },
    });
  });

  it('isTypeOf can throw', async () => {
    const PetType = new GraphQLInterfaceType({
      name: 'Pet',
      fields: {
        name: { type: GraphQLString },
      },
    });

    const DogType = new GraphQLObjectType<Dog, Context>({
      name: 'Dog',
      interfaces: [PetType],
      isTypeOf(_source, context) {
        const error = new Error('We are testing this error');
        if (context.async) {
          return Promise.reject(error);
        }
        throw error;
      },
      fields: {
        name: { type: GraphQLString },
        woofs: { type: GraphQLBoolean },
      },
    });

    const CatType = new GraphQLObjectType<Cat, Context>({
      name: 'Cat',
      interfaces: [PetType],
      isTypeOf: undefined,
      fields: {
        name: { type: GraphQLString },
        meows: { type: GraphQLBoolean },
      },
    });

    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          pets: {
            type: new GraphQLList(PetType),
            resolve() {
              return [new Dog('Odie', true), new Cat('Garfield', false)];
            },
          },
        },
      }),
      types: [DogType, CatType],
    });

    const query = `
      {
        pets {
          name
          ... on Dog {
            woofs
          }
          ... on Cat {
            meows
          }
        }
      }
    `;

    expectJSON(await executeQuery({ schema, query })).toDeepEqual({
      data: {
        pets: [null, null],
      },
      errors: [
        {
          message: 'We are testing this error',
          locations: [{ line: 3, column: 9 }],
          path: ['pets', 0],
        },
        {
          message: 'We are testing this error',
          locations: [{ line: 3, column: 9 }],
          path: ['pets', 1],
        },
      ],
    });
  });

  it('isTypeOf can return false', async () => {
    const PetType = new GraphQLInterfaceType({
      name: 'Pet',
      fields: {
        name: { type: GraphQLString },
      },
    });

    const DogType = new GraphQLObjectType<Dog, Context>({
      name: 'Dog',
      interfaces: [PetType],
      isTypeOf(_source, context) {
        return context.async ? Promise.resolve(false) : false;
      },
      fields: {
        name: { type: GraphQLString },
        woofs: { type: GraphQLBoolean },
      },
    });

    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          pet: {
            type: PetType,
            resolve: () => ({}),
          },
        },
      }),
      types: [DogType],
    });

    const query = `
      {
        pet {
          name
        }
      }
    `;

    expectJSON(await executeQuery({ schema, query })).toDeepEqual({
      data: { pet: null },
      errors: [
        {
          message:
            'Abstract type "Pet" must resolve to an Object type at runtime for field "Query.pet". Either the "Pet" type should provide a "resolveType" function or each possible type should provide an "isTypeOf" function.',
          locations: [{ line: 3, column: 9 }],
          path: ['pet'],
        },
      ],
    });
  });

  it('isTypeOf used to resolve runtime type for Union', async () => {
    const DogType = new GraphQLObjectType<Dog, Context>({
      name: 'Dog',
      isTypeOf(obj, context) {
        const isDog = obj instanceof Dog;
        return context.async ? Promise.resolve(isDog) : isDog;
      },
      fields: {
        name: { type: GraphQLString },
        woofs: { type: GraphQLBoolean },
      },
    });

    const CatType = new GraphQLObjectType<Cat, Context>({
      name: 'Cat',
      isTypeOf(obj, context) {
        const isCat = obj instanceof Cat;
        return context.async ? Promise.resolve(isCat) : isCat;
      },
      fields: {
        name: { type: GraphQLString },
        meows: { type: GraphQLBoolean },
      },
    });

    const PetType = new GraphQLUnionType({
      name: 'Pet',
      types: [DogType, CatType],
    });

    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          pets: {
            type: new GraphQLList(PetType),
            resolve() {
              return [new Dog('Odie', true), new Cat('Garfield', false)];
            },
          },
        },
      }),
    });

    const query = `{
      pets {
        ... on Dog {
          name
          woofs
        }
        ... on Cat {
          name
          meows
        }
      }
    }`;

    expect(await executeQuery({ schema, query })).to.deep.equal({
      data: {
        pets: [
          {
            name: 'Odie',
            woofs: true,
          },
          {
            name: 'Garfield',
            meows: false,
          },
        ],
      },
    });
  });

  it('resolveType can throw', async () => {
    const PetType = new GraphQLInterfaceType<Dog | Cat, Context>({
      name: 'Pet',
      resolveType(_source, context) {
        const error = new Error('We are testing this error');
        if (context.async) {
          return Promise.reject(error);
        }
        throw error;
      },
      fields: {
        name: { type: GraphQLString },
      },
    });

    const DogType = new GraphQLObjectType<Dog, Context>({
      name: 'Dog',
      interfaces: [PetType],
      fields: {
        name: { type: GraphQLString },
        woofs: { type: GraphQLBoolean },
      },
    });

    const CatType = new GraphQLObjectType<Cat, Context>({
      name: 'Cat',
      interfaces: [PetType],
      fields: {
        name: { type: GraphQLString },
        meows: { type: GraphQLBoolean },
      },
    });

    const schema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          pets: {
            type: new GraphQLList(PetType),
            resolve() {
              return [new Dog('Odie', true), new Cat('Garfield', false)];
            },
          },
        },
      }),
      types: [CatType, DogType],
    });

    const query = `
      {
        pets {
          name
          ... on Dog {
            woofs
          }
          ... on Cat {
            meows
          }
        }
      }
    `;

    expectJSON(await executeQuery({ schema, query })).toDeepEqual({
      data: {
        pets: [null, null],
      },
      errors: [
        {
          message: 'We are testing this error',
          locations: [{ line: 3, column: 9 }],
          path: ['pets', 0],
        },
        {
          message: 'We are testing this error',
          locations: [{ line: 3, column: 9 }],
          path: ['pets', 1],
        },
      ],
    });
  });

  it('resolve Union type using __typename on source object', async () => {
    const schema = buildSchema(`
      type Query {
        pets: [Pet]
      }

      union Pet = Cat | Dog

      type Cat {
        name: String
        meows: Boolean
      }

      type Dog {
        name: String
        woofs: Boolean
      }
    `);

    // NOTE: This is an *invalid* query, but it should be an *executable* query.
    const query = `
      {
        pets {
          name
          ... on Dog {
            woofs
          }
          ... on Cat {
            meows
          }
        }
      }
    `;

    const rootValue = {
      pets: [
        {
          __typename: 'Dog',
          name: 'Odie',
          woofs: true,
        },
        {
          __typename: 'Cat',
          name: 'Garfield',
          meows: false,
        },
      ],
    };

    // invalid fields are dropped during transformation prior to forwarding,
    // ultimately resolving to null
    expect(await executeQuery({ schema, query, rootValue })).to.deep.equal({
      data: {
        pets: [
          {
            name: null,
            woofs: true,
          },
          {
            name: null,
            meows: false,
          },
        ],
      },
    });
  });

  it('resolve Interface type using __typename on source object', async () => {
    const schema = buildSchema(`
      type Query {
        pets: [Pet]
      }

      interface Pet {
        name: String
      }

      type Cat implements Pet {
        name: String
        meows: Boolean
      }

      type Dog implements Pet {
        name: String
        woofs: Boolean
      }
    `);

    const query = `
      {
        pets {
          name
          ... on Dog {
            woofs
          }
          ... on Cat {
            meows
          }
        }
      }
    `;

    const rootValue = {
      pets: [
        {
          __typename: 'Dog',
          name: 'Odie',
          woofs: true,
        },
        {
          __typename: 'Cat',
          name: 'Garfield',
          meows: false,
        },
      ],
    };

    expect(await executeQuery({ schema, query, rootValue })).to.deep.equal({
      data: {
        pets: [
          {
            name: 'Odie',
            woofs: true,
          },
          {
            name: 'Garfield',
            meows: false,
          },
        ],
      },
    });
  });

  it('resolveType on Interface yields useful error', () => {
    const schema = buildSchema(`
      type Query {
        pet: Pet
      }

      interface Pet {
        name: String
      }

      type Cat implements Pet {
        name: String
      }

      type Dog implements Pet {
        name: String
      }
    `);

    const document = parse(`
      {
        pet {
          name
        }
      }
    `);

    function expectError({ forTypeName }: { forTypeName: unknown }) {
      const rootValue = { pet: { __typename: forTypeName } };
      const result = executeSync({ schema, document, rootValue });
      return {
        toEqual(message: string) {
          expectJSON(result).toDeepEqual({
            data: { pet: null },
            errors: [
              {
                message,
                locations: [{ line: 3, column: 9 }],
                path: ['pet'],
              },
            ],
          });
        },
      };
    }

    expectError({ forTypeName: undefined }).toEqual(
      'Abstract type "Pet" must resolve to an Object type at runtime for field "Query.pet". Either the "Pet" type should provide a "resolveType" function or each possible type should provide an "isTypeOf" function.',
    );

    expectError({ forTypeName: 'Human' }).toEqual(
      'Abstract type "Pet" was resolved to a type "Human" that does not exist inside the schema.',
    );

    expectError({ forTypeName: 'String' }).toEqual(
      'Abstract type "Pet" was resolved to a non-object type "String".',
    );

    expectError({ forTypeName: '__Schema' }).toEqual(
      'Runtime Object type "__Schema" is not a possible type for "Pet".',
    );

    // FIXME: workaround since we can't inject resolveType into SDL
    // @ts-expect-error
    assertInterfaceType(schema.getType('Pet')).resolveType = () => [];
    expectError({ forTypeName: undefined }).toEqual(
      'Abstract type "Pet" must resolve to an Object type at runtime for field "Query.pet" with value { __typename: undefined }, received "[]", which is not a valid Object type name.',
    );
  });
});

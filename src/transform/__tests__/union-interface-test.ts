import { expect } from 'chai';
import {
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

class Dog {
  name: string;
  barks: boolean;
  mother?: Dog;
  father?: Dog;
  progeny: ReadonlyArray<Dog>;

  constructor(name: string, barks: boolean) {
    this.name = name;
    this.barks = barks;
    this.progeny = [];
  }
}

class Cat {
  name: string;
  meows: boolean;
  mother?: Cat;
  father?: Cat;
  progeny: ReadonlyArray<Cat>;

  constructor(name: string, meows: boolean) {
    this.name = name;
    this.meows = meows;
    this.progeny = [];
  }
}

class Plant {
  name: string;

  constructor(name: string) {
    this.name = name;
  }
}

class Person {
  name: string;
  pets: ReadonlyArray<Dog | Cat> | undefined;
  friends: ReadonlyArray<Dog | Cat | Person> | undefined;
  responsibilities: ReadonlyArray<Dog | Cat | Plant> | undefined;

  constructor(
    name: string,
    pets?: ReadonlyArray<Dog | Cat>,
    friends?: ReadonlyArray<Dog | Cat | Person>,
    responsibilities?: ReadonlyArray<Dog | Cat | Plant>,
  ) {
    this.name = name;
    this.pets = pets;
    this.friends = friends;
    this.responsibilities = responsibilities;
  }
}

const NamedType = new GraphQLInterfaceType({
  name: 'Named',
  fields: {
    name: { type: GraphQLString },
  },
});

const LifeType: GraphQLInterfaceType = new GraphQLInterfaceType({
  name: 'Life',
  fields: () => ({
    progeny: { type: new GraphQLList(LifeType) },
  }),
});

const MammalType: GraphQLInterfaceType = new GraphQLInterfaceType({
  name: 'Mammal',
  interfaces: [LifeType],
  fields: () => ({
    progeny: { type: new GraphQLList(MammalType) },
    mother: { type: MammalType },
    father: { type: MammalType },
  }),
});

const DogType: GraphQLObjectType = new GraphQLObjectType({
  name: 'Dog',
  interfaces: [MammalType, LifeType, NamedType],
  fields: () => ({
    name: { type: GraphQLString },
    barks: { type: GraphQLBoolean },
    progeny: { type: new GraphQLList(DogType) },
    mother: { type: DogType },
    father: { type: DogType },
  }),
  isTypeOf: (value) => value instanceof Dog,
});

const CatType: GraphQLObjectType = new GraphQLObjectType({
  name: 'Cat',
  interfaces: [MammalType, LifeType, NamedType],
  fields: () => ({
    name: { type: GraphQLString },
    meows: { type: GraphQLBoolean },
    progeny: { type: new GraphQLList(CatType) },
    mother: { type: CatType },
    father: { type: CatType },
  }),
  isTypeOf: (value) => value instanceof Cat,
});

const PlantType: GraphQLObjectType = new GraphQLObjectType({
  name: 'Plant',
  interfaces: [NamedType],
  fields: () => ({
    name: { type: GraphQLString },
  }),
  // eslint-disable-next-line @typescript-eslint/require-await
  isTypeOf: async () => {
    throw new Error('Not sure if this is a plant');
  },
});

const PetType = new GraphQLUnionType({
  name: 'Pet',
  types: [DogType, CatType],
  resolveType(value) {
    if (value instanceof Dog) {
      return DogType.name;
    }
    if (value instanceof Cat) {
      return CatType.name;
    }
    /* c8 ignore next 3 */
    // Not reachable, all possible types have been considered.
    expect.fail('Not reachable');
  },
});

const PetOrPlantType = new GraphQLUnionType({
  name: 'PetOrPlantType',
  types: [PlantType, DogType, CatType],
});

const PersonType: GraphQLObjectType = new GraphQLObjectType({
  name: 'Person',
  interfaces: [NamedType, MammalType, LifeType],
  fields: () => ({
    name: { type: GraphQLString },
    pets: { type: new GraphQLList(PetType) },
    friends: { type: new GraphQLList(NamedType) },
    responsibilities: { type: new GraphQLList(PetOrPlantType) },
    progeny: { type: new GraphQLList(PersonType) },
    mother: { type: PersonType },
    father: { type: PersonType },
  }),
  isTypeOf: (value) => value instanceof Person,
});

const schema = new GraphQLSchema({
  query: PersonType,
  types: [PetType],
});

const garfield = new Cat('Garfield', false);
garfield.mother = new Cat("Garfield's Mom", false);
garfield.mother.progeny = [garfield];

const odie = new Dog('Odie', true);
odie.mother = new Dog("Odie's Mom", true);
odie.mother.progeny = [odie];

const fern = new Plant('Fern');
const liz = new Person('Liz');
const john = new Person(
  'John',
  [garfield, odie],
  [liz, odie],
  [garfield, fern],
);

describe('Execute: Union and intersection types', () => {
  it('can introspect on union and intersection types', () => {
    const document = parse(`
      {
        Named: __type(name: "Named") {
          kind
          name
          fields { name }
          interfaces { name }
          possibleTypes { name }
          enumValues { name }
          inputFields { name }
        }
        Mammal: __type(name: "Mammal") {
          kind
          name
          fields { name }
          interfaces { name }
          possibleTypes { name }
          enumValues { name }
          inputFields { name }
        }
        Pet: __type(name: "Pet") {
          kind
          name
          fields { name }
          interfaces { name }
          possibleTypes { name }
          enumValues { name }
          inputFields { name }
        }
      }
    `);

    expect(executeSync({ schema, document })).to.deep.equal({
      data: {
        Named: {
          kind: 'INTERFACE',
          name: 'Named',
          fields: [{ name: 'name' }],
          interfaces: [],
          possibleTypes: [
            { name: 'Dog' },
            { name: 'Cat' },
            { name: 'Person' },
            { name: 'Plant' },
          ],
          enumValues: null,
          inputFields: null,
        },
        Mammal: {
          kind: 'INTERFACE',
          name: 'Mammal',
          fields: [{ name: 'progeny' }, { name: 'mother' }, { name: 'father' }],
          interfaces: [{ name: 'Life' }],
          possibleTypes: [{ name: 'Dog' }, { name: 'Cat' }, { name: 'Person' }],
          enumValues: null,
          inputFields: null,
        },
        Pet: {
          kind: 'UNION',
          name: 'Pet',
          fields: null,
          interfaces: null,
          possibleTypes: [{ name: 'Dog' }, { name: 'Cat' }],
          enumValues: null,
          inputFields: null,
        },
      },
    });
  });

  it('executes using union types', () => {
    // NOTE: This is an *invalid* query, but it should be an *executable* query.
    const document = parse(`
      {
        __typename
        name
        pets {
          __typename
          name
          barks
          meows
        }
      }
    `);

    // invalid fields are dropped during transformation prior to forwarding,
    // ultimately resolving to null
    expect(executeSync({ schema, document, rootValue: john })).to.deep.equal({
      data: {
        __typename: 'Person',
        name: 'John',
        pets: [
          {
            __typename: 'Cat',
            name: null,
            meows: null,
          },
          {
            __typename: 'Dog',
            name: null,
            barks: null,
          },
        ],
      },
    });
  });

  it('executes union types with inline fragments', () => {
    // This is the valid version of the query in the above test.
    const document = parse(`
      {
        __typename
        name
        pets {
          __typename
          ... on Dog {
            name
            barks
          }
          ... on Cat {
            name
            meows
          }
        }
      }
    `);

    expect(executeSync({ schema, document, rootValue: john })).to.deep.equal({
      data: {
        __typename: 'Person',
        name: 'John',
        pets: [
          {
            __typename: 'Cat',
            name: 'Garfield',
            meows: false,
          },
          {
            __typename: 'Dog',
            name: 'Odie',
            barks: true,
          },
        ],
      },
    });
  });

  it('executes using interface types', () => {
    // NOTE: This is an *invalid* query, but it should be an *executable* query.
    const document = parse(`
      {
        __typename
        name
        friends {
          __typename
          name
          barks
          meows
        }
      }
    `);

    // invalid fields are dropped during transformation prior to forwarding,
    // ultimately resolving to null
    expect(executeSync({ schema, document, rootValue: john })).to.deep.equal({
      data: {
        __typename: 'Person',
        name: 'John',
        friends: [
          { __typename: 'Person', name: 'Liz' },
          { __typename: 'Dog', name: 'Odie', barks: null },
        ],
      },
    });
  });

  it('executes interface types with inline fragments', () => {
    // This is the valid version of the query in the above test.
    const document = parse(`
      {
        __typename
        name
        friends {
          __typename
          name
          ... on Dog {
            barks
          }
          ... on Cat {
            meows
          }

          ... on Mammal {
            mother {
              __typename
              ... on Dog {
                name
                barks
              }
              ... on Cat {
                name
                meows
              }
            }
          }
        }
      }
    `);

    expect(executeSync({ schema, document, rootValue: john })).to.deep.equal({
      data: {
        __typename: 'Person',
        name: 'John',
        friends: [
          {
            __typename: 'Person',
            name: 'Liz',
            mother: null,
          },
          {
            __typename: 'Dog',
            name: 'Odie',
            barks: true,
            mother: { __typename: 'Dog', name: "Odie's Mom", barks: true },
          },
        ],
      },
    });
  });

  it('executes interface types with named fragments', () => {
    const document = parse(`
      {
        __typename
        name
        friends {
          __typename
          name
          ...DogBarks
          ...CatMeows
        }
      }

      fragment  DogBarks on Dog {
        barks
      }

      fragment  CatMeows on Cat {
        meows
      }
    `);

    expect(executeSync({ schema, document, rootValue: john })).to.deep.equal({
      data: {
        __typename: 'Person',
        name: 'John',
        friends: [
          {
            __typename: 'Person',
            name: 'Liz',
          },
          {
            __typename: 'Dog',
            name: 'Odie',
            barks: true,
          },
        ],
      },
    });
  });

  it('allows fragment conditions to be abstract types', () => {
    const document = parse(`
      {
        __typename
        name
        pets {
          ...PetFields,
          ...on Mammal {
            mother {
              ...ProgenyFields
            }
          }
        }
        friends { ...FriendFields }
      }

      fragment PetFields on Pet {
        __typename
        ... on Dog {
          name
          barks
        }
        ... on Cat {
          name
          meows
        }
      }

      fragment FriendFields on Named {
        __typename
        name
        ... on Dog {
          barks
        }
        ... on Cat {
          meows
        }
      }

      fragment ProgenyFields on Life {
        progeny {
          __typename
        }
      }
    `);

    expect(executeSync({ schema, document, rootValue: john })).to.deep.equal({
      data: {
        __typename: 'Person',
        name: 'John',
        pets: [
          {
            __typename: 'Cat',
            name: 'Garfield',
            meows: false,
            mother: { progeny: [{ __typename: 'Cat' }] },
          },
          {
            __typename: 'Dog',
            name: 'Odie',
            barks: true,
            mother: { progeny: [{ __typename: 'Dog' }] },
          },
        ],
        friends: [
          {
            __typename: 'Person',
            name: 'Liz',
          },
          {
            __typename: 'Dog',
            name: 'Odie',
            barks: true,
          },
        ],
      },
    });
  });

  it('gets execution info in resolver', () => {
    let encounteredContext;
    let encounteredSchema;
    let encounteredRootValue;

    const NamedType2: GraphQLInterfaceType = new GraphQLInterfaceType({
      name: 'Named',
      fields: {
        name: { type: GraphQLString },
      },
      resolveType(_source, context, info) {
        encounteredContext = context;
        encounteredSchema = info.schema;
        encounteredRootValue = info.rootValue;
        return PersonType2.name;
      },
    });

    const PersonType2: GraphQLObjectType = new GraphQLObjectType({
      name: 'Person',
      interfaces: [NamedType2],
      fields: {
        name: { type: GraphQLString },
        friends: { type: new GraphQLList(NamedType2) },
      },
    });
    const schema2 = new GraphQLSchema({ query: PersonType2 });
    const document = parse('{ name, friends { name } }');
    const rootValue = new Person('John', [], [liz]);
    const contextValue = { authToken: '123abc' };

    const result = executeSync({
      schema: schema2,
      document,
      rootValue,
      contextValue,
    });
    expect(result).to.deep.equal({
      data: {
        name: 'John',
        friends: [{ name: 'Liz' }],
      },
    });

    expect(encounteredSchema).to.equal(schema2);
    expect(encounteredRootValue).to.equal(rootValue);
    expect(encounteredContext).to.equal(contextValue);
  });

  it('it handles rejections from isTypeOf after after an isTypeOf returns true', async () => {
    const document = parse(`
      {
        responsibilities {
          __typename
          ... on Dog {
            name
            barks
          }
          ... on Cat {
            name
            meows
          }
        }
      }
    `);

    const rootValue = new Person('John', [], [liz], [garfield]);
    const contextValue = { authToken: '123abc' };

    /* c8 ignore next 4 */
    // eslint-disable-next-line no-undef
    process.on('unhandledRejection', () => {
      expect.fail('Unhandled rejection');
    });

    const result = await execute({
      schema,
      document,
      rootValue,
      contextValue,
    });

    expectJSON(result).toDeepEqual({
      data: {
        responsibilities: [
          {
            __typename: 'Cat',
            meows: false,
            name: 'Garfield',
          },
        ],
      },
    });
  });
});

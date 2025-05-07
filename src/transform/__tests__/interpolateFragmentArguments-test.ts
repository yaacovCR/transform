import { expect } from 'chai';
import { parse, print } from 'graphql';
import { describe, it } from 'mocha';

import { dedentString } from '../../__testUtils__/dedent.js';

import { interpolateFragmentArguments } from '../interpolateFragmentArguments.js';

function testInterpolation(source: string, expected: string): void {
  const originalDocument = parse(source, {
    experimentalFragmentArguments: true,
  });
  const transformedDocument = interpolateFragmentArguments(originalDocument);
  expect(print(transformedDocument)).to.equal(dedentString(expected));
}

describe('interpolateFragmentArguments', () => {
  it('should interpolate arguments', () => {
    testInterpolation(
      `
        query TestQuery {
          ...MyFragment(fragVar: "hello")
        }
        
        fragment MyFragment($fragVar: String) on Query {
          field(arg1: $fragVar)
        }
      `,
      `
        query TestQuery {
          ...MyFragment_interpolated_0
        }
        
        fragment MyFragment_interpolated_0 on Query {
          field(arg1: "hello")
        }
      `,
    );
  });

  it('should use default value if argument not provided for an explicitly called fragment', () => {
    testInterpolation(
      `
        query TestQuery {
          ...MyFragment(fragVar1: "specific")
        }
        
        fragment MyFragment($fragVar1: String, $fragVar2: String = "defaultVal") on Query {
          field(arg1: $fragVar1, arg2: $fragVar2)
        }
      `,
      `
        query TestQuery {
          ...MyFragment_interpolated_0
        }
        
        fragment MyFragment_interpolated_0 on Query {
          field(arg1: "specific", arg2: "defaultVal")
        }
      `,
    );
  });

  it('should not use default value if explicit null provided', () => {
    testInterpolation(
      `
        query TestQuery {
          ...MyFragment(fragVar1: "specific", fragVar2: null)
        }
        
        fragment MyFragment($fragVar1: String, $fragVar2: String = "defaultVal") on Query {
          field(arg1: $fragVar1, arg2: $fragVar2)
        }
      `,
      `
        query TestQuery {
          ...MyFragment_interpolated_0
        }
        
        fragment MyFragment_interpolated_0 on Query {
          field(arg1: "specific", arg2: null)
        }
      `,
    );
  });

  it('should generate unique names for multiple interpolations of the same fragment', () => {
    testInterpolation(
      `
        query TestQuery {
          ...MyFragment(fragVar: "val1")
          ...MyFragment(fragVar: "val2")
          ...MyFragment(fragVar: "val1")
        }
        
        fragment MyFragment($fragVar: String) on Query {
          field(arg: $fragVar)
        }
      `,
      `
        query TestQuery {
          ...MyFragment_interpolated_0
          ...MyFragment_interpolated_1
          ...MyFragment_interpolated_0
        }
        
        fragment MyFragment_interpolated_0 on Query {
          field(arg: "val1")
        }
        
        fragment MyFragment_interpolated_1 on Query {
          field(arg: "val2")
        }
      `,
    );
  });

  it('should preserve operation-level variables used in arguments', () => {
    testInterpolation(
      `
        query TestQuery($opVar: String) {
          ...MyFragment(fragVar: $opVar)
        }
        
        fragment MyFragment($fragVar: String) on Query {
          field(arg: $fragVar)
        }
      `,
      `
        query TestQuery($opVar: String) {
          ...MyFragment_interpolated_0
        }
        
        fragment MyFragment_interpolated_0 on Query {
          field(arg: $opVar)
        }
      `,
    );
  });

  it('should interpolate a new missing operation variable for missing fragment variables (without defaults)', () => {
    testInterpolation(
      `
        query TestQuery($varWithoutDefault: String) {
          ...MyFragment(varWithArg: "supplied")
        }
        
        fragment MyFragment($varWithArg: String, $varWithoutDefault: String) on Query {
          field1(arg: $varWithArg)
          field2(arg: $varWithoutDefault)
        }
      `,
      `
        query TestQuery($varWithoutDefault: String, $missing_fragment_variable_varWithoutDefault_0: String) {
          ...MyFragment_interpolated_0
        }
        
        fragment MyFragment_interpolated_0 on Query {
          field1(arg: "supplied")
          field2(arg: $missing_fragment_variable_varWithoutDefault_0)
        }
      `,
    );
  });

  it('should interpolate a new missing operation variable for nested missing fragment variables (without defaults)', () => {
    testInterpolation(
      `
        query TestQuery {
          ...Outer
        }
        
        fragment Outer($varWithoutDefault: String) on Query {
          ...Inner
        }
        
        fragment Inner($varWithoutDefault: String) on Query {
          field(arg: $varWithoutDefault)
        }
      `,
      `
        query TestQuery($missing_fragment_variable_varWithoutDefault_1: String) {
          ...Outer_interpolated_0
        }
        
        fragment Inner_interpolated_0 on Query {
          field(arg: $missing_fragment_variable_varWithoutDefault_1)
        }

        fragment Outer_interpolated_0 on Query {
          ...Inner_interpolated_0
        }
      `,
    );
  });

  it('should use default for fragment vars even if there is an operation var with the same name', () => {
    testInterpolation(
      `
        query TestQuery($varWithDefaultOnFragment: String) {
          ...MyFragment(varWithArg: "supplied")
        }
        
        fragment MyFragment($varWithArg: String, $varWithDefaultOnFragment: String = "default") on Query {
          field1(arg: $varWithArg)
          field2(arg: $varWithDefaultOnFragment)
        }
      `,
      `
        query TestQuery($varWithDefaultOnFragment: String) {
          ...MyFragment_interpolated_0
        }
        
        fragment MyFragment_interpolated_0 on Query {
          field1(arg: "supplied")
          field2(arg: "default")
        }
      `,
    );
  });

  it('should correctly handle nested fragments with arguments', () => {
    testInterpolation(
      `
        query TestQuery($opVar: String) {
          ...OuterFragment(outerVar: "outerValue")
        }
        
        fragment InnerFragment($innerVar: String) on Query {
          innerField(arg: $innerVar)
        }
        
        fragment OuterFragment($outerVar: String) on Query {
          outerField(arg: $outerVar)
          ...InnerFragment(innerVar: $outerVar)
        }
      `,
      `
        query TestQuery($opVar: String) {
          ...OuterFragment_interpolated_0
        }
        
        fragment InnerFragment_interpolated_0 on Query {
          innerField(arg: "outerValue")
        }
        
        fragment OuterFragment_interpolated_0 on Query {
          outerField(arg: "outerValue")
          ...InnerFragment_interpolated_0
        }
      `,
    );
  });

  it('should handle fragment spreads with arguments that are lists or objects', () => {
    testInterpolation(
      `
        query TestQuery {
          ...MyFragment(listArg: [1, 2], objArg: {a: "val", b: 3})
        }
        
        fragment MyFragment($listArg: [Int], $objArg: MyInput) on Query {
          field(l: $listArg, o: $objArg)
        }
      `,
      `
        query TestQuery {
          ...MyFragment_interpolated_0
        }
        
        fragment MyFragment_interpolated_0 on Query {
          field(l: [1, 2], o: { a: "val", b: 3 })
        }
      `,
    );
  });

  it('should handle nested fragment spreads with arguments that are lists or objects, some of which are not provided', () => {
    testInterpolation(
      `
        query Q($opValue: String = "op") {
          ...a
        }
        
        fragment a($aValue: String, $bValue: String) on TestType {
          ...b(aValue: { a: $aValue, b: "B" }, bValue: [$bValue, $opValue])
        }
        
        fragment b($aValue: MyInput, $bValue: [String], $cValue: String) on TestType {
          aList: list(input: $aValue)
          bList: list(input: $bValue)
          cList: list(input: [$cValue])
        }
      `,
      `
        query Q($opValue: String = "op", $missing_fragment_variable_aValue_0: String, $missing_fragment_variable_bValue_0: String, $missing_fragment_variable_cValue_0: String) {
          ...a_interpolated_0
        }
        
        fragment b_interpolated_0 on TestType {
          aList: list(input: { a: $missing_fragment_variable_aValue_0, b: "B" })
          bList: list(input: [$missing_fragment_variable_bValue_0, $opValue])
          cList: list(input: [$missing_fragment_variable_cValue_0])
        }

        fragment a_interpolated_0 on TestType {
          ...b_interpolated_0
        }
      `,
    );
  });

  it('should terminate when hitting a fragment cycle', () => {
    testInterpolation(
      `
        {
          ...A(arg: "arg")
        }
        
        fragment A($arg: String) on Query {
          ...B(arg: $arg)
        }
        
        fragment B($arg: String) on Query {
          ...C(arg: $arg)
        }
        
        fragment C($arg: String) on Query {
          ...A
        }
      `,
      `
        {
          ...A_interpolated_0
        }

        fragment C_interpolated_0 on Query {
          ...A
        }
        
        fragment B_interpolated_0 on Query {
          ...C_interpolated_0
        }

        fragment A_interpolated_0 on Query {
          ...B_interpolated_0
        }
      `,
    );
  });

  it('should ignore unknown fragment arguments', () => {
    testInterpolation(
      `
        {
          ...MyFragment(knownArg: "known", unknownArg: "unknown")
        }
        
        fragment MyFragment($knownArg: String) on Query {
          field(arg: $knownArg)
        }
      `,
      `
        {
          ...MyFragment_interpolated_0
        }

        fragment MyFragment_interpolated_0 on Query {
          field(arg: "known")
        }
      `,
    );
  });

  it('should ignore unknown fragments', () => {
    testInterpolation(
      `
        {
          ...MyUnknownFragment(unknownArg: "unknown")
        }
      `,
      `
        {
          ...MyUnknownFragment
        }
      `,
    );
  });
});

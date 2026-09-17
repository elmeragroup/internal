import { createRuleTester } from "../shared/rule-tester.ts";
import { noChainedTypeAssertionsRule } from "./no-chained-type-assertions.ts";

const tester = createRuleTester();
const error = { messageId: "chained" };

tester.run("anti-slop/no-chained-type-assertions", noChainedTypeAssertionsRule, {
  valid: [
    "const value = input as string;",
    "const value = <string>input;",
    "const value = (input as string);",
    "const value = input as string | number;",
    "const value = { id: userId } as const;",
    "const value = { id: userId } as const as const;",
    "const value = { id: userId } satisfies Record<string, unknown>;",
  ],
  invalid: [
    { code: "const value = input as string as number;", errors: [error] },
    { code: "const value = <number>input as string;", errors: [error] },
    { code: "const value = (input as string) as number;", errors: [error] },
    { code: "const value = ((input as string)) as number;", errors: [error] },
    { code: "const value = input as const as number;", errors: [error] },
    { code: "const value = (input as unknown) as const as const;", errors: [error] },
    { code: "const value = <number>(input as string);", errors: [error] },
    { code: "const value = <string>(input as any);", errors: [error] },
    { code: "consume(input as string as number);", errors: [error] },
    {
      code: "const first = input as string as number; const second = other as string as number;",
      errors: [error, error],
    },
  ],
});

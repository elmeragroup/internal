import { ruleTester } from "../shared/rule-tester.ts";
import { noClassAssertions } from "./no-class-assertions.ts";

/** A class list spread into itself down a chain: `a${depth}` spreads the one before it twice. */
function doubledClassList(depth: number): string {
  return [
    "const a0 = [...button.classList];",
    ...Array.from({ length: depth }, (_, index) => `const a${index + 1} = [...a${index}, ...a${index}];`),
    `expect(a${depth}).toContain("h-9");`,
  ].join("\n");
}

/** An expected class list shared down a chain: `e${depth}` lists the one before it twice. */
function sharedExpected(depth: number): string {
  return [
    'render(<Button className="h-9" />);',
    'const e0 = ["h-9"];',
    ...Array.from({ length: depth }, (_, index) => `const e${index + 1} = [e${index}, e${index}];`),
    `expect(button).toHaveClass(e${depth});`,
  ].join("\n");
}

ruleTester.run("no-class-assertions", noClassAssertions, {
  valid: [
    // Reviewer repro: a class the test supplies through a callback parameter is the class it asserts.
    'it.each(["marker"])("forwards", (cls) => {\n  render(<Button className={cls} />);\n  expect(button).toHaveClass(cls);\n});',
    // An expectation the evaluator cannot resolve (a parameter, a loop binding) pins nothing.
    "function check(cls) {\n  expect(button).toHaveClass(cls);\n}",
    "for (const cls of classes) expect(button).toHaveClass(cls);",
    // An expected list shared down 25 levels, every class supplied: past the budget, no pin.
    sharedExpected(25),
    sharedExpected(3),
    // Hang: a class read past the traversal's budget is unknown.
    doubledClassList(25),
    // `||` returns its truthy left operand, so the right operand is never asserted.
    'const supplied = "marker";\nrender(<Button className={supplied} />);\nexpect(button).toHaveClass(supplied || "h-9");',
    // A class the test supplies through an import is the same value the assertion names.
    'import { MARKER } from "./fixtures";\nit("x", () => {\n  render(<Button className={MARKER} />);\n  expect(button).toHaveClass(MARKER);\n});',
    'import * as fixtures from "./fixtures";\nit("x", () => {\n  render(<Button className={fixtures.classes.marker} />);\n  expect(button).toHaveClass(fixtures.classes.marker);\n});',
    // A recursive arrow const's own call is cut where it recurses, so the result is a call the
    // rule cross-checks, as without the memo.
    'render(<Button className="supplied" />);\nconst cls = (n) => (n ? cls(n - 1) : "supplied");\nexpect(button).toHaveClass(cls(2));',
    // A second read of the same call is cut the same way, though the first left the callee's value
    // in the file's memo.
    'render(<Button className="supplied" />);\nconst cls = (n) => (n ? cls(n - 1) : "supplied");\nexpect(button).toHaveClass(cls(2));\nexpect(button).toHaveClass(cls(2));',
    // `join` converts each element as JavaScript does.
    'render(<Button className={["marker", 1].join("-")} />);\nexpect(button).toHaveClass("marker-1");',
    // A template part is computed with JavaScript semantics.
    'render(<Button className={`marker-${1 + 2}`} />);\nexpect(button).toHaveClass("marker-3");',
    // A pattern and a string that both match supplied classes.
    'render(<Button className="marker" />);\nexpect(button).toHaveClass(flag ? /mark/ : "marker");',
    // A numeric template part converts as a template does.
    'render(<Button className="marker-1" />);\nexpect(button).toHaveClass(`marker-${1}`);',
    // The matcher's options object names no class.
    'render(<Button className="marker" />);\nexpect(button).toHaveClass("marker", { exact: true });',
    // A pattern that matches a supplied class.
    'render(<Button className="marker-x" />);\nexpect(button).toHaveClass(/marker-/);',
    // `concat` assembles statically.
    'render(<Button className="marker-x" />);\nexpect(button).toHaveClass("marker-".concat("x"));',
    // An unlisted string method resolves to no string, so the call counts as a cross-check.
    'expect(button).toHaveClass("h-9".padStart(4));',
    // A template the test supplies is assembled whole.
    'const id = "x";\nrender(<Button className={`marker-${id}`} />);\nexpect(button).toHaveClass("marker-x");',
    // A classList held in a binding is still the receiver.
    'render(<Button className="marker" />);\nconst list = button.classList;\nexpect(list.contains("marker")).toBe(true);',
    // A conditional or template class the test supplies matches itself.
    'render(<Button className={active ? "marker-a" : "marker-b"} />);\nexpect(button).toHaveClass(active ? "marker-a" : "marker-b");',
    'const id = "x";\nrender(<Button className={`marker-${id}`} />);\nexpect(button).toHaveClass(`marker-${id}`);',
    // Membership on the split class list asks about its argument, not `true`.
    'const marker = "m";\nrender(<Button className={marker} />);\nexpect(button.className.split(/\\s+/).includes(marker)).toBe(true);',
    // Hooks, tests and expect under a namespace import.
    'import * as vt from "vitest";\nvt.beforeEach(() => render(<Button className="marker" />));\nvt.it("forwards", () => {\n  vt.expect(button).toHaveClass("marker");\n});',
    // The consumer's class reaches the right part.
    'render(<TextareaField className="root-marker" />);\nexpect(root.classList.contains("root-marker")).toBe(true);',
    'render(<Select className="font-bold w-full" />);\nexpect(trigger()).toHaveClass("font-bold", "w-full");',
    // A part's own class prop supplies classes too.
    'render(<TextareaField textareaClassName="control-marker" />);\nexpect(area.classList.contains("control-marker")).toBe(true);',
    'render(<Link className={({ active }) => (active ? "is-active" : "")} />);\nexpect(link.classList.contains("is-active")).toBe(true);',
    'const props = { className: "logo" };\nrender(<BrandLogo {...props} />);\nexpect(img.className).toBe("logo");',
    'group.classList.add("compact");\nexpect(group.className.split(/\\s+/)).toContain("compact");',
    // A class the test supplies through a binding.
    'const marker = "consumer-marker";\nrender(<Button className={marker} />);\nexpect(button).toHaveClass(marker);',
    // A fixture the test calls supplies the class.
    'function renderMarked() {\n  render(<Button className="marker" />);\n}\nit("forwards", () => {\n  renderMarked();\n  expect(button()).toHaveClass("marker");\n});',
    // A component the test renders by its JSX tag is a fixture it reaches.
    'function InlineMenu() {\n  return <Viewport className="viewport-extra" />;\n}\nit("forwards", () => {\n  render(<InlineMenu />);\n  expect(viewport.classList.contains("viewport-extra")).toBe(true);\n});',
    // A setup hook of the test's suite supplies the class.
    'beforeEach(() => render(<Button className="marker" />));\nit("forwards", () => {\n  expect(button).toHaveClass("marker");\n});',
    'describe("menu", () => {\n  beforeEach(() => {\n    render(<Button className="marker" />);\n  });\n  it("forwards", () => {\n    expect(button).toHaveClass("marker");\n  });\n});',
    // A props object's property is the class it holds.
    'const props = { className: "marker" };\nrender(<Button {...props} />);\nexpect(button).toHaveClass(props.className);',
    'const classes = ["marker", "other"];\nrender(<Button className={classes[0]} />);\nexpect(button).toHaveClass(classes[0]);',
    // A cross-check against the recipe the part forwards.
    'expect(button.className).toBe(buttonVariants({ size: "sm" }));',
    // Data whose field is called className is not an element.
    'expect(coverage.filter((row) => row.className === "flex-1")).toEqual([]);',
    'expect(getComputedStyle(trigger).fontWeight).toBe("700");',
    // A class the test assigns itself, by `setAttribute` or `className`, is supplied.
    'it("a", () => {\n  el.setAttribute("class", "probe");\n  expect(el).toHaveClass("probe");\n});',
    'it("a", () => {\n  root.className = "existing";\n  apply(root);\n  expect(root).toHaveClass("existing");\n});',
  ],
  invalid: [
    // A parameter's class is not supplied by another parameter's.
    {
      code: 'it.each([["a", "b"]])("x", (supplied, asserted) => {\n  render(<Button className={supplied} />);\n  expect(button).toHaveClass(asserted, "h-9");\n});',
      errors: [{ messageId: "pinned", data: { token: "h-9" } }],
    },
    // An expected list that contains itself is cut there; its own class still pins.
    {
      code: 'const a = [a, "h-9"];\nexpect(button).toHaveClass(a);',
      errors: [{ messageId: "pinned", data: { token: "h-9" } }],
    },
    // A doubled class list within the budget still reads classes.
    { code: doubledClassList(3), errors: [{ messageId: "pinned" }] },
    // A class list copied by `Array.from` still reads classes.
    {
      code: 'expect(Array.from(button.classList)).toContain("h-9");',
      errors: [{ messageId: "pinned", data: { token: "h-9" } }],
    },
    // An imported class the test does not supply is still the component's own.
    {
      code: 'import { MARKER, OTHER } from "./fixtures";\nit("x", () => {\n  render(<Button className={OTHER} />);\n  expect(button).toHaveClass(MARKER);\n});',
      errors: [{ messageId: "pinned" }],
    },
    // Every membership an alternative asks about is checked.
    {
      code: 'render(<Button className="marker" />);\nconst list = button.classList;\nexpect(flag ? list.contains("marker") : list.contains("h-9")).toBe(true);',
      errors: [{ messageId: "pinned" }],
    },
    // An attribute name that may be "class" reads the classes.
    {
      code: 'expect(root.getAttribute(flag ? "id" : "class")).toBe("flex");',
      errors: [{ messageId: "pinned" }],
    },
    // `toHaveAttribute` with a name that may be "class".
    {
      code: 'expect(root).toHaveAttribute(flag ? "id" : "class", "flex");',
      errors: [{ messageId: "pinned" }],
    },
    // Each alternative is classified: the pattern pins.
    {
      code: 'render(<Button className="marker" />);\nexpect(button).toHaveClass(flag ? /h-9/ : "marker");',
      errors: [{ messageId: "pinned" }],
    },
    // `join` maps over its receiver's alternatives.
    {
      code: 'render(<Button className="a" />);\nexpect(button).toHaveClass((flag ? ["a"] : ["h", "9"]).join("-"));',
      errors: [{ messageId: "pinned" }],
    },
    // A reused body must have the class supplied at every registration.
    {
      code: 'const body = () => {\n  expect(button).toHaveClass("marker");\n};\ndescribe("a", () => {\n  beforeEach(() => render(<Button className="marker" />));\n  it("x", body);\n});\ndescribe("b", () => {\n  it("y", body);\n});',
      errors: [{ messageId: "pinned" }],
    },
    // A pattern that matches no supplied class pins the component's own.
    {
      code: 'render(<Button className="marker" />);\nexpect(button).toHaveClass(/h-\\d/);',
      errors: [{ messageId: "pinned", data: { token: "/h-\\d/" } }],
    },
    // `concat` of an unsupplied class still pins it.
    {
      code: 'expect(button).toHaveClass("h-".concat("9"));',
      errors: [{ messageId: "pinned", data: { token: "h-9" } }],
    },
    // The membership argument, not `true`, is the class.
    {
      code: 'const list = button.classList;\nexpect(list.contains("h-9")).toBe(true);',
      errors: [{ messageId: "pinned", data: { token: "h-9" } }],
    },
    // An aliased global expect.
    {
      code: 'const check = expect;\ncheck(spinner.classList.contains("animate-spin")).toBe(true);',
      errors: [{ messageId: "pinned", data: { token: "animate-spin" } }],
    },
    // Namespace expect is still an assertion, and an unsupplied class still pins.
    {
      code: 'import * as vt from "vitest";\nvt.it("pins", () => {\n  vt.expect(button).toHaveClass("h-9");\n});',
      errors: [{ messageId: "pinned", data: { token: "h-9" } }],
    },
    // A conditional with one arm the test never supplied.
    {
      code: 'render(<Button className={active ? "marker-a" : ""} />);\nexpect(button).toHaveClass(active ? "marker-a" : "h-9");',
      errors: [{ messageId: "pinned", data: { token: "h-9" } }],
    },
    // Membership on the split class list pins its argument.
    {
      code: 'expect(button.className.split(" ").includes("h-9")).toBe(true);',
      errors: [{ messageId: "pinned", data: { token: "h-9" } }],
    },
    {
      code: 'expect(spinner.classList.contains("animate-spin")).toBe(true);',
      errors: [{ messageId: "pinned" }],
    },
    { code: 'await expect.element(group).toHaveClass("is-open");', errors: [{ messageId: "pinned" }] },
    { code: 'expect(calendar().className).toContain("min-w-40");', errors: [{ messageId: "pinned" }] },
    { code: 'expect(root.getAttribute("class")).toBe("flex gap-2");', errors: [{ messageId: "pinned" }] },
    { code: 'expect(root).toHaveAttribute("class", "sr-only");', errors: [{ messageId: "pinned" }] },
    { code: 'expect([...root.classList]).toEqual(["grid"]);', errors: [{ messageId: "pinned" }] },
    // One supplied class does not excuse a pinned one beside it.
    {
      code: 'render(<Button className="mine" />);\nexpect(button()).toHaveClass("mine", "h-9");',
      errors: [{ messageId: "pinned", data: { token: "h-9" } }],
    },
    // An empty class string pins that the component adds none.
    { code: 'expect(root.className).toBe("");', errors: [{ messageId: "pinned" }] },
    {
      code: 'const SPIN = "animate-spin";\nexpect(icon).toHaveClass(SPIN);',
      errors: [{ messageId: "pinned" }],
    },
    // A class read held in a binding is still a class read.
    {
      code: 'const classes = button.className;\nexpect(classes).toContain("h-9");',
      errors: [{ messageId: "pinned" }],
    },
    {
      code: 'const { className } = button;\nexpect(className).toContain("h-9");',
      errors: [{ messageId: "pinned" }],
    },
    {
      code: 'const spins = icon.classList.contains("animate-spin");\nexpect(spins).toBe(true);',
      errors: [{ messageId: "pinned" }],
    },
    // An assertion in a helper outside any test counts only its own function's classes.
    {
      code: 'function check() {\n  expect(button()).toHaveClass("h-9");\n}\nit("supplies", () => render(<Button className="h-9" />));\nit("pins", () => {\n  render(<Button />);\n  check();\n});',
      errors: [{ messageId: "pinned", data: { token: "h-9" } }],
    },
    // A call that only reshapes a literal still pins it.
    {
      code: 'expect(button).toHaveClass("h-9".trim());',
      errors: [{ messageId: "pinned", data: { token: "h-9" } }],
    },
    {
      code: 'const own = () => "h-9";\nexpect(button).toHaveClass(own());',
      errors: [{ messageId: "pinned" }],
    },
    // An aliased expect still asserts.
    {
      code: 'import { expect as check } from "vitest";\ncheck(spinner.classList.contains("animate-spin")).toBe(true);',
      errors: [{ messageId: "pinned" }],
    },
    // Every value a poll callback returns is checked.
    {
      code: 'await expect.poll(() => (ready ? button.className : "")).toContain("h-9");',
      errors: [{ messageId: "pinned" }],
    },
    // A sibling suite's hook does not run before this test.
    {
      code: 'describe("a", () => {\n  beforeEach(() => render(<Button className="marker" />));\n});\ndescribe("b", () => {\n  it("pins", () => {\n    expect(button).toHaveClass("marker");\n  });\n});',
      errors: [{ messageId: "pinned" }],
    },
    // A class another test supplies does not excuse this one.
    {
      code: 'it("supplies", () => {\n  render(<Button className="h-9" />);\n});\nit("pins", () => {\n  expect(button()).toHaveClass("h-9");\n});',
      errors: [{ messageId: "pinned", data: { token: "h-9" } }],
    },
    // A lowercase tag renders an intrinsic element, never the same-named local it shadows.
    {
      code: 'const button = <Button className="rounded-md" />;\nit("pins", () => {\n  render(<button type="button">x</button>);\n  expect(document.body).toHaveClass("rounded-md");\n});',
      errors: [{ messageId: "pinned" }],
    },
  ],
});

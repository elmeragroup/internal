type Element = { readonly kind: "element" };

interface ButtonProps {
  isPending?: boolean;
}

declare function register<T>(render: T): T;

export const Button = register(
  ({ isPending = false }: ButtonProps): Element => ({
    kind: isPending ? "element" : "element",
  })
);

export function DirectButton({ isPending = false }: ButtonProps): Element {
  return { kind: isPending ? "element" : "element" };
}

type Nested = {
  p00: string;
  p01: string;
  p02: string;
  p03: string;
  p04: string;
  p05: string;
  p06: string;
  p07: string;
  p08: string;
  p09: string;
  p10: string;
  p11: string;
  p12: string;
  p13: string;
  p14: string;
  p15: string;
  p16: string;
  p17: string;
  p18: string;
  p19: string;
  p20: string;
  p21: string;
  p22: string;
  p23: string;
  p24: string;
  p25: string;
  p26: string;
  p27: string;
  p28: string;
  p29: string;
  p30: string;
  p31: string;
  p32: string;
  p33: string;
  p34: string;
  p35: string;
  p36: string;
  p37: string;
  p38: string;
  p39: string;
  p40: string;
  p41: string;
  p42: string;
  p43: string;
  p44: string;
  p45: string;
  p46: string;
  p47: string;
  p48: string;
  p49: string;
  p50: string;
};

export interface ResolutionOptions {
  nested: Nested;
  excluded: string;
}

export const options: ResolutionOptions = {
  nested: {} as Nested,
  excluded: "excluded",
};
export class ThatClass {
  private privateField01 = 1;
  private privateField02 = 2;
  private privateField03 = 3;
  private privateField04 = 4;
  private privateField05 = 5;
  private privateField06 = 6;
  private privateField07 = 7;
  private privateField08 = 8;
  private privateField09 = 9;
  private privateField10 = 10;
  private privateField11 = 11;
  private privateField12 = 12;
  private privateField13 = 13;
  private privateField14 = 14;
  private privateField15 = 15;
  private privateField16 = 16;
  private privateField17 = 17;
  private privateField18 = 18;
  private privateField19 = 19;
  private privateField20 = 20;
  private privateField21 = 21;
  private privateField22 = 22;
  private privateField23 = 23;
  private privateField24 = 24;
  private privateField25 = 25;
  private privateField26 = 26;
  private privateField27 = 27;
  private privateField28 = 28;
  private privateField29 = 29;
  private privateField30 = 30;
  private privateField31 = 31;
  private privateField32 = 32;
  private privateField33 = 33;
  private privateField34 = 34;
  private privateField35 = 35;
  private privateField36 = 36;
  private privateField37 = 37;
  private privateField38 = 38;
  private privateField39 = 39;
  private privateField40 = 40;
  private privateField41 = 41;
  private privateField42 = 42;
  private privateField43 = 43;
  private privateField44 = 44;
  private privateField45 = 45;
  private privateField46 = 46;
  private privateField47 = 47;
  private privateField48 = 48;
  private privateField49 = 49;
  private privateField50 = 50;
  private privateField51 = 51;
  protected protectedField = 52;
  static staticField = 53;
  public open = "open";
}

export type DirectAlias = ThatClass;

export interface PublicDerived extends ThatClass {
  own: string;
}

export type DerivedAlias = PublicDerived;

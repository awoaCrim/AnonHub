import type { Part } from "@yesimbot/contracts/parts";
import { partsFromElements } from "@yesimbot/contracts/parts";

/** An element as stored history writes it (`{ type, attrs, children }`), for building `Part`s in tests. */
export interface TestElement {
  readonly type: string;
  readonly attrs: Record<string, unknown>;
  readonly children: TestElement[];
}

/** Builds an element: `h("img", { src })`, children as the third argument. */
export function h(type: string, attrs: Record<string, unknown> = {}, children: TestElement[] = []): TestElement {
  return { type, attrs, children };
}

h.text = (content: string): TestElement => h("text", { content });

/** Parts of elements, keeping each source URL. */
export function parts(...elements: readonly TestElement[]): Part[] {
  return partsFromElements(elements, { sources: true });
}

/**
 * Test scaffold — intentionally buggy code for organic discovery tests.
 * The agent is asked to fix bugs and add features across multiple sessions.
 */

export interface Item {
  name: string;
  price: number;
  quantity: number;
}

export interface Config {
  timeout: number;
  retries: number;
  verbose: boolean;
}

/**
 * Calculate total cost of items.
 * BUG: Off-by-one — uses < length-1 instead of < length,
 * so the last item is always skipped.
 */
export function calculateTotal(items: Item[]): number {
  let total = 0;
  for (let i = 0; i < items.length - 1; i++) {
    total += items[i].price * items[i].quantity;
  }
  return total;
}

/**
 * Parse a config object.
 * MISSING: No input validation — accepts null, undefined, non-objects.
 */
export function parseConfig(input: unknown): Config {
  const obj = input as Record<string, unknown>;
  return {
    timeout: (obj.timeout as number) ?? 5000,
    retries: (obj.retries as number) ?? 3,
    verbose: (obj.verbose as boolean) ?? false,
  };
}

/**
 * Format a price for display.
 */
export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

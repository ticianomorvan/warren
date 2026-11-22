/**
 * Waits until `cond` holds, polling every `every` ms, and throws after `timeout` ms. Use it instead of
 * a fixed sleep: it returns as soon as the thing happened and fails loudly when it never does.
 */
export async function until(
  cond: () => boolean | Promise<boolean>,
  {
    timeout = 3000,
    every = 10,
    what = 'the condition',
  }: { timeout?: number; every?: number; what?: string } = {},
): Promise<void> {
  const end = Date.now() + timeout
  while (!(await cond())) {
    if (Date.now() > end) throw new Error(`timed out after ${timeout} ms waiting for ${what}`)
    await new Promise((r) => setTimeout(r, every))
  }
}

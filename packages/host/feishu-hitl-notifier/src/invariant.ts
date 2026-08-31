/** Package-owned invariant companion for the Feishu HITL notifier. */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-feishu-hitl-notifier'

/** Cordis companion plugin name. */
export const name = 'feishu-hitl-notifier-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: notification delivery is a non-authoritative external
 * side effect; the owning user-question service validates request entry and
 * the subprocess seam owns child-process lifecycle guarantees.
 */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

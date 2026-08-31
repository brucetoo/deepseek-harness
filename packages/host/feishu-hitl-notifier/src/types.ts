/** Public Remote boundary types for the Feishu HITL notifier. */

/** One Feishu user or group destination accepted by `feishu-cli msg send`. */
export interface Recipient {
  /** Identifier kind interpreted by Feishu. */
  type: 'open_id' | 'user_id' | 'chat_id' | 'email'
  /** Opaque destination identifier for the selected kind. */
  id: string
}

/** Privacy-safe outcome of one recipient connectivity test. */
export type RecipientTestStatus = 'sent' | 'busy' | 'not-configured' | 'delivery-failed'

/** Remote result with no delivery details or raw errors. */
export interface RecipientTestResult {
  status: RecipientTestStatus
}

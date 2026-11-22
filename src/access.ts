/** Normalized WhatsApp ids that get a reply; `*` means everyone, empty answers nobody. The one list WhatsApp and the MCP door answer by. */
export const isAllowed = (allowed: string[], waId: string) =>
  allowed.includes('*') || allowed.includes(waId)

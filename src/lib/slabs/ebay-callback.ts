// Maps the `?ebay=<result>` marker the OAuth callback appends to a user-facing
// toast. Pure + exhaustive so every callback outcome is surfaced (and tested).

export type EbayCallbackTone = "success" | "error" | "info";
export interface EbayCallbackMessage {
  tone: EbayCallbackTone;
  message: string;
}

export function ebayCallbackResultMessage(result: string): EbayCallbackMessage {
  switch (result) {
    case "connected":
      return { tone: "success", message: "eBay seller account connected." };
    case "denied":
      return { tone: "info", message: "eBay authorization was declined." };
    case "invalid_state":
      return { tone: "error", message: "That eBay authorization link expired or was already used — please connect again." };
    case "invalid_callback":
      return { tone: "error", message: "The eBay authorization response was incomplete — please try again." };
    case "config_error":
      return { tone: "error", message: "eBay is not fully configured for this deployment." };
    case "identity_scope_missing":
      return { tone: "error", message: "eBay did not grant the required Identity permission — reconnect and approve every requested permission." };
    case "identity_unavailable":
      return { tone: "error", message: "eBay did not return an account identifier — please try again." };
    case "persist_error":
      return { tone: "error", message: "The eBay connection could not be saved — please try again." };
    default:
      return { tone: "error", message: "eBay connection failed — please try again." };
  }
}

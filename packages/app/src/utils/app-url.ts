/** Hosted builds can present pairing offers at their own origin without changing the daemon. */
export function pairingAppUrl(
  offerUrl: string,
  baseUrl = process.env.EXPO_PUBLIC_PASEO_APP_BASE_URL,
): string {
  if (!baseUrl || !offerUrl) return offerUrl;
  const offer = new URL(offerUrl);
  const target = new URL(baseUrl);
  target.hash = offer.hash;
  return target.toString();
}

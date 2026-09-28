/** Ignore unrelated codes before either platform pauses its scanner. */
export function scannedPairingOffer(text: string): string | null {
  const raw = text.trim();
  return raw.includes("#offer=") ? raw : null;
}
